import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import accounts from '../../../core/test/fixtures/accounts/config'
import { createApp } from '@workbasehq/core/app'
import { setup, runtime, request, json } from '@workbasehq/test-support/helpers'
import { sha256 } from '@workbasehq/core/crypto'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import type { PluginContext } from '@workbasehq/core/kernel/plugin'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { invitationMailToken } from '../src/invitation-token'
import { FakeIdpAdapter, idpAuth } from '../../idp-auth/src/fake'

let app: ReturnType<typeof createApp>
beforeEach(async () => { app = await setup() })
async function invite(email = 'owner.b@example.test', extra: Record<string, unknown> = {}) {
  const r = await request(app, '/orgs/org-a/invitations', 'POST', { email, role: 'viewer', ...extra })
  expect(r.status, await r.clone().text()).toBe(201)
  const row = await json(r)
  const mail = await env.DB.prepare('SELECT o.body FROM email_outbox o JOIN invitations i ON i.delivery_outbox_id=o.id WHERE i.id=?').bind(row.id).first<string>('body')
  return { ...row, token: new URL(mail!.replace('Accept: ', '')).searchParams.get('token')! }
}
async function complete(user = 'owner-b') {
  const kernel = new KernelRegistry(sample)
  return kernel.identity.updateProfile(runtime(), kernel.config, user, { firstName: 'Existing', lastName: 'Person' })
}
const call = (path: string, body?: unknown, user = 'owner-b', method?: string) => request(app, path, method ?? (body ? 'POST' : 'GET'), body, user)
function anonymous(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}
it('inbox discovers only eligible invitations for a verified account, including one with memberships', async () => {
  const a = await invite(); await invite('different@example.test')
  const r = await call('/me/invitations'); const body = await json(r)
  expect(r.headers.get('Cache-Control')).toContain('no-store')
  expect(body.data).toHaveLength(1)
  expect(body.data[0]).toMatchObject({ id: a.id, navigation_target: `/invitation?id=${a.id}`, account_match: true })
  expect(JSON.stringify(body)).not.toMatch(/token|hash|accept_url|email/)
  expect(await json(await call('/me'))).not.toHaveProperty('invitations')
  const proof = await anonymous('/invitations/resolve', { token: a.token })
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=?').bind('owner-b').run()
  expect((await app.request('http://localhost/me/invitations', { headers: { Authorization: `Bearer ${proof.headers.get('set-auth-token')}` } })).status).toBe(403)
})
it('inbox prioritizes a valid return target and a zero-membership invitation before creation', async () => {
  const a = await invite()
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='owner-b'").run()
  expect(await json(await call('/me/invitations'))).toMatchObject({ next: `/invitation?id=${a.id}` })
  expect(await json(await call('/me/invitations?return_to=/organizations'))).toMatchObject({ next: '/organizations' })
  expect(await json(await call(`/me/invitations?return_to=${encodeURIComponent(`/invitation?id=${a.id}`)}`))).toMatchObject({ next: `/invitation?id=${a.id}` })
})
it.each(['https://evil.test', '//evil.test', '/o/foreign', '/o/org-b/../org-a', '/o/org-b/%2f%2fevil', '/auth/logout'])('rejects invalid return target %s', async target => {
  expect(await json(await call(`/me/invitations?return_to=${encodeURIComponent(target)}`))).toEqual({ error: 'invalid_return_target' })
})
it('ID discovery and token resolution share recipient and profile eligibility', async () => {
  const a = await invite()
  const id = await json(await call(`/invitations/${a.id}/preview`))
  const token = await json(await call('/invitations/resolve', { token: a.token }))
  expect(id).toEqual(token)
  expect(id).toMatchObject({ state: 'pending', next: 'profile', profile_complete: false, actions: ['decline'] })
  expect(await env.DB.prepare('SELECT bound_user_id,accepted_at FROM invitations WHERE id=?').bind(a.id).first()).toEqual({ bound_user_id: 'owner-b', accepted_at: null })
  expect(await json(await call(`/invitations/${a.id}/accept`, {}))).toEqual({ error: 'profile_incomplete' })
  await complete()
  expect(await json(await call(`/invitations/${a.id}/preview`))).toMatchObject({ actions: ['accept', 'decline'] })
})
it('anonymous preflight is read-only and does not disclose recipient email, credentials or profile', async () => {
  const a = await invite()
  const r = await anonymous('/invitations/preflight', { token: a.token })
  expect(await json(r)).toMatchObject({ account_match: null, state: 'pending' })
  expect(r.headers.get('Cache-Control')).toContain('no-store')
  expect(r.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(r.headers.get('set-auth-token')).toBeNull()
  expect(await env.DB.prepare('SELECT bound_user_id FROM invitations WHERE id=?').bind(a.id).first('bound_user_id')).toBeNull()
})
it('already-member preview gives only the matching account its organization recovery target', async () => {
  const a = await invite()
  await env.DB.prepare("INSERT INTO memberships (user_id,organization_id,role) VALUES ('owner-b','org-a','viewer')").run()
  expect(await json(await call(`/invitations/${a.id}/preview`))).toEqual({ error: 'already_member', detail: { organization_id: 'org-a' } })
  expect(await json(await call(`/invitations/${a.id}/preview`, undefined, 'viewer-a'))).toEqual({ error: 'invitation_not_found' })
})
it.each(['resolve', 'preflight', 'accept', 'decline'])('wrong account cannot consume or bind through token %s', async action => {
  const a = await invite()
  const r = await call(`/invitations/${action}`, { token: a.token }, 'viewer-a')
  if (action === 'preflight') {
    expect(await json(r)).toMatchObject({ account_match: false })
    expect(JSON.stringify(await json(await call('/invitations/preflight', { token: a.token }, 'viewer-a')))).not.toContain('owner.b@example.test')
  } else expect(r.status).toBe(403)
  expect((await call(`/invitations/${a.id}/preview`, undefined, 'viewer-a')).status).toBe(404)
  expect(await env.DB.prepare('SELECT bound_user_id,accepted_at,declined_at FROM invitations WHERE id=?').bind(a.id).first()).toEqual({ bound_user_id: null, accepted_at: null, declined_at: null })
})
it('anonymous mailbox proof creates a session before profile/preview, without a domain account or membership', async () => {
  const a = await invite('fresh@example.test')
  const r = await anonymous('/invitations/resolve', { token: a.token })
  expect(r.status, await r.clone().text()).toBe(200)
  expect(await json(r)).toMatchObject({ id: a.id, next: 'profile', profile_complete: false })
  expect(r.headers.get('set-auth-token')).toBeTruthy()
  const bearer = r.headers.get('set-auth-token')!
  const me = await json(await app.request('http://localhost/me', { headers: { Authorization: `Bearer ${bearer}` } }))
  expect(me.memberships).toEqual([])
  const accept = () => app.request(`http://localhost/invitations/${a.id}/accept`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: '{}' })
  expect(await json(await accept())).toEqual({ error: 'profile_incomplete' })
  const kernel = new KernelRegistry(sample)
  await kernel.identity.updateProfile(runtime(), kernel.config, me.user.id, { firstName: 'New', lastName: 'Person' })
  expect((await accept()).status).toBe(201)
})
it('optional names prefill only a missing local profile, including concurrent previews', async () => {
  const a = await invite('owner.b@example.test', { profile_prefill: { firstName: '  Invite ', lastName: ' Name ' } })
  const previews = await Promise.all(Array.from({ length: 4 }, () => call(`/invitations/${a.id}/resolve`, {})))
  expect(previews.every(r => r.status === 200)).toBe(true)
  expect(await new KernelRegistry(sample).identity.readProfile(env.DB, sample, 'owner-b')).toMatchObject({ firstName: 'Invite', lastName: 'Name', completeness: { complete: true } })
  await complete()
  await call(`/invitations/${a.id}/resolve`, {})
  expect(await new KernelRegistry(sample).identity.readProfile(env.DB, sample, 'owner-b')).toMatchObject({ firstName: 'Existing', lastName: 'Person' })
})
it('prefill preserves a stored profile and legacy display name', async () => {
  const a = await invite('owner.b@example.test', { profile_prefill: { firstName: 'Invite', lastName: 'Name' } })
  await env.DB.prepare("INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES ('owner-b','Saved','Person','now')").run()
  await call(`/invitations/${a.id}/resolve`, {})
  expect(await env.DB.prepare("SELECT first_name,last_name FROM identity_profiles WHERE user_id='owner-b'").first()).toEqual({ first_name: 'Saved', last_name: 'Person' })
  expect(await env.DB.prepare("SELECT name FROM \"user\" WHERE id='owner-b'").first('name')).toBe('owner-b')
})
it('concurrent accept is one-use with successful same-account replay and a single audit/membership', async () => {
  const a = await invite(); await complete()
  const results = await Promise.all(Array.from({ length: 8 }, () => call(`/invitations/${a.id}/accept`, {})))
  expect(results.map(r => r.status).sort()).toEqual([...Array(7).fill(200), 201])
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first('n')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) n FROM audit_outbox WHERE json_extract(payload,'$.operation')='invitation.accepted'").first('n')).toBe(1)
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").run()
  expect(await json(await call(`/invitations/${a.id}/accept`, {}))).toMatchObject({ replayed: true })
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first()).toBeNull()
  expect(await json(await call(`/invitations/${a.id}/decline`, {}))).toEqual({ error: 'invitation_used' })
})
it('decline is terminal, idempotent, profile independent and releases the duplicate slot', async () => {
  const a = await invite()
  const results = await Promise.all(Array.from({ length: 6 }, () => call(`/invitations/${a.id}/decline`, {})))
  expect(results.every(r => r.status === 200)).toBe(true)
  expect(await env.DB.prepare("SELECT count(*) n FROM audit_outbox WHERE json_extract(payload,'$.operation')='invitation.declined'").first('n')).toBe(1)
  expect(await json(await call('/me/invitations'))).toMatchObject({ data: [] })
  expect(await json(await call(`/invitations/${a.id}/accept`, {}))).toEqual({ error: 'invitation_declined' })
  expect((await call(`/orgs/org-a/invitations/${a.id}/resend`, {}, 'owner-a')).status).toBe(409)
  expect((await invite()).id).not.toBe(a.id)
})
it('accept versus decline commits only one terminal result', async () => {
  const a = await invite(); await complete()
  const results = await Promise.all([call(`/invitations/${a.id}/accept`, {}), call(`/invitations/${a.id}/decline`, {})])
  expect(results.filter(r => r.status < 300)).toHaveLength(1)
  expect(results.filter(r => r.status === 409)).toHaveLength(1)
  const row = await env.DB.prepare('SELECT accepted_at,declined_at FROM invitations WHERE id=?').bind(a.id).first<any>()
  expect(!!row.accepted_at).not.toBe(!!row.declined_at)
})
it.each(['revoked', 'expired', 'rotated'])('rechecks %s after preview on both mutation paths', async mode => {
  const a = await invite(); await complete()
  expect((await call(`/invitations/${a.id}/preview`)).status).toBe(200)
  if (mode === 'revoked') await env.DB.prepare('UPDATE invitations SET revoked_at=? WHERE id=?').bind('now', a.id).run()
  if (mode === 'expired') await env.DB.prepare('UPDATE invitations SET expires_at=? WHERE id=?').bind('2000-01-01', a.id).run()
  if (mode === 'rotated') await request(app, `/orgs/org-a/invitations/${a.id}/copy-link`, 'POST', {})
  for (const action of ['accept', 'decline']) expect((await call(`/invitations/${action}`, { token: a.token })).status).toBe(mode === 'rotated' ? 404 : mode === 'expired' ? 410 : 409)
})
it('failed atomic audit leaves invitation and membership unchanged', async () => {
  const a = await invite(); await complete()
  await env.DB.exec("CREATE TRIGGER reject_accept_audit BEFORE INSERT ON audit_outbox WHEN json_extract(NEW.payload,'$.operation')='invitation.accepted' BEGIN SELECT RAISE(ABORT,'synthetic'); END;")
  expect((await call(`/invitations/${a.id}/accept`, {})).status).toBeGreaterThanOrEqual(400)
  expect(await env.DB.prepare('SELECT accepted_at,bound_user_id FROM invitations WHERE id=?').bind(a.id).first()).toEqual({ accepted_at: null, bound_user_id: null })
})
it('IdP-only requires verified recipient and IdP profile; invitation names cannot replace it', async () => {
  const adapter = new FakeIdpAdapter(); const plugin = idpAuth({ mode: 'test', adapter })
  const config = { ...sample, plugins: [...sample.plugins!.filter(p => p.name !== 'local-auth'), plugin] }
  const a = await invite('owner.b@example.test', { profile_prefill: { firstName: 'Invite', lastName: 'Name' } })
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-b','fake','https://idp.example.test','recipient','now')").run()
  app = createApp(config, runtime())
  expect((await anonymous('/invitations/resolve', { token: a.token })).status).toBe(401)
  const issue = (emailVerified: boolean, names = {}) => adapter.issue({ provider: 'fake', issuer: 'https://idp.example.test', subject: 'recipient', email: 'owner.b@example.test', emailVerified, ...names })
  const idp = (path: string, token: string, body?: unknown) => anonymous(path, body ?? {}, { 'X-Fake-Idp-Token': token })
  expect((await idp('/invitations/resolve', issue(false), { token: a.token })).status).toBe(403)
  const token = issue(true)
  expect(await json(await idp('/invitations/resolve', token, { token: a.token }))).toMatchObject({ profile_complete: false })
  expect(await env.DB.prepare("SELECT 1 FROM identity_profiles WHERE user_id='owner-b'").first()).toBeNull()
  expect(await json(await idp(`/invitations/${a.id}/accept`, token))).toEqual({ error: 'profile_incomplete' })
  expect((await idp(`/invitations/${a.id}/accept`, issue(true, { firstName: 'IdP', lastName: 'Person' }))).status).toBe(201)
})
it('local sign-out/account switch still requires proof as the recipient', async () => {
  const a = await invite()
  expect((await call('/invitations/resolve', { token: a.token }, 'viewer-a')).status).toBe(403)
  // A client-supplied switch flag cannot replace mailbox proof or change the invitation recipient.
  expect((await call('/invitations/accept', { token: a.token, switch_account: true }, 'viewer-a')).status).toBe(403)
  const proof = await anonymous('/invitations/resolve', { token: a.token })
  expect(proof.status).toBe(200)
  expect(await env.DB.prepare('SELECT bound_user_id,accepted_at FROM invitations WHERE id=?').bind(a.id).first()).toEqual({ bound_user_id: 'owner-b', accepted_at: null })
})
it('new session is revoked if the credential rotates during session creation', async () => {
  const a = await invite('raced@example.test')
  const wrapped = { ...localAuth, async signInInvitation(this: PluginContext, ...args: Parameters<NonNullable<typeof localAuth.signInInvitation>>) {
    const login = await localAuth.signInInvitation!.apply(this, args)
    await env.DB.prepare('UPDATE invitations SET token_hash=? WHERE id=?').bind(await sha256('b'.repeat(64)), a.id).run()
    return login
  } }
  app = createApp({ ...sample, plugins: sample.plugins!.map(p => p.name === 'local-auth' ? wrapped : p) }, runtime())
  expect((await anonymous('/invitations/resolve', { token: a.token })).status).toBe(404)
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
})
it('single domain account cannot discover/accept an invitation to a different organization', async () => {
  await setup(accounts); app = createApp(accounts, runtime())
  const user = await env.DB.prepare('SELECT id,email FROM "user" WHERE id IN (SELECT id FROM users) LIMIT 1').first<{ id: string; email: string }>()
  await env.DB.prepare("INSERT INTO organizations VALUES ('foreign','Other')").run()
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)').bind('foreign-invite', 'foreign', user!.email, 'reviewer', await sha256('a'.repeat(64)), '2099-01-01', user!.id).run()
  await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256('synthetic-domain'), user!.id, '2099-01-01').run()
  expect(await json(await call('/me/invitations', undefined, 'domain'))).toMatchObject({ data: [] })
  expect(await json(await call('/invitations/accept', { token: 'a'.repeat(64) }, 'domain'))).toEqual({ error: 'account_already_assigned' })
})
it('ID preview is read-only and foreign IDs/anonymous sessions cannot discover private invitations', async () => {
  const a = await invite('owner.b@example.test', { profile_prefill: { firstName: 'Hint', lastName: 'Person' } })
  expect((await call(`/invitations/${a.id}/preview`)).status).toBe(200)
  expect(await env.DB.prepare('SELECT bound_user_id FROM invitations WHERE id=?').bind(a.id).first('bound_user_id')).toBeNull()
  expect(await env.DB.prepare("SELECT 1 FROM identity_profiles WHERE user_id='owner-b'").first()).toBeNull()
  for (const action of ['resolve', 'accept', 'decline']) {
    expect((await call(`/invitations/${a.id}/${action}`, {}, 'viewer-a')).status).toBe(404)
  }
  expect((await app.request(`http://localhost/invitations/${a.id}/preview`)).status).toBe(401)
})
it.each(['resolve', 'preflight', 'accept', 'decline', 'opaque/resolve', 'opaque/accept', 'opaque/decline'])('cookie %s uses the existing JSON CSRF boundary', async action => {
  const r = await anonymous(`/invitations/${action}`, { token: 'a'.repeat(64) }, { Cookie: '__Host-workbase.session=synthetic', Origin: 'https://foreign.test', 'Sec-Fetch-Site': 'cross-site' })
  expect(r.status).toBe(403)
  expect(await json(r)).toEqual({ error: 'csrf_failed' })
})
it('lost verification after preview cannot accept or decline', async () => {
  const a = await invite(); await complete()
  expect((await call(`/invitations/${a.id}/preview`)).status).toBe(200)
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256('synthetic-owner-b')).run()
  for (const action of ['accept', 'decline']) expect((await call(`/invitations/${a.id}/${action}`, {})).status).toBe(401)
  expect(await env.DB.prepare('SELECT accepted_at,declined_at FROM invitations WHERE id=?').bind(a.id).first()).toEqual({ accepted_at: null, declined_at: null })
})
it('Members migration adopts pending and accepted history without changing credentials or profile', async () => {
  await setup({ ...sample, plugins: sample.plugins!.map(p => p.name === 'members' ? { ...p, migrations: p.migrations!.slice(0, 2) } : p) })
  for (const [id, accepted] of [['historical', true], ['pending', false]] as const) {
    await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,accepted_at,accepted_user_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, 'org-a', accepted ? 'old@example.test' : 'owner.b@example.test', 'viewer', await sha256(id), '2099-01-01', 'owner-a', accepted ? '2026-01-01' : null, accepted ? 'owner-b' : null).run()
  }
  await new KernelRegistry(sample).applyMigrations(env.DB)
  expect(await env.DB.prepare("SELECT bound_user_id,declined_at,token_hash FROM invitations WHERE id='historical'").first()).toEqual({ bound_user_id: 'owner-b', declined_at: null, token_hash: await sha256('historical') })
  expect(await env.DB.prepare("SELECT bound_user_id,declined_at FROM invitations WHERE id='pending'").first()).toEqual({ bound_user_id: null, declined_at: null })
})
it('concurrent invitations to two organizations cannot assign one physical domain account twice', async () => {
  await setup(accounts); app = createApp(accounts, runtime())
  await env.DB.prepare("INSERT INTO organizations VALUES ('assignment-other','Other')").run()
  for (const [id, org, token] of [['assignment-a', 'org-a', 'a'.repeat(64)], ['assignment-b', 'assignment-other', 'b'.repeat(64)]]) {
    await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)')
      .bind(id, org, 'assignment-race@example.test', 'reviewer', await sha256(token), '2099-01-01', 'administrator').run()
  }
  const entry = await anonymous('/invitations/resolve', { token: await invitationMailToken(runtime(), 'a'.repeat(64)) })
  expect(entry.status).toBe(200)
  const headers = { Authorization: `Bearer ${entry.headers.get('set-auth-token')}`, 'Content-Type': 'application/json' }
  const me = await json(await app.request('http://localhost/me', { headers }))
  expect(await env.DB.prepare('SELECT 1 FROM users WHERE id=?').bind(me.user.id).first()).toBeNull()
  expect((await app.request('http://localhost/me/profile', { method: 'PATCH', headers, body: JSON.stringify({ firstName: 'Domain', lastName: 'Recipient' }) })).status).toBe(200)
  const results = await Promise.all(['assignment-a', 'assignment-b'].map(id => app.request(`http://localhost/invitations/${id}/accept`, { method: 'POST', headers, body: '{}' })))
  expect(results.map(r => r.status).sort()).toEqual([201, 409])
  expect(await json(results.find(r => r.status === 409)!)).toEqual({ error: 'account_already_assigned' })
  expect(await env.DB.prepare('SELECT count(*) n FROM users WHERE id=?').bind(me.user.id).first('n')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) n FROM memberships WHERE user_id=?').bind(me.user.id).first('n')).toBe(1)
})

it('unrelated recipients retain separate rate limits during invitation mailbox proof', async () => {
  for (let index = 1; index <= 6; index++) {
    const value = await invite(`ada${index}@example.test`)
    const response = await anonymous('/invitations/resolve', { token: value.token }, { 'CF-Connecting-IP': `198.20.1.${index}` })
    expect(response.status, `recipient ${index}: ${await response.clone().text()}`).toBe(200)
  }
})
