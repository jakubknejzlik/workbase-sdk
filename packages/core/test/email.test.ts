import { pluginMigrationStatus } from '../src/kernel/migrations'
import { KernelRegistry } from '../src/kernel/registry'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { hashMigrationRows } from '../src/schema-compatibility'
import { CORE_VERSION } from '../src/config'
import { CONSOLE_CSP } from '../src/console'
import type { RuntimeEnv } from '../src/types'
import { runtime, setup } from '@workbasehq/test-support/helpers'

const base = 'https://sample.console.example.test'
const from = 'noreply@console.example.test'
const recipient = 'synthetic@example.test'
let expectedSchema: string
const settings = (extra: Partial<RuntimeEnv> = {}): RuntimeEnv => ({ ...runtime(), IDENTITY: undefined, AUTH_BASE_URL: base, BETTER_AUTH_SECRET: 'synthetic-email-test-secret-at-least-32', STAGE: 'staging', SCHEMA_EXPECTED: expectedSchema, EMAIL_FROM: from, ...extra })
const row = () => env.DB.prepare('SELECT * FROM email_outbox WHERE recipient=?').bind(recipient).first<{ id: string; body: string; recipient: string; subject: string; delivery_status: string; attempts: number; sent_at: string | null; last_error: string | null }>()
const signIn = (app: ReturnType<typeof createApp>, origin = base) => app.request(`${base}/auth/sign-in/magic-link`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: recipient, callbackURL: '/auth/complete' }),
})
beforeEach(async () => {
  await setup()
  for (const db of [env.DB]) await db.exec('CREATE TABLE _migrations (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL);')
  const migrations = await hashMigrationRows([])
  expectedSchema = JSON.stringify({ revision: sample.revision, coreVersion: CORE_VERSION, migrations, pluginMigrations: (await pluginMigrationStatus(env.DB, new KernelRegistry(sample).plugins, sample)).expected })
})
afterEach(() => vi.restoreAllMocks())

it('email binding sends text and HTML after committing the audit row; token-only link issues a host-only session', async () => {
  const send = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => {
    expect(await row()).toMatchObject({ recipient, subject: 'Workbase sign-in', delivery_status: 'sending', attempts: 1 })
    return { messageId: 'synthetic-provider-id' }
  })
  const app = createApp(sample, settings({ EMAIL: { send } }))
  expect((await signIn(app)).status).toBe(200)
  const stored = (await row())!
  const message = send.mock.calls[0][0] as EmailMessageBuilder
  expect(message).toMatchObject({ from, to: recipient, subject: 'Workbase sign-in' })
  expect(message.text).toContain(stored.body)
  expect(message.html).toContain(`href="${stored.body}"`)
  const url = new URL(stored.body)
  expect(url.origin).toBe(base)
  expect(url.pathname).toBe('/auth/magic-link/verify')
  expect([...url.searchParams.keys()]).toEqual(['token'])
  expect(stored).toMatchObject({ delivery_status: 'sent', attempts: 1, last_error: null })
  expect(Date.parse(stored.sent_at!)).toBeGreaterThan(0)
  const verified = await app.request(stored.body)
  expect(verified.status).toBe(302)
  expect(verified.headers.get('location')).toBe(`${base}/auth/complete`)
  expect(verified.headers.get('set-auth-token')).toBeTruthy()
  const cookie = verified.headers.get('set-cookie')!
  for (const attribute of ['__Host-workbase.session=', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) expect(cookie).toContain(attribute)
  expect(cookie).not.toMatch(/domain=/i)
  expect((await app.request(stored.body)).headers.get('set-auth-token')).toBeNull()
})

it('absent binding preserves the outbox-only transport and generated callback link', async () => {
  const app = createApp(sample, settings())
  expect((await signIn(app)).status).toBe(200)
  const stored = (await row())!
  expect(stored).toMatchObject({ delivery_status: 'pending', attempts: 0, sent_at: null, last_error: null })
  expect(new URL(stored.body).searchParams.get('callbackURL')).toBe('/auth/complete')
})

it('provider failure retains the audit record, returns generic success, and never logs payload or raw error', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const send = vi.fn(async (message: EmailMessage | EmailMessageBuilder) => { throw new Error(`provider payload: ${JSON.stringify(message)}`) })
  const app = createApp(sample, settings({ EMAIL: { send } }))
  const response = await signIn(app)
  expect(response.status).toBe(200)
  const stored = (await row())!
  expect(stored).toMatchObject({ delivery_status: 'failed', attempts: 1, sent_at: null, last_error: 'email_send_failed' })
  expect(log.mock.calls).toEqual([[JSON.stringify({ event: 'email_send_failed', outboxId: stored.id })]])
  expect(JSON.stringify(log.mock.calls)).not.toContain(new URL(stored.body).searchParams.get('token'))
  expect(await response.text()).not.toContain(stored.body)
})

it('missing sender fails closed before calling the binding and records a redacted failure', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const send = vi.fn(async () => ({ messageId: 'unused' }))
  const app = createApp(sample, settings({ EMAIL: { send }, EMAIL_FROM: undefined }))
  expect((await signIn(app)).status).toBe(200)
  expect(send).not.toHaveBeenCalled()
  expect(await row()).toMatchObject({ delivery_status: 'failed', last_error: 'email_send_failed' })
})

it('audit insert failure prevents delivery', async () => {
  await env.DB.exec("CREATE TRIGGER fail_mail BEFORE INSERT ON email_outbox BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;")
  const send = vi.fn(async () => ({ messageId: 'unused' }))
  const app = createApp(sample, settings({ EMAIL: { send } }))
  expect((await signIn(app)).status).toBeGreaterThanOrEqual(400)
  expect(send).not.toHaveBeenCalled()
  expect(await row()).toBeNull()
})

it('staging workers.dev redirects preserve method/path/query before identity or database work', async () => {
  const app = createApp(sample, settings())
  const response = await app.request('https://workbase-poc-staging-sample.fixture.workers.dev/auth/magic-link/verify?token=synthetic-redirect', { method: 'POST' })
  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe(`${base}/auth/magic-link/verify?token=synthetic-redirect`)
  expect(await row()).toBeNull()
  const preview = createApp(sample, settings({ STAGE: 'pr-123', AUTH_BASE_URL: 'https://workbase-poc-pr-123-sample.fixture.workers.dev' }))
  expect((await preview.request('https://workbase-poc-pr-123-sample.fixture.workers.dev/health')).status).toBe(200)
})

it('custom domain remains the sole trusted browser origin and console CSP is same-origin', async () => {
  const app = createApp(sample, settings())
  expect((await signIn(app, 'https://accounts.console.example.test')).status).toBe(403)
  expect((await signIn(app, 'https://workbase-poc-staging-sample.fixture.workers.dev')).status).toBe(403)
  expect(await row()).toBeNull()
  const response = await app.request(`${base}/`)
  expect(response.headers.get('content-security-policy')).toBe(CONSOLE_CSP)
})
