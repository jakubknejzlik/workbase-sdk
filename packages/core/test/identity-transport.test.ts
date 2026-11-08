import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { BetterAuthIdentityProvider } from '@workbasehq/plugins/local-auth/identity-providers'
import { setup, runtime } from '@workbasehq/test-support/helpers'

const secure = 'https://workbase.example.test'
const settings = (baseURL = secure) => ({ ...runtime(), IDENTITY: { ...runtime().IDENTITY, baseURL, localPassword: false } })
let app: ReturnType<typeof createApp>
beforeEach(async () => { await setup(); app = createApp(sample, settings()) })
async function link(origin = secure) {
  const response = await app.request(`${origin}/auth/sign-in/magic-link`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'transport@example.test', callbackURL: '/me' }) })
  expect(response.status).toBe(200)
  return (await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='transport@example.test' ORDER BY rowid DESC LIMIT 1").first<string>('body'))!
}
function denied(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.has('set-auth-token')).toBe(false)
  expect(response.headers.getSetCookie().length).toBe(0)
}
it('ROUND2 rejects magic-link verification on public HTTP request despite HTTPS configuration', async () => {
  const url = await link()
  const before = await env.DB.prepare('SELECT * FROM verification ORDER BY id').all()
  const rejected = await app.request(url.replace('https:', 'http:')) // Deliberately no Origin.
  denied(rejected, 403)
  expect(await rejected.json()).toEqual({ error: 'insecure_identity_transport' })
  expect(await env.DB.prepare('SELECT * FROM verification ORDER BY id').all()).toMatchObject({ results: before.results })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')).toBe(0)
  const audit = await env.DB.prepare('SELECT operation,status FROM security_log').all()
  expect(audit.results.length).toBe(1)
  expect(audit.results.every(row => row.operation === 'insecure_identity_transport' && row.status === 403)).toBe(true)
  expect(JSON.stringify(audit).includes(new URL(url).searchParams.get('token')!)).toBe(false)
  const verified = await app.request(url)
  expect(verified.status).toBe(302)
  expect(verified.headers.get('set-auth-token')).toBeTruthy() // HTTP did not consume it.
})
it.each(['/providers', '/login', '/logout', '/revoke-all', '/link', '/sign-in/magic-link', '/sign-in/social', '/callback/oidc', '/get-session', '/error', '/unknown'])(
  'public HTTP rejects every auth route before processing: /auth%s', async path => {
    const response = await app.request(`http://workbase.example.test/auth${path}`, { method: 'POST',
      headers: { Forwarded: 'proto=https;host=localhost', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'localhost' } })
    denied(response, 403)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM verification').first('n')).toBe(0)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM security_log WHERE operation='insecure_identity_transport'").first('n')).toBe(1)
  })
it.each(['Bearer', 'cookie'])('public HTTP rejects a live Better Auth %s session before resolution', async credential => {
  const verified = await app.request(await link())
  const headers: Record<string, string> = credential === 'Bearer' ? { Authorization: `Bearer ${verified.headers.get('set-auth-token')}` } :
    { Cookie: verified.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))!.split(';')[0] }
  for (const path of ['/me', '/orgs', '/api/clients']) {
    const response = await app.request(`http://workbase.example.test${path}`, { method: path === '/orgs' ? 'POST' : 'GET', headers })
    denied(response, 401)
    expect(await response.json()).toEqual({ error: 'insecure_identity_transport' })
  }
  expect((await app.request(`${secure}/me`, { headers })).status).toBe(200)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM security_log WHERE operation='insecure_identity_transport' AND status=401").first('n')).toBe(3)
  expect(() => new BetterAuthIdentityProvider(settings()).session(new Request('http://workbase.example.test/me', { headers }))).toThrow('insecure_identity_transport')
})
it.each(['http://localhost', 'http://127.0.0.1', 'http://[::1]'])('genuine loopback HTTP issues and resolves Better Auth sessions with legacy disabled: %s', async origin => {
  app = createApp(sample, settings(origin))
  const verified = await app.request(await link(origin))
  expect(verified.status).toBe(302)
  expect((await app.request(`${origin}/me`, { headers: { Authorization: `Bearer ${verified.headers.get('set-auth-token')}`, Host: new URL(origin).host, Origin: origin } })).status).toBe(200)
})
it.each([
  ['http://localhost', { Host: 'workbase.example.test' }],
  ['http://localhost', { Origin: secure }],
  ['http://localhost.example.test', {}],
  ['http://127.0.0.2', {}],
] as [string, Record<string, string>][])('HTTP loopback exception rejects mismatched boundaries: %s %j', async (origin, headers) => {
  denied(await app.request(`${origin}/auth/providers`, { headers }), 403)
  denied(await app.request(`${origin}/me`, { headers }), 401)
})
