import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import sample from './fixtures/sample/config'
import accounts from './fixtures/accounts/config'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { setup, runtime } from '@workbasehq/test-support/helpers'
import { sha256 } from '../src/crypto'
let app: ReturnType<typeof createApp>
let ip = 100
const settings = () => ({ ...runtime(), IDENTITY: { ...runtime().IDENTITY, localPassword: false } })
function call(path: string, body?: unknown, bearer?: string, org = 'org-a', method?: string) {
  return app.request(`http://localhost${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${ip++}`, 'X-Organization-Id': org, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function signIn(email: string) {
  expect((await call('/auth/sign-in/magic-link', { email, callbackURL: '/me' })).status).toBe(200)
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient=? AND subject='Workbase sign-in' ORDER BY created_at DESC LIMIT 1").bind(email).first<string>('body')
  const response = await app.request(url!)
  expect(response.status).toBe(302)
  const bearer = response.headers.get('set-auth-token')!
  expect(bearer).toBeTruthy()
  expect((await call('/me/profile', { firstName: 'Signed', lastName: 'Person' }, bearer, 'org-a', 'PATCH')).status).toBe(200)
  return bearer
}
async function invite(email: string, role = 'reviewer', org = 'org-a') {
  const admin = await signIn('administrator@example.test')
  const response = await call(`/orgs/${org}/invitations`, { email, role }, admin, org)
  expect(response.status, await response.clone().text()).toBe(201)
  const row = await response.json() as { id: string }
  const body = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient=? AND subject<>'Workbase sign-in' ORDER BY created_at DESC LIMIT 1").bind(email).first<string>('body')
  const link = new URL(body!.replace('Accept: ', ''))
  expect([...link.searchParams.keys()]).toEqual(['token'])
  return { id: row.id, token: link.searchParams.get('token')!, admin }
}
async function enterAndAccept(token: string) {
  const entered = await call('/invitations/resolve', { token })
  expect(entered.status, await entered.clone().text()).toBe(200)
  expect(await entered.json()).toMatchObject({ next: 'profile' })
  const bearer = entered.headers.get('set-auth-token')!
  expect(bearer).toBeTruthy()
  expect((await call('/me/profile', { firstName: 'Invited', lastName: 'Person' }, bearer, 'org-a', 'PATCH')).status).toBe(200)
  const response = await call('/invitations/accept', { token, role: 'administrator' }, bearer)
  return { response, bearer }
}
beforeEach(async () => { await setup(accounts); app = createApp(accounts, settings()) })
it('F11: unknown accounts email signs in without a domain account, role or workspace access', async () => {
  const bearer = await signIn('fresh@example.test')
  const response = await call('/me', undefined, bearer)
  expect(response.status).toBe(200)
  const me = await response.json() as any
  expect(me.memberships).toEqual([])
  const bootstrap = await call('/bootstrap', undefined, bearer)
  expect(bootstrap.status).toBe(200)
  expect(bootstrap.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await bootstrap.json()).toMatchObject({ me })
  expect((await call('/o/org-a/bootstrap', undefined, bearer)).status).toBe(403)
  expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(me.user.id).first()).toBeNull()
  expect((await call('/query', { entity: 'records', limit: 10, select: ['id'] }, bearer)).status).toBe(403)
  expect((await call('/orgs/org-a/members', undefined, bearer)).status).toBe(403)
})
it('invitation signs in before profile completion and atomically accepts with the stored role', async () => {
  const invitation = await invite('fresh@example.test')
  const { response, bearer } = await enterAndAccept(invitation.token)
  expect(response.status, await response.clone().text()).toBe(201)
  expect(bearer).toBeTruthy()
  const me = await (await call('/me', undefined, bearer)).json() as any
  expect(me.memberships).toEqual([{ organization_id: 'org-a', name: 'Organization A', role: 'reviewer' }])
  const bootstrap = await call('/o/org-a/bootstrap', undefined, bearer)
  expect(bootstrap.status).toBe(200)
  const boot = await bootstrap.json() as any
  expect(boot.me).toEqual(me)
  expect(boot.capabilities).toEqual(await (await call('/o/org-a/capabilities', undefined, bearer)).json())
  expect((await call('/o/other-org/bootstrap', undefined, bearer, 'other-org')).status).toBe(403)
  expect(await env.DB.prepare('SELECT organization_id,role,name FROM users WHERE id=?').bind(me.user.id).first()).toMatchObject({ organization_id: 'org-a', role: 'reviewer' })
  expect((await call('/query', { entity: 'records', limit: 10, select: ['id'] }, bearer, 'other-org')).status).toBe(403)
  expect((await call('/invitations/accept', { token: invitation.token }, bearer)).status).toBe(200)
})
it.each(['expired', 'revoked'] as const)('anonymous %s invitation never registers or grants access', async state => {
  const invitation = await invite('blocked@example.test')
  if (state === 'expired') await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(invitation.id).run()
  else expect((await call(`/orgs/org-a/invitations/${invitation.id}`, undefined, invitation.admin, 'org-a', 'DELETE')).status).toBe(204)
  const response = await call('/invitations/accept', { token: invitation.token })
  expect(response.status).toBe(state === 'expired' ? 410 : 409)
  expect(response.headers.get('set-auth-token')).toBeNull()
  expect(await env.DB.prepare('SELECT id FROM "user" WHERE email=?').bind('blocked@example.test').first()).toBeNull()
})
it('resend rotates the token, and re-inviting an existing member changes nothing', async () => {
  const first = await invite('resend@example.test')
  expect((await call(`/orgs/org-a/invitations/${first.id}/resend`, {}, first.admin)).status).toBe(200)
  expect((await call('/invitations/accept', { token: first.token })).status).toBe(404)
  const row = await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(first.id).first<{token_hash: string}>()
  expect(row!.token_hash).not.toBe(await sha256(first.token))
  const response = await call('/orgs/org-a/invitations', { email: 'administrator@example.test', role: 'reviewer' }, first.admin)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ message: 'already_member' })
})
it('open signup creates a workspace; invite-only blocks unknown magic signup but accepts a token', async () => {
  await setup(sample)
  app = createApp(sample, settings())
  const bearer = await signIn('creator@example.test')
  expect((await call('/orgs', { name: 'New workspace' }, bearer)).status).toBe(201)
  const closed = defineInstance({ ...sample, registration: 'invite-only' })
  app = createApp(closed, settings())
  await call('/auth/sign-in/magic-link', { email: 'blocked@example.test', callbackURL: '/me' })
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='blocked@example.test'").first<string>('body')
  if (url) expect((await app.request(url)).headers.get('set-auth-token')).toBeNull()
  expect(await env.DB.prepare('SELECT id FROM "user" WHERE email=?').bind('blocked@example.test').first()).toBeNull()
})
it('accounts disables organization creation for a fresh identity', async () => {
  const bearer = await signIn('creator@example.test')
  const response = await call('/orgs', { name: 'Own laboratory' }, bearer)
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'organization_creation_disabled' })
  expect((await call('/query', { entity: 'records', limit: 10, select: ['id'] }, bearer, 'org-a')).status).toBe(403)
})
it('a signed-in invitee receives the stored role; another account cannot claim or consume it', async () => {
  const invitation = await invite('signed@example.test', 'operator')
  const wrong = await signIn('wrong@example.test')
  expect((await call('/invitations/accept', { token: invitation.token }, wrong)).status).toBe(403)
  const bearer = await signIn('signed@example.test')
  expect((await call('/invitations/accept', { token: invitation.token }, bearer)).status).toBe(201)
  const me = await (await call('/me', undefined, bearer)).json() as any
  expect(me.memberships[0].role).toBe('operator')
  expect(await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(me.user.id).first('role')).toBe('operator')
})
it('invite-only permits the live invitation credential but never grants an implicit role on sign-in', async () => {
  const invitation = await invite('closed@example.test', 'operator')
  app = createApp(defineInstance({ ...accounts, registration: 'invite-only' }), settings())
  const bearer = await signIn('closed@example.test')
  const me = await (await call('/me', undefined, bearer)).json() as any
  expect(me.memberships).toEqual([])
  expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(me.user.id).first()).toBeNull()
  expect((await call('/invitations/accept', { token: invitation.token }, bearer)).status).toBe(201)
  const anonymous = await invite('anonymous-closed@example.test', 'reviewer')
  expect((await enterAndAccept(anonymous.token)).response.status).toBe(201)
})
it('invitation delivery uses the mail adapter after committing the intent, including resend', async () => {
  const sent: EmailMessageBuilder[] = []
  const mailEnv = { ...settings(), EMAIL_FROM: 'noreply@example.test', EMAIL: { send: async (message: EmailMessage | EmailMessageBuilder) => { sent.push(message as EmailMessageBuilder); return { messageId: 'synthetic' } } } }
  app = createApp(accounts, mailEnv)
  const invitation = await invite('mail@example.test')
  const message = sent.find(message => message.to === 'mail@example.test')!
  const link = message.text!.match(/http[^\s]+/)![0]
  expect([...new URL(link).searchParams.keys()]).toEqual(['token'])
  expect(message.html).toContain(link)
  expect(await env.DB.prepare("SELECT delivery_status,attempts FROM email_outbox WHERE recipient='mail@example.test' AND subject<>'Workbase sign-in'").first()).toEqual({ delivery_status: 'sent', attempts: 1 })
  expect((await call(`/orgs/org-a/invitations/${invitation.id}/resend`, {}, invitation.admin)).status).toBe(200)
  expect(sent.filter(message => message.to === 'mail@example.test')).toHaveLength(2)
  expect(sent.filter(message => message.to === 'mail@example.test')[1].subject).toMatch(/^Reminder:/)
})
it('concurrent claims create exactly one domain account, membership and acceptance event', async () => {
  const invitation = await invite('concurrent@example.test', 'reviewer')
  const bearer = await signIn('concurrent@example.test')
  const responses = await Promise.all(Array.from({ length: 10 }, () => call('/invitations/accept', { token: invitation.token }, bearer)))
  expect(responses.map(response => response.status).sort()).toEqual([...Array(9).fill(200), 201])
  expect(await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email='concurrent@example.test'").first('n')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='concurrent@example.test'").first('n')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_outbox WHERE json_extract(payload,'$.operation')='invitation.accepted'").first('n')).toBe(1)
})
it('a failed membership write rolls back domain provisioning and the invitation claim', async () => {
  const invitation = await invite('rollback@example.test', 'reviewer')
  const bearer = await signIn('rollback@example.test')
  const me = await (await call('/me', undefined, bearer)).json() as any
  await env.DB.exec('CREATE TRIGGER reject_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(IGNORE); END;')
  expect((await call('/invitations/accept', { token: invitation.token }, bearer)).status).toBe(409)
  expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(me.user.id).first()).toBeNull()
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(invitation.id).first('accepted_at')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_outbox WHERE json_extract(payload,'$.operation')='invitation.accepted'").first('n')).toBe(0)
})
it('rejoining changes membership authority while retaining the inert domain account role', async () => {
  const first = await invite('rejoin@example.test', 'reviewer')
  const { response: accepted, bearer } = await enterAndAccept(first.token)
  expect(accepted.status).toBe(201)
  const me = await (await call('/me', undefined, bearer)).json() as any
  expect((await call(`/orgs/org-a/members/${me.user.id}`, undefined, first.admin, 'org-a', 'DELETE')).status).toBe(204)
  const second = await invite('rejoin@example.test', 'operator')
  expect((await call('/invitations/accept', { token: second.token }, bearer)).status).toBe(201)
  expect(await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(me.user.id).first('role')).toBe('reviewer')
  expect(await env.DB.prepare('SELECT role FROM memberships WHERE user_id=? AND organization_id=?').bind(me.user.id, 'org-a').first('role')).toBe('operator')
})
it('resending an unused invitation after membership was granted separately is a clear no-op', async () => {
  const second = await invite('member@example.test')
  const bearer = await signIn('member@example.test')
  const me = await (await call('/me', undefined, bearer)).json() as { user: { id: string } }
  // A managed import can grant membership while the invitation remains pending.
  await env.DB.prepare('INSERT INTO users (id,organization_id,name,role,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(me.user.id, 'org-a', 'Existing Member', 'reviewer', 'member@example.test', new Date().toISOString(), new Date().toISOString()).run()
  await env.DB.prepare('INSERT INTO memberships (user_id,organization_id,role) VALUES (?,?,?)').bind(me.user.id, 'org-a', 'reviewer').run()
  const before = await env.DB.prepare('SELECT count(*) AS n FROM email_outbox').first('n')
  const resend = await call(`/orgs/org-a/invitations/${second.id}/resend`, {}, second.admin)
  expect(resend.status).toBe(200)
  expect(await resend.json()).toEqual({ message: 'already_member' })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM email_outbox').first('n')).toBe(before)
})
it.each(['/invitations/resolve', '/invitations/accept', '/auth/register'])('an expired browser cookie recovers %s session entry without accepting', async path => {
  const invitation = await invite('stale-cookie@example.test')
  const response = await app.request(`http://localhost${path}`, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', Cookie: '__Host-workbase.session=expired', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ token: invitation.token }) })
  expect(response.status).toBe(200)
  expect(response.headers.get('set-auth-token')).toBeTruthy()
  expect(await response.json()).toMatchObject({ next: 'profile' })
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(invitation.id).first('accepted_at')).toBeNull()
})

it('Policy graph rejects an incompatible member account with a validation 4xx and leaves the invitation pending', async () => {
  const invitation = await invite('builtin-member@example.test', 'member')
  const { response, bearer } = await enterAndAccept(invitation.token)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: 'invalid_invitation_role' })
  const me = await (await call('/me', undefined, bearer)).json() as any
  expect(me.memberships).toEqual([])
  expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(me.user.id).first()).toBeNull()
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(invitation.id).first('accepted_at')).toBeNull()
})
