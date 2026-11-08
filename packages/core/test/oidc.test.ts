import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeOIDC, FAKE_ISSUER } from './fixtures/fake-oidc'
import { setup, runtime, json } from '@workbasehq/test-support/helpers'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { SESSION_COOKIE } from '@workbasehq/plugins/local-auth/better-auth'
let issuer: Awaited<ReturnType<typeof fakeOIDC>>
let app: ReturnType<typeof createApp>
let ip = 40
class Browser {
  cookies = new Map<string, string>()
  token?: string
  async request(path: string, body?: unknown) {
    const response = await app.request(new URL(path, 'http://localhost').toString(), {
      method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${ip}`,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const value of response.headers.getSetCookie()) { const [name, ...rest] = value.split(';')[0].split('='); this.cookies.set(name, rest.join('=')) }
    this.token = response.headers.get('set-auth-token') ?? this.token
    return response
  }
  async start(link = false) {
    const start = await this.request(link ? '/auth/link' : '/auth/sign-in/social', { provider: 'oidc' })
    expect(start.status, JSON.stringify(await start.clone().json())).toBe(200)
    const { url } = await json(start)
    expect(new URL(url).searchParams.get('code_challenge')).toBeTruthy()
    const authorize = await issuer.fetch(new Request(url))
    expect(authorize.status).toBe(302)
    return authorize.headers.get('location')!
  }
  async oidc(link = false) { return this.request(await this.start(link)) }
}
beforeEach(async () => {
  await setup(); ip++
  issuer = await fakeOIDC()
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).origin !== FAKE_ISSUER) throw new Error('Unexpected outbound request')
    return issuer.fetch(request)
  })
  const envWithOIDC = { ...runtime(), IDENTITY: { ...runtime().IDENTITY, localPassword: false, oidc: { issuer: FAKE_ISSUER, clientId: 'test-client', clientSecret: 'test-secret' } } }
  app = createApp(sample, envWithOIDC)
})
afterEach(() => { vi.unstubAllGlobals() })
it('OIDC HTTPS sign-in protects state/nonce/PKCE and session cookies with __Host- and Secure defaults', async () => {
  const origin = 'https://workbase.example.test'
  issuer = await fakeOIDC(FAKE_ISSUER, origin)
  app = createApp(sample, { ...runtime(), IDENTITY: { ...runtime().IDENTITY, baseURL: origin, localPassword: false,
    oidc: { issuer: FAKE_ISSUER, clientId: 'test-client', clientSecret: 'test-secret' } } })
  const start = await app.request(`${origin}/auth/sign-in/social`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'oidc' }) })
  expect(start.status).toBe(200)
  const cookies = start.headers.getSetCookie()
  expect(cookies.some(cookie => cookie.startsWith('__Host-workbase.state='))).toBe(true)
  const { url } = await json(start)
  const authorize = await issuer.fetch(new Request(url))
  expect(authorize.status).toBe(302)
  const callback = await app.request(authorize.headers.get('location')!, { headers: { Cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') } })
  expect(callback.status).toBe(302)
  expect(callback.headers.getSetCookie().some(cookie => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(true)
  for (const cookie of [...cookies, ...callback.headers.getSetCookie()]) {
    expect(cookie).toMatch(/^__Host-workbase\./)
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) expect(cookie).toContain(attribute)
    expect(cookie).not.toMatch(/Domain=/i)
  }
})
it('OIDC public HTTP callback rejects before state or code consumption; HTTPS retry succeeds', async () => {
  const origin = 'https://workbase.example.test'
  issuer = await fakeOIDC(FAKE_ISSUER, origin)
  app = createApp(sample, { ...runtime(), IDENTITY: { ...runtime().IDENTITY, baseURL: origin, localPassword: false,
    oidc: { issuer: FAKE_ISSUER, clientId: 'test-client', clientSecret: 'test-secret' } } })
  const start = await app.request(`${origin}/auth/sign-in/social`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'oidc' }) })
  expect(start.status).toBe(200)
  const authorized = await issuer.fetch(new Request((await json(start)).url))
  const callback = authorized.headers.get('location')!
  const headers = { Cookie: start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
  const rejected = await app.request(callback.replace('https:', 'http:'), { headers })
  expect(rejected.status).toBe(403)
  expect(rejected.headers.getSetCookie().length).toBe(0)
  expect(rejected.headers.has('set-auth-token')).toBe(false)
  expect(issuer.exchanges).toHaveLength(0)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM security_log WHERE operation='insecure_identity_transport'").first('n')).toBe(1)
  expect((await app.request(callback, { headers })).status).toBe(302)
  expect(issuer.exchanges).toHaveLength(1)
})
it('OIDC full authorization code + S256 PKCE + signed ID token creates issuer/subject binding, and repeat login uses same user', async () => {
  const browser = new Browser()
  expect((await browser.oidc()).status).toBe(302)
  expect(browser.cookies.get(SESSION_COOKIE)).toBeTruthy()
  const me = await json(await browser.request('/me'))
  expect(me.user.email).toBe('external@example.test')
  const binding = await env.DB.prepare('SELECT * FROM identities WHERE issuer=? AND subject=?').bind(FAKE_ISSUER, 'external-1').first<any>()
  expect(binding).toMatchObject({ user_id: me.user.id, provider: 'oidc', issuer: FAKE_ISSUER, subject: 'external-1' })
  expect(await env.DB.prepare('SELECT "userId" FROM account WHERE issuer=? AND "accountId"=?').bind(FAKE_ISSUER, 'external-1').first('userId')).toBe(me.user.id)
  const second = new Browser()
  expect((await second.oidc()).status).toBe(302)
  expect((await json(await second.request('/me'))).user.id).toBe(me.user.id)
  expect(issuer.exchanges).toHaveLength(2)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM identities WHERE issuer=?').bind(FAKE_ISSUER).first('n')).toBe(1)
})
it('OIDC email collision cannot take over a verified local account: 409 identity_not_linked, no session, security_log', async () => {
  issuer.setUser({ sub: 'attacker-subject', email: 'owner.a@example.test' })
  const browser = new Browser()
  const before = await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')
  const response = await browser.oidc()
  expect(response.status).toBe(409)
  expect(await json(response)).toMatchObject({ error: 'identity_not_linked' })
  expect(browser.cookies.get(SESSION_COOKIE)).toBeUndefined()
  expect((await browser.request('/me')).status).toBe(401)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')).toBe(before)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM account WHERE "accountId"=?').bind('attacker-subject').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM security_log WHERE status=409').first('n')).toBe(1)
})
it('OIDC explicit link binds the new issuer/subject to the current live user, even with a different email', async () => {
  const browser = new Browser()
  expect((await browser.oidc()).status).toBe(302)
  const original = (await json(await browser.request('/me'))).user.id
  issuer.setUser({ sub: 'second-subject', email: 'other@example.test' })
  expect((await browser.oidc(true)).status).toBe(302)
  expect(await env.DB.prepare('SELECT user_id FROM identities WHERE issuer=? AND subject=?').bind(FAKE_ISSUER, 'second-subject').first('user_id')).toBe(original)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM identity_link_grants').first('n')).toBe(0)
  const second = new Browser()
  expect((await second.oidc()).status).toBe(302)
  expect((await json(await second.request('/me'))).user.id).toBe(original)
})
it('OIDC link state mismatch is 400 and does not bind or issue a new session', async () => {
  const browser = new Browser(); expect((await browser.oidc()).status).toBe(302)
  issuer.setUser({ sub: 'unbound-subject', email: 'new@example.test' })
  const callback = new URL(await browser.start(true)); callback.searchParams.set('state', 'wrong-state')
  const before = await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')
  expect((await browser.request(callback.toString())).status).toBe(400)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM identities WHERE subject=?').bind('unbound-subject').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')).toBe(before)
})
it('OIDC link requires the same live session at callback; revocation blocks the pending link', async () => {
  const browser = new Browser(); await browser.oidc()
  issuer.setUser({ sub: 'pending-subject', email: 'pending@example.test' })
  const callback = await browser.start(true)
  expect((await browser.request('/auth/revoke-all', {})).status).toBe(204)
  expect((await browser.request(callback)).status).toBe(400)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM identities WHERE subject=?').bind('pending-subject').first('n')).toBe(0)
})
it('OIDC rejects a signed ID token with mismatched nonce, and never trusts an unverified email', async () => {
  issuer.overrideClaims({ nonce: 'wrong-nonce' })
  const browser = new Browser()
  expect((await browser.oidc()).status).toBe(400)
  expect((await browser.request('/me')).status).toBe(401)
  issuer.overrideClaims({}); issuer.setUser({ sub: 'unverified', email: 'unverified@example.test', verified: false })
  expect((await new Browser().oidc()).status).toBe(400)
  issuer.overrideClaims({ email_verified: 'false' })
  expect((await new Browser().oidc()).status).toBe(400)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM identities WHERE issuer=?').bind(FAKE_ISSUER).first('n')).toBe(0)
})
it('OIDC account mirror cannot authenticate without the authoritative Workbase identity binding', async () => {
  const browser = new Browser(); expect((await browser.oidc()).status).toBe(302)
  await env.DB.prepare('DELETE FROM identities WHERE issuer=?').bind(FAKE_ISSUER).run()
  const before = await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')
  expect((await new Browser().oidc()).status).toBe(409)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM "session"').first('n')).toBe(before)
})
it('OIDC explicit linking cannot steal an identity already bound to another local user', async () => {
  const first = new Browser(); await first.oidc()
  const firstId = (await json(await first.request('/me'))).user.id
  issuer.setUser({ sub: 'other-owner', email: 'other-owner@example.test' })
  const second = new Browser(); await second.oidc()
  issuer.setUser({ sub: 'external-1', email: 'external@example.test' })
  expect((await second.oidc(true)).status).toBe(400)
  expect(await env.DB.prepare('SELECT user_id FROM identities WHERE issuer=? AND subject=?').bind(FAKE_ISSUER, 'external-1').first('user_id')).toBe(firstId)
})
it('OIDC rejects wrong audience, issuer, signature and expired signed tokens', async () => {
  for (const claims of [{ aud: 'attacker-client' }, { iss: 'https://attacker.test' }, { badSignature: true }, { exp: Math.floor(Date.now() / 1000) - 60 }]) {
    issuer.overrideClaims(claims)
    const browser = new Browser()
    expect((await browser.oidc()).status).toBe(400)
    expect((await browser.request('/me')).status).toBe(401)
  }
  expect(await env.DB.prepare('SELECT count(*) AS n FROM identities WHERE issuer=?').bind(FAKE_ISSUER).first('n')).toBe(0)
})
it('opaque DB sessions keep working while the external issuer is unavailable', async () => {
  const browser = new Browser(); await browser.oidc()
  vi.stubGlobal('fetch', () => { throw new Error('External issuer is unavailable') })
  expect((await browser.request('/me')).status).toBe(200)
  expect((await browser.request('/auth/logout', {})).status).toBe(204)
  expect((await browser.request('/me')).status).toBe(401)
})
it('console OIDC uses only its fixed same-origin completion callback and retains /me by default', async () => {
  const browser = new Browser()
  const start = await browser.request('/auth/sign-in/social', { provider: 'oidc', callbackURL: '/auth/complete' })
  expect(start.status).toBe(200)
  const authorized = await issuer.fetch(new Request((await json(start)).url))
  const callback = await browser.request(authorized.headers.get('location')!)
  expect(callback.status).toBe(302)
  expect(new URL(callback.headers.get('location')!, 'http://localhost').pathname).toBe('/auth/complete')
  expect((await browser.request('/me')).status).toBe(200)
  const legacy = new Browser(); const response = await legacy.oidc()
  expect(new URL(response.headers.get('location')!, 'http://localhost').pathname).toBe('/me')
})
for (const callbackURL of ['https://attacker.test', '//attacker.test', '/../me', '/organizations']) it(`OIDC refuses unregistered callback ${callbackURL}`, async () => {
  const response = await new Browser().request('/auth/sign-in/social', { provider: 'oidc', callbackURL })
  expect(response.status).toBe(400)
})
it('configured OIDC is advertised alongside Better Auth', async () => {
  expect(await json(await app.request('http://localhost/auth/providers'))).toEqual({ providers: [{ id: 'better-auth' }, { id: 'oidc' }] })
})
it('local fake issuer accepts only its explicitly registered callback origins', async () => {
  const local = await fakeOIDC(FAKE_ISSUER, ['http://localhost', 'http://localhost:8971'])
  for (const [redirect, status] of [
    ['http://localhost/auth/callback/oidc', 302],
    ['http://localhost:8971/auth/callback/oidc', 302],
    ['http://localhost:8971.evil.test/auth/callback/oidc', 400],
    ['http://localhost:8971/auth/callback/oidc/extra', 400],
  ] as const) {
    const url = new URL('/authorize', FAKE_ISSUER)
    url.search = new URLSearchParams({ client_id: 'test-client', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'synthetic', nonce: 'synthetic', state: 'synthetic', redirect_uri: redirect }).toString()
    expect((await local.fetch(new Request(url))).status).toBe(status)
  }
})
