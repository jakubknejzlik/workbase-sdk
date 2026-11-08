import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import { mailOutbox as pluginmailOutbox } from '@workbasehq/plugins/mail-outbox'
import { pluginMigrationStatus } from '../../../core/src/kernel/migrations'
import { runtime, setup } from '@workbasehq/test-support/helpers'
import { identityWrite } from '../../../core/src/identity-writes'
import { createApp } from '../../../core/src/app'
import { request } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })
const registry = () => new KernelRegistry(sample)
const message = (id = 'mail-test') => ({ id, organizationId: null, recipient: 'recipient@example.test', subject: 'Caller subject', body: 'legacy-body', text: 'Caller text', html: '<p>Caller HTML</p>', expiresAt: new Date(Date.now() + 60000).toISOString() })
async function enqueue(kernel: KernelRegistry, id?: string) {
  await identityWrite(runtime(), kernel.config, 'queue_test', [kernel.mailOutbox.intent(message(id))])
}
it('exposes one explicit mail provider and rejects retained tables as a substitute', () => {
  expect(pluginmailOutbox().provides).toEqual({ 'mail-outbox': '1.x' })
  expect(() => new KernelRegistry({ ...sample, plugins: sample.plugins!.filter(p => p.name !== 'mail-outbox') }).mailOutbox).toThrow(/mail_outbox_required/)
})
it('keeps a durable pending intent without transport and exposes credential-free status', async () => {
  const kernel = registry(); await enqueue(kernel)
  await kernel.mailOutbox.deliver(runtime(), kernel.config, 'mail-test', async () => true)
  expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toEqual({ id: 'mail-test', delivery_status: 'pending', attempts: 0, sent_at: null, last_error: null })
})
it('retries provider failure using the exact caller payload and does not resend sent messages', async () => {
  const kernel = registry(); await enqueue(kernel)
  const send = vi.fn().mockRejectedValueOnce(new Error('secret provider payload')).mockResolvedValue({ messageId: 'ok' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
    await kernel.mailOutbox.deliver(settings, kernel.config, 'mail-test', async () => true)
    expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toMatchObject({ delivery_status: 'failed', attempts: 1, last_error: 'email_send_failed' })
    await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)
    await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toEqual({ from: 'noreply@example.test', to: 'recipient@example.test', subject: 'Caller subject', text: 'Caller text', html: '<p>Caller HTML</p>' })
    expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toMatchObject({ delivery_status: 'sent', attempts: 2, last_error: null })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret provider payload')
  } finally { log.mockRestore() }
})
it('revalidates caller eligibility and expiry before retrying credentials', async () => {
  const kernel = registry(); await enqueue(kernel)
  const send = vi.fn(async () => ({ messageId: 'ok' }))
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => false)
  await env.DB.prepare("UPDATE email_outbox SET expires_at='2000-01-01' WHERE id='mail-test'").run()
  await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)
  expect(send).not.toHaveBeenCalled()
  expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toMatchObject({ delivery_status: 'pending', attempts: 0 })
})
it('claims a delivery atomically across competing retries', async () => {
  const kernel = registry(); await enqueue(kernel)
  const send = vi.fn(async () => ({ messageId: 'ok' }))
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  await Promise.all([kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true), kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)])
  expect(send).toHaveBeenCalledTimes(1)
  expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toMatchObject({ delivery_status: 'sent', attempts: 1 })
})
it('keeps a slow provider call leased while an explicit retry returns without sending', async () => {
  const kernel = registry(); await enqueue(kernel)
  await env.DB.prepare('UPDATE email_outbox SET expires_at=? WHERE id=?').bind(new Date(Date.now() + 300000).toISOString(), 'mail-test').run()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let complete!: () => void
  let started!: () => void
  const providerStarted = new Promise<void>(resolve => { started = resolve })
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; started() })).mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  const first = kernel.mailOutbox.deliver(settings, kernel.config, 'mail-test', async () => true)
  try {
    await providerStarted
    await vi.advanceTimersByTimeAsync(30001)
    await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)
    expect(send).toHaveBeenCalledTimes(1)
    complete(); await first
    expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toMatchObject({ delivery_status: 'sent', attempts: 1 })
  } finally { complete(); await first.catch(() => {}); vi.useRealTimers() }
})

it('bounds a stalled provider and refuses to retry its unknown delivery outcome after the lease', async () => {
  const kernel = registry(); await enqueue(kernel)
  await env.DB.prepare('UPDATE email_outbox SET expires_at=? WHERE id=?').bind(new Date(Date.now() + 300000).toISOString(), 'mail-test').run()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let complete!: () => void
  let started!: () => void
  const providerStarted = new Promise<void>(resolve => { started = resolve })
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; started() })).mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const first = kernel.mailOutbox.deliver(settings, kernel.config, 'mail-test', async () => true)
  try {
    await providerStarted
    await vi.advanceTimersByTimeAsync(60000)
    await first
    expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toMatchObject({ delivery_status: 'failed', attempts: 1, last_error: 'email_send_timeout' })
    await vi.advanceTimersByTimeAsync(10000)
    await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)
    complete()
    expect(send).toHaveBeenCalledTimes(1)
  } finally { complete(); await first.catch(() => {}); vi.useRealTimers(); log.mockRestore() }
})

it('fences an interrupted delivery after its lease expires without resending', async () => {
  const kernel = registry(); await enqueue(kernel)
  const send = vi.fn(async () => ({ messageId: 'ok' }))
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  await env.DB.prepare("UPDATE email_outbox SET delivery_status='sending',attempts=1,lease_until=? WHERE id='mail-test'").bind(new Date(Date.now() + 60000).toISOString()).run()
  await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)
  expect(send).not.toHaveBeenCalled()
  await env.DB.prepare("UPDATE email_outbox SET lease_until='2000-01-01' WHERE id='mail-test'").run()
  await kernel.mailOutbox.retry(settings, kernel.config, 'mail-test', async () => true)
  expect(send).not.toHaveBeenCalled()
  expect(await kernel.mailOutbox.status(env.DB, 'mail-test')).toMatchObject({ delivery_status: 'failed', attempts: 1, last_error: 'email_send_timeout' })
})
it('refuses invitation delivery without an installed port before mutating invitations or mail', async () => {
  const without = { ...sample, plugins: sample.plugins!.filter(p => p.name !== 'mail-outbox') }
  const response = await request(createApp(without, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'new@example.test', role: 'viewer' })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'mail_outbox_required' })
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')).toBe(0)
})
it('adopts populated legacy rows without rewriting history, checks structure, and retains data on uninstall', async () => {
  const legacy = { ...sample, plugins: sample.plugins!.filter(p => p.name !== 'mail-outbox') }
  await setup(legacy)
  await env.DB.prepare("INSERT INTO email_outbox (id,recipient,subject,body,created_at,delivery_status,attempts) VALUES ('legacy','a@example.test','Legacy','credential','now','failed',2)").run()
  const kernel = registry(); await kernel.applyMigrations(env.DB); await kernel.applyMigrations(env.DB)
  expect(await env.DB.prepare("SELECT body,delivery_status,attempts FROM email_outbox WHERE id='legacy'").first()).toEqual({ body: 'credential', delivery_status: 'failed', attempts: 2 })
  expect((await pluginMigrationStatus(env.DB, kernel.plugins, kernel.config)).applied).toBe((await pluginMigrationStatus(env.DB, kernel.plugins, kernel.config)).expected)
  await env.DB.exec('DROP INDEX email_outbox_delivery_queue')
  await expect(pluginMigrationStatus(env.DB, kernel.plugins, kernel.config)).rejects.toThrow()
  await new KernelRegistry(legacy).applyMigrations(env.DB)
  expect(await env.DB.prepare("SELECT count(*) n FROM email_outbox WHERE id='legacy'").first('n')).toBe(1)
})
