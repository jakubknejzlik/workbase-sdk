import { KernelRegistry } from '../src/kernel/registry'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { ApiError } from '../src/errors'
import { createIdentityAuth, SESSION_COOKIE } from '@workbasehq/plugins/local-auth/better-auth'
import { setup, runtime, json, request } from '@workbasehq/test-support/helpers'
import { sha256 } from '../src/crypto'
import { accountScope, requireScope, requireVerifiedSession, resolveActor } from '../src/authorization'
let app: ReturnType<typeof createApp>
const settings = () => ({ ...runtime(), IDENTITY: { ...runtime().IDENTITY, localPassword: false } })
let ip = 0
function call(path: string, body?: unknown, token?: string, cookie?: string) {
  return app.request(`http://localhost${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    'Content-Type': 'application/json', Origin: 'http://localhost', 'CF-Connecting-IP': `192.0.2.${ip}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function magic(email = 'new@example.test') {
  expect((await call('/auth/sign-in/magic-link', { email, callbackURL: '/me' })).status).toBe(200)
  const url = await env.DB.prepare('SELECT body FROM email_outbox WHERE recipient=? ORDER BY created_at DESC LIMIT 1').bind(email).first<string>('body')
  expect(url).toBeTruthy()
  const token = new URL(url!).searchParams.get('token')!
  expect(await env.DB.prepare('SELECT identifier FROM verification WHERE identifier=?').bind(token).first()).toBeNull()
  const response = await app.request(url!, { headers: { 'CF-Connecting-IP': `192.0.2.${ip}` } })
  expect(response.status).toBe(302)
  const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))!
  expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax'); expect(cookie).toContain('Path=/'); expect(cookie).not.toContain('Domain=')
  const bearer = response.headers.get('set-auth-token')!
  expect(bearer).toBeTruthy()
  return { bearer, cookie: cookie.split(';')[0], response, url: url! }
}
beforeEach(async () => { await setup(); ip++; app = createApp(sample, settings()) })
it('BA magic link verifies email, creates opaque DB session, supports host cookie/Bearer /me and recovery', async () => {
  const first = await magic()
  const me = await json(await call('/me', undefined, first.bearer))
  expect(me.user.email).toBe('new@example.test'); expect(me.actor.type).toBe('user')
  expect((await call('/me', undefined, undefined, first.cookie)).status).toBe(200)
  expect(await env.DB.prepare('SELECT "emailVerified" FROM "user" WHERE id=?').bind(me.user.id).first('emailVerified')).toBe(1)
  const second = await magic()
  expect((await json(await call('/me', undefined, second.bearer))).user.id).toBe(me.user.id)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM "session" WHERE "userId"=?').bind(me.user.id).first('n')).toBe(2)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').bind(me.user.id).first('n')).toBe(0)
  const replay = await app.request(first.url)
  expect(replay.headers.get('set-auth-token')).toBeNull()
})
it('BA /me exposes the verified profile display name', async () => {
  const session = await magic('named@example.test')
  const me = await json(await call('/me', undefined, session.bearer))
  await env.DB.prepare('UPDATE "user" SET name=? WHERE id=?').bind('Ada Lovelace', me.user.id).run()
  expect((await json(await call('/me', undefined, session.bearer))).user).toMatchObject({ id: me.user.id, email: 'named@example.test', name: 'Ada Lovelace' })
})
it('BA logout revokes immediately and revoke-all removes every session', async () => {
  const first = await magic(); const second = await magic()
  expect((await call('/auth/logout', {}, first.bearer)).status).toBe(204)
  expect((await call('/me', undefined, first.bearer)).status).toBe(401)
  expect((await call('/me', undefined, second.bearer)).status).toBe(200)
  const third = await magic()
  expect((await call('/auth/revoke-all', {}, second.bearer)).status).toBe(204)
  for (const token of [second.bearer, third.bearer]) expect((await call('/me', undefined, token)).status).toBe(401)
})
it('BA expiry is fail closed; refresh extends an old live session without caching revocation', async () => {
  const { bearer } = await magic()
  const session = await createIdentityAuth(settings(), sample).api.getSession({ headers: new Headers({ Authorization: `Bearer ${bearer}` }) })
  const id = session!.session.id
  await env.DB.prepare('UPDATE "session" SET "updatedAt"=?,"expiresAt"=? WHERE id=?').bind(new Date(Date.now() - 2 * 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString(), id).run()
  const refreshed = await call('/auth/get-session', undefined, bearer)
  expect(refreshed.status).toBe(200)
  expect(Date.parse((await env.DB.prepare('SELECT "expiresAt" FROM "session" WHERE id=?').bind(id).first<string>('expiresAt'))!) - Date.now()).toBeGreaterThan(6 * 86400000)
  await env.DB.prepare('UPDATE "session" SET "expiresAt"=? WHERE id=?').bind(new Date(Date.now() - 1).toISOString(), id).run()
  expect((await call('/me', undefined, bearer)).status).toBe(401)
})
it('BA rate limits sign-in using persistent D1 counters', async () => {
  const statuses = []
  for (let i = 0; i < 6; i++) statuses.push((await call('/auth/sign-in/magic-link', { email: 'limit@example.test', callbackURL: '/me' })).status)
  expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  expect(await env.DB.prepare('SELECT count(*) AS n FROM "rateLimit"').first('n')).toBeGreaterThan(0)
})
it('BA rejects hostile Origins and callback URLs and disables the password surface in production', async () => {
  const hostile = await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.test', callbackURL: '/me' }) })
  expect(hostile.status).toBe(403)
  expect((await call('/auth/sign-in/magic-link', { email: 'x@example.test', callbackURL: 'https://attacker.test' })).status).toBe(403)
  expect((await call('/auth/login', { email: 'owner.a@example.test', password: 'anything' })).status).toBe(404)
  expect((await call('/auth/link-social', { provider: 'oidc' })).status).toBe(404)
})
it('BA invitation acceptance requires current verified email and retains existing email binding', async () => {
  const invitation = await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'invitee@example.test', role: 'viewer' })
  expect(invitation.status).toBe(201)
  const fresh = await magic('invitee@example.test')
  const body = await env.DB.prepare("SELECT body FROM email_outbox WHERE subject<>'Workbase sign-in'").first<string>('body')
  const token = new URL(body!.replace('Accept: ', '')).searchParams.get('token')!
  const me = await json(await call('/me', undefined, fresh.bearer))
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=?').bind(me.user.id).run()
  expect((await call('/invitations/accept', { token }, fresh.bearer)).status).toBe(403)
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=1 WHERE id=?').bind(me.user.id).run()
  expect((await app.request('http://localhost/me/profile', { method: 'PATCH', headers: { Authorization: `Bearer ${fresh.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'Invitee', lastName: 'Person' }) })).status).toBe(200)
  expect((await call('/invitations/accept', { token }, fresh.bearer)).status).toBe(201)
})

it('BA verified lookup and account/org scopes reject a session expired after resolution', async () => {
  const { bearer } = await magic('expiry@example.test')
  const actor = await resolveActor(new Request('http://localhost/me', { headers: { Authorization: `Bearer ${bearer}` } }), settings(), new KernelRegistry(sample).config)
  const stored = await env.DB.prepare('SELECT id,typeof("expiresAt") AS type,"expiresAt" AS expires FROM "session" WHERE "userId"=?').bind(actor.user!.id).first<{ id: string; type: string; expires: string }>()
  expect(stored!.type).toBe('text')
  expect(stored!.expires).toBe(new Date(stored!.expires).toISOString())
  await requireVerifiedSession(actor)
  await env.DB.prepare("INSERT INTO memberships VALUES (?,'org-a','viewer')").bind(actor.user!.id).run()
  await requireScope(actor, 'org-a', new KernelRegistry(sample).config)
  await accountScope(actor, 'org-a', 'viewer', 'expiry')
  await env.DB.prepare('UPDATE "session" SET "expiresAt"=? WHERE id=?').bind('2000-01-01T00:00:00.000Z', stored!.id).run()
  await expect(requireVerifiedSession(actor)).rejects.toMatchObject({ status: 403, code: 'verified_session_required' })
  await expect(requireScope(actor, 'org-a', new KernelRegistry(sample).config)).rejects.toMatchObject({ status: 403 })
  await expect(accountScope(actor, 'org-a', 'viewer', 'expiry')).rejects.toMatchObject({ status: 401 })
})

it.each(['object', 'flat'] as const)('BA invitation links use configured %s identity origin despite spoofed request host', async form => {
  const { bearer } = await magic('owner.a@example.test')
  if (form === 'flat') app = createApp(sample, { ...runtime(), IDENTITY: undefined, AUTH_BASE_URL: 'http://localhost', BETTER_AUTH_SECRET: runtime().IDENTITY.secret })
  const response = await app.request('https://attacker.example/orgs/org-a/invitations', {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Host: 'attacker.example', 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'safe-invite@example.test', role: 'viewer' }),
  })
  expect(response.status).toBe(201)
  const mail = await env.DB.prepare('SELECT body FROM email_outbox WHERE recipient=?').bind('safe-invite@example.test').first<string>('body')
  expect(mail).toMatch(/^Accept: http:\/\/localhost\/invitations\/accept\?token=/)
  expect(mail).not.toContain('attacker.example')
})

it('G1 a rejecting login hook denies a live cookie on get-session without leaking identity or token', async () => {
  const { cookie, bearer } = await magic('denied@example.test')
  expect((await call('/auth/get-session', undefined, undefined, cookie)).status).toBe(200)
  app = createApp({ ...sample, plugins: [identity, { ...localAuth, authenticate: () => { throw new ApiError(401, 'unauthenticated') } }, rbac, members, organizations] }, settings())
  expect((await call('/me', undefined, undefined, cookie)).status).toBe(401)
  const response = await call('/auth/get-session', undefined, undefined, cookie)
  const body = await response.text()
  expect(body).not.toContain('denied@example.test')
  expect(body).not.toContain(bearer)
  expect(response.status).toBe(401)
  expect(JSON.parse(body)).toEqual({ error: 'unauthenticated' })
  expect(response.headers.get('set-auth-token')).toBeNull()
})
