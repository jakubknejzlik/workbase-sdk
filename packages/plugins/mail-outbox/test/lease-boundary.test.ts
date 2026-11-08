import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { D1AtomicStore } from '@workbasehq/core/execution/d1'
import { identityWrite } from '../../../core/src/identity-writes'
import { runtime, setup } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })
it('fences an expired lease at 65001ms while the provider and timeout write are still pending', async () => {
  const kernel = new KernelRegistry(sample)
  const id = 'timeout-fence'
  await identityWrite(runtime(), kernel.config, 'queue_test', [kernel.mailOutbox.intent({ id, organizationId: null, recipient: 'review@example.test', subject: 'Review', body: 'Review', text: 'Review', html: '<p>Review</p>', expiresAt: new Date(Date.now() + 300000).toISOString() })])
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let finishProvider!: () => void, providerStarted!: () => void, fenceStarted!: () => void, releaseFence!: () => void
  const providerReady = new Promise<void>(resolve => { providerStarted = resolve })
  const fenceReady = new Promise<void>(resolve => { fenceStarted = resolve })
  const blockedFence = new Promise<void>(resolve => { releaseFence = resolve })
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finishProvider = resolve; providerStarted() })).mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  const run = D1AtomicStore.prototype.run
  let delayed = false
  const store = vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementation(async function(this: D1AtomicStore, plan) {
    if (!delayed && plan.rules.some(rule => rule.name === 'identity_email_delivery')) { delayed = true; fenceStarted(); await blockedFence }
    return run.call(this, plan)
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const first = kernel.mailOutbox.deliver(settings, kernel.config, id, async () => true)
  const firstOutcome = first.catch(error => error)
  try {
    await providerReady
    await vi.advanceTimersByTimeAsync(60000)
    await fenceReady
    // The lease must still cover the provider deadline while persistence starts.
    const lease = await env.DB.prepare('SELECT lease_until FROM email_outbox WHERE id=?').bind(id).first<string>('lease_until')
    expect(Date.parse(lease!)).toBeGreaterThan(Date.now())
    await vi.advanceTimersByTimeAsync(5001)
    expect(await kernel.mailOutbox.status(env.DB, id)).toMatchObject({ delivery_status: 'sending', attempts: 1, last_error: null })
    await kernel.mailOutbox.retry(settings, kernel.config, id, async () => true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await kernel.mailOutbox.status(env.DB, id)).toMatchObject({ delivery_status: 'failed', attempts: 1, last_error: 'email_send_timeout' })
    releaseFence()
    await expect(first).resolves.toBeUndefined()
    expect(await kernel.mailOutbox.status(env.DB, id)).toMatchObject({ last_error: 'email_send_timeout' })
  } finally { releaseFence(); finishProvider(); await firstOutcome; store.mockRestore(); log.mockRestore(); vi.useRealTimers() }
})

it('enforces a timeout fence committed after the retry read inside the atomic claim', async () => {
  const kernel = new KernelRegistry(sample)
  const id = 'stale-retry-read'
  await identityWrite(runtime(), kernel.config, 'queue_test', [kernel.mailOutbox.intent({ id, organizationId: null, recipient: 'review@example.test', subject: 'Review', body: 'Review', text: 'Review', html: '<p>Review</p>', expiresAt: new Date(Date.now() + 300000).toISOString() })])
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  await kernel.mailOutbox.retry(settings, kernel.config, id, async () => {
    // Another request commits the fence after this request's SELECT.
    await env.DB.prepare("UPDATE email_outbox SET delivery_status='failed',last_error='email_send_timeout' WHERE id=?").bind(id).run()
    return true
  })
  expect(send).not.toHaveBeenCalled()
  expect(await kernel.mailOutbox.status(env.DB, id)).toMatchObject({ delivery_status: 'failed', attempts: 0, last_error: 'email_send_timeout' })
})
