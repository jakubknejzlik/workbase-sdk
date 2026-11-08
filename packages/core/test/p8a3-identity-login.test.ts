import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import type { AppEnv } from '../src/types'
import { crudRoutes } from '../src/crud'
import { workflowRoutes } from '../src/workflow-routes'
import { canManageAccountAssignments } from '../src/policies'
import sample from './fixtures/sample/config'
import accounts from './fixtures/accounts/config'
import type { WorkbasePlugin as pluginWorkbasePlugin } from '@workbasehq/core/plugins'
import { identity as pluginidentity } from '@workbasehq/plugins/identity'
import { localAuth as pluginlocalAuth } from '@workbasehq/plugins/local-auth'
import { members as pluginmembers } from '@workbasehq/plugins/members'
import { organizations as pluginorganizations } from '@workbasehq/plugins/organizations'
import { legacyPermissions as pluginrbac } from '@workbasehq/plugins/permissions'
import { idpAuth, FakeIdpAdapter } from '../../plugins/idp-auth/src/fake'
import { KernelRegistry } from '../src/kernel/registry'
import { createApp } from '../src/app'
import { resolveActor, requireScope, scopeMiddleware } from '../src/authorization'
import { createIdentityAuth } from '@workbasehq/plugins/local-auth/better-auth'
import { sha256 } from '../src/crypto'
import { json, request, runtime, setup } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })
const external = (subject = 'external-owner') => ({ provider: 'fake', issuer: 'https://idp.example.test', subject, email: 'owner.a@example.test', emailVerified: true })
const composition = (login: pluginWorkbasePlugin) => ({ ...sample, plugins: [pluginidentity, pluginrbac, pluginmembers, pluginorganizations, login] })
const fake = () => {
  const adapter = new FakeIdpAdapter()
  return { adapter, plugin: idpAuth({ mode: 'test', adapter }) }
}
const bearer = (token: string) => new Request('http://localhost', { headers: token.startsWith('fake_') ? { 'X-Fake-Idp-Token': token } : { Authorization: `Bearer ${token}` } })

it('Identity supplies the stable local model without any login or session routes', async () => {
  expect(pluginidentity.provides).toEqual({ identity: '1.x' })
  expect(pluginidentity.authenticate).toBeUndefined()
  expect(pluginidentity.signInInvitation).toBeUndefined()
  expect(() => new KernelRegistry({ ...sample, plugins: [pluginidentity] })).toThrow(/login/i)
  const app = createApp({ ...sample, interactive: false, plugins: [pluginidentity] }, runtime())
  for (const path of ['/auth/providers', '/auth/get-session', '/auth/sign-in/magic-link']) expect((await app.request(`http://localhost${path}`)).status).toBe(404)
})
it('local-auth requires Identity and always disables Better Auth implicit linking', () => {
  expect(pluginlocalAuth.requires).toEqual({ identity: '^1' })
  expect(() => new KernelRegistry({ ...sample, plugins: [pluginlocalAuth] })).toThrow(/identity/i)
  for (const explicit of [false, true]) expect(createIdentityAuth(runtime(), new KernelRegistry(sample).config, explicit).options.account?.accountLinking?.disableImplicitLinking).toBe(true)
})
it('Login swap preserves all Policy graph domain rows, user references, memberships and pending invitations', async () => {
  await setup(accounts)
  const now = '2026-10-28T00:00:00Z'
  for (const [id, role] of [['coordinator-a', 'coordinator'], ['reviewer-b2', 'reviewer']]) {
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, `${id}@example.test`, '', '', 'org-a', id, role, now, now).run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,0,?,?)').bind(id, id, `${id}@example.test`, now, now).run()
    await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(id, id, now).run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, 'org-a', role).run()
  }
  // Non-empty reference graph includes stable local user IDs in business rows.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO teams (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('team-a', 'org-a', 'Team A', now, now),
    env.DB.prepare('INSERT INTO records (id,organization_id,name,team_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('record-a', 'org-a', 'Record A', 'team-a', now, now),
    env.DB.prepare('INSERT INTO reports (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('report-a', 'org-a', 'Report A', now, now),
    env.DB.prepare('INSERT INTO work_logs (id,organization_id,operator_user_id,minutes,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('log-a', 'org-a', 'operator-a', 30, now, now),
    env.DB.prepare('UPDATE users SET team_id=? WHERE role=?').bind('team-a', 'reviewer'),
  ])
  for (let index = 0; index < 10; index++) {
    await env.DB.prepare('INSERT INTO jobs (id,organization_id,title,reviewer_user_id,operator_user_id,record_id,report_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(`job-${index}`, 'org-a', `Job ${index}`, index % 2 ? 'reviewer-a1' : 'reviewer-b2', 'operator-a', 'record-a', 'report-a', now, now).run()
  }
  const before = new KernelRegistry(accounts)
  const environment = { ...runtime(), IDENTITY: { ...runtime().IDENTITY, localPassword: false } }
  const app = createApp(accounts, environment)
  const localTokens = new Map<string, string>()
  const domain = async () => {
    const result: Record<string, unknown[]> = {}
    for (const table of [...Object.keys(accounts.entities), 'memberships', 'invitations', 'identities', 'user']) result[table] = (await env.DB.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).results
    return result
  }
  // Deliberate, operator-managed mappings; login must never pair these emails.
  const users = (await env.DB.prepare('SELECT id,email FROM "user" ORDER BY id').all<{ id: string; email: string }>()).results
  expect(users).toHaveLength(8)
  for (const [index, user] of users.entries()) {
    const sent = await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${index + 1}` }, body: JSON.stringify({ email: user.email }) })
    expect(sent.status).toBe(200)
    const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient=? AND subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").bind(user.email).first<string>('body')
    const signedIn = await app.request(url!, { headers: { 'CF-Connecting-IP': `192.0.2.${index + 1}` } })
    expect(signedIn.status).toBe(302)
    localTokens.set(user.id, signedIn.headers.get('set-auth-token')!)
    await env.DB.prepare("INSERT INTO identities VALUES (?,'fake','https://idp.example.test',?,'2026-10-28')").bind(user.id, `external-${user.id}`).run()
  }
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)').bind('pending-swap', 'org-a', 'invitee@example.test', 'reviewer', await sha256('a'.repeat(64)), '2099-01-01', 'administrator').run()
  const rows = await domain()
  const { adapter, plugin } = fake()
  const config = { ...accounts, plugins: [...accounts.plugins!.filter(p => !p.provides?.login), plugin] }
  const after = new KernelRegistry(config)
  await after.applyMigrations(env.DB)
  for (const user of users) {
    const token = adapter.issue({ ...external(`external-${user.id}`), email: user.email })
    const oldActor = await before.requireActor(bearer(localTokens.get(user.id)!), environment)
    const actor = await after.requireActor(bearer(token), environment)
    expect(actor.actor.id).toBe(oldActor.actor.id)
    expect(actor.user!.id).toBe(user.id)
    expect((await requireScope(actor, actor.organizations[0].id, after.config)).actor.id).toBe(user.id)
  }
  const afterRows = await domain()
  for (const table of Object.keys(rows)) {
    expect(rows[table].length, `${table} before login swap`).toBeGreaterThan(0)
    expect(afterRows[table].length, `${table} after login swap`).toBeGreaterThan(0)
  }
  expect(afterRows).toEqual(rows)
})
it.each([false, true])('two actual login plugins reject the same request, reversed=%s', async reversed => {
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','external-owner','now')").run()
  const { adapter, plugin } = fake()
  // Fake credentials can be deliberately assigned for a collision contract test.
  adapter.issue(external(), 'synthetic-owner-a')
  const logins = reversed ? [plugin, pluginlocalAuth] : [pluginlocalAuth, plugin]
  const kernel = new KernelRegistry({ ...sample, plugins: [...sample.plugins!.filter(p => !p.provides?.login), ...logins] })
  await expect(kernel.requireActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a', 'X-Fake-Idp-Token': 'synthetic-owner-a' } }), runtime())).rejects.toMatchObject({ code: 'ambiguous_login' })
})
it('a fake subject and equal email cannot impersonate a local ID or automatically create a mapping', async () => {
  const { adapter, plugin } = fake()
  const kernel = new KernelRegistry(composition(plugin))
  const token = adapter.issue({ ...external('owner-a') })
  await expect(kernel.requireActor(bearer(token), runtime())).rejects.toMatchObject({ code: 'identity_not_linked' })
  expect(await env.DB.prepare("SELECT count(*) n FROM identities WHERE provider='fake'").first('n')).toBe(0)
})
it.each([['external-subject', 'owner.a@example.test'], ['owner-a', 'forged@example.test']])('a forged login claim is rejected by Identity: %s / %s', async (id, email) => {
  const forged: pluginWorkbasePlugin = { name: 'forged', version: '1', provides: { login: '1.x' }, requires: { identity: '^1' }, authenticate: () => ({ actor: { type: 'user', id }, user: { id, email }, organizations: [] }) }
  await expect(new KernelRegistry(composition(forged)).requireActor(bearer('anything'), runtime())).rejects.toMatchObject({ code: 'invalid_local_identity' })
})
it.each([
  ['untrusted verified', {}, true],
  ['trusted unverified', { 'https://idp.example.test': ['example.test'] }, false],
  ['wrong domain', { 'https://idp.example.test': ['other.test'] }, true],
])('Identity rejects email pairing: %s', async (_name, trustedIssuers, emailVerified) => {
  const kernel = new KernelRegistry({ ...sample, pluginConfig: { identity: { trustedIssuers } } })
  await expect(kernel.identity.linkExternalIdentity(env, kernel.config, { userId: 'owner-a', external: { ...external(), emailVerified } })).rejects.toMatchObject({ code: 'identity_link_not_allowed' })
  expect(await env.DB.prepare("SELECT count(*) n FROM identities WHERE provider='fake'").first('n')).toBe(0)
})
it('trusted AND verified email allows only an explicit Identity linking operation', async () => {
  const kernel = new KernelRegistry({ ...sample, pluginConfig: { identity: { trustedIssuers: { 'https://idp.example.test': ['example.test'] } } } })
  await kernel.identity.linkExternalIdentity(env, kernel.config, { userId: 'owner-a', external: external() })
  expect((await kernel.identity.resolveExternalIdentity(env.DB, external())).id).toBe('owner-a')
})
it('explicit linking requires a live authenticated local session for the target user', async () => {
  const kernel = new KernelRegistry(sample)
  const actor = await kernel.requireActor(bearer('synthetic-owner-a'), runtime())
  const input = { userId: 'owner-a', external: { ...external(), emailVerified: false }, confirmation: actor }
  await expect(kernel.identity.linkExternalIdentity(runtime(), kernel.config, { ...input, confirmation: { ...actor } })).rejects.toMatchObject({ code: 'verified_session_required' })
  await expect(kernel.identity.linkExternalIdentity(runtime(), kernel.config, { ...input, userId: 'owner-b' })).rejects.toMatchObject({ code: 'identity_link_not_allowed' })
  await kernel.identity.linkExternalIdentity(runtime(), kernel.config, input)
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256('synthetic-owner-a')).run()
  await expect(kernel.identity.linkExternalIdentity(runtime(), kernel.config, { ...input, external: external('revoked') })).rejects.toMatchObject({ code: 'verified_session_required' })
})
it('linking never reassigns another local user’s provider/issuer/subject', async () => {
  const kernel = new KernelRegistry(sample)
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-b','fake','https://idp.example.test','external-owner','now')").run()
  const actor = await kernel.requireActor(bearer('synthetic-owner-a'), runtime())
  await expect(kernel.identity.linkExternalIdentity(runtime(), kernel.config, { userId: 'owner-a', external: external(), confirmation: actor })).rejects.toMatchObject({ code: 'identity_binding_conflict' })
  expect((await kernel.identity.resolveExternalIdentity(env.DB, external())).id).toBe('owner-b')
})
it('IdP-only invitation entry requires authentication and verified matching recipient; link alone never establishes a session', async () => {
  const { adapter, plugin } = fake()
  const config = composition(plugin)
  const app = createApp(config, { ...runtime(), IDENTITY: { ...runtime().IDENTITY, localPassword: false } })
  await env.DB.prepare("INSERT INTO identities VALUES ('viewer-a','fake','https://idp.example.test','recipient','now'),('owner-b','fake','https://idp.example.test','wrong','now')").run()
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=?').bind('viewer-a').run()
  const token = 'a'.repeat(64)
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)').bind('idp-invite', 'org-b', 'viewer.a@example.test', 'viewer', await sha256(token), '2099-01-01', 'owner-b').run()
  const accept = (credential?: string) => app.request('http://localhost/invitations/accept', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...(credential ? { 'X-Fake-Idp-Token': credential } : {}) }, body: JSON.stringify({ token }) })
  expect((await accept()).status).toBe(401)
  expect((await accept(adapter.issue({ ...external('wrong'), email: 'owner.b@example.test' }))).status).toBe(403)
  expect((await accept(adapter.issue({ ...external('recipient'), email: 'viewer.a@example.test', emailVerified: false }))).status).toBe(403)
  expect(await env.DB.prepare("SELECT accepted_at FROM invitations WHERE id='idp-invite'").first('accepted_at')).toBeNull()
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
  expect((await accept(adapter.issue({ ...external('recipient'), email: 'viewer.a@example.test', firstName: 'IdP', lastName: 'Recipient' }))).status).toBe(201)
  expect(await env.DB.prepare("SELECT accepted_user_id FROM invitations WHERE id='idp-invite'").first('accepted_user_id')).toBe('viewer-a')
})
it('IdP revocation and live membership removal deny subsequent requests from an open login', async () => {
  const { adapter, plugin } = fake()
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','external-owner','now')").run()
  const app = createApp(composition(plugin), runtime())
  const token = adapter.issue(external())
  const read = () => request(app, '/orgs/org-a/members', 'GET', undefined, 'owner-a', 'org-a', { 'X-Fake-Idp-Token': token })
  expect((await read()).status).toBe(200)
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='owner-a'").run()
  expect((await read()).status).toBe(403)
  adapter.revoke(token)
  expect((await read()).status).toBe(401)
})
it('IdP-only installation mounts no local-auth routes despite retained tables', async () => {
  const { plugin } = fake()
  const app = createApp(composition(plugin), runtime())
  expect((await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST' })).status).toBe(404)
  expect(await json(await app.request('http://localhost/auth/providers'))).toEqual({ providers: [{ id: 'fake' }] })
})

it('trusted and verified fake login still never links equal-email accounts automatically', async () => {
  const { adapter, plugin } = fake()
  const kernel = new KernelRegistry({ ...composition(plugin), pluginConfig: { identity: { trustedIssuers: { 'https://idp.example.test': ['example.test'] } } } })
  await expect(kernel.requireActor(bearer(adapter.issue(external())), runtime())).rejects.toMatchObject({ code: 'identity_not_linked' })
  expect(await env.DB.prepare("SELECT count(*) n FROM identities WHERE provider='fake'").first('n')).toBe(0)
})
it('fake credentials are restricted to test/dev loopback requests', async () => {
  const { adapter, plugin } = fake()
  const kernel = new KernelRegistry(composition(plugin))
  const token = adapter.issue(external())
  for (const [url, environment] of [['https://public.example.test', runtime()], ['http://localhost', { ...runtime(), STAGE: 'production' }]] as const) {
    await expect(kernel.requireActor(new Request(url, { headers: { 'X-Fake-Idp-Token': token } }), environment)).rejects.toMatchObject({ code: 'fake_idp_not_allowed' })
  }
})
it('Identity confirmations cannot be reused across databases', async () => {
  const kernel = new KernelRegistry(sample)
  const actor = await kernel.requireActor(bearer('synthetic-owner-a'), runtime())
  const otherDatabase = new Proxy(env.DB, { get(target, key) { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value } })
  await expect(kernel.identity.linkExternalIdentity({ ...runtime(), DB: otherDatabase }, kernel.config, { userId: 'owner-a', external: external(), confirmation: actor })).rejects.toMatchObject({ code: 'verified_session_required' })
})
it('login providers must declare their Identity dependency even if they claim the identity contract themselves', () => {
  const bundled: pluginWorkbasePlugin = { name: 'bundled', version: '1', provides: { identity: '1.x', login: '1.x' }, authenticate: () => null }
  expect(() => new KernelRegistry({ ...sample, plugins: [bundled] })).toThrow(/login requires identity/i)
})

it.each([false, true])('mixed login composition accepts either sole claimant through Identity, reversed=%s', async reversed => {
  const { adapter, plugin } = fake()
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','external-owner','now')").run()
  const logins = reversed ? [plugin, pluginlocalAuth] : [pluginlocalAuth, plugin]
  const kernel = new KernelRegistry({ ...sample, plugins: [...sample.plugins!.filter(p => !p.provides?.login), ...logins] })
  for (const proof of [bearer('synthetic-owner-a'), bearer(adapter.issue(external()))]) {
    const actor = await kernel.requireActor(proof, runtime())
    expect(actor.user!.id).toBe('owner-a')
    expect((await requireScope(actor, 'org-a', kernel.config)).actor.id).toBe('owner-a')
  }
})
it('unbound configs throw across CRUD, policy, workflow and authenticated scope paths', async () => {
  const kernel = new KernelRegistry(sample)
  const actor = await kernel.requireActor(bearer('synthetic-owner-a'), runtime())
  const scope = await requireScope(actor, 'org-a', kernel.config)
  expect(() => crudRoutes(new Hono<AppEnv>(), sample, runtime())).toThrow('Unbound instance config')
  expect(() => canManageAccountAssignments(sample, scope, [])).toThrow('Unbound instance config')
  expect(() => workflowRoutes(new Hono<AppEnv>(), sample, runtime(), new Map())).toThrow('Unbound instance config')
  await expect(requireScope(actor, 'org-a', sample)).rejects.toThrow('Unbound instance config')
  expect(() => scopeMiddleware(runtime(), sample)).toThrow('Unbound instance config')
  expect(() => scopeMiddleware(runtime())).toThrow('bound kernel')
})

it('public resolveActor rejects a retained Better Auth bearer in an IdP-only composition', async () => {
  const app = createApp(sample, runtime())
  await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner.a@example.test' }) })
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").first<string>('body')
  const response = await app.request(url!)
  const request = bearer(response.headers.get('set-auth-token')!)
  const local = new KernelRegistry(sample)
  expect((await requireScope(await resolveActor(request, runtime(), local.config), 'org-a', local.config)).role).toBe('owner')
  const { plugin } = fake()
  const kernel = new KernelRegistry(composition(plugin))
  await expect(resolveActor(request, runtime(), kernel.config)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
})
it('public resolveActor requires a bound config', async () => {
  await expect(resolveActor(bearer('synthetic-owner-a'), runtime())).rejects.toThrow(/bound.*config/i)
  await expect(resolveActor(bearer('synthetic-owner-a'), runtime(), sample)).rejects.toThrow('Unbound instance config')
})

it('a verified IdP actor cannot confirm another external identity link', async () => {
  const { adapter, plugin } = fake()
  const kernel = new KernelRegistry(composition(plugin))
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','external-owner','now')").run()
  const actor = await kernel.requireActor(bearer(adapter.issue(external())), runtime())
  await expect(kernel.identity.linkExternalIdentity(runtime(), kernel.config, { userId: 'owner-a', external: external('new-subject'), confirmation: actor })).rejects.toMatchObject({ status: 403, code: 'identity_link_not_allowed' })
  expect(await env.DB.prepare("SELECT count(*) n FROM identities WHERE subject='new-subject'").first('n')).toBe(0)
})
it('Identity accepts a local email claim case-insensitively', async () => {
  const claim: pluginWorkbasePlugin = { name: 'case-login', version: '1', provides: { login: '1.x' }, requires: { identity: '^1' }, authenticate: () => ({ actor: { type: 'user', id: 'owner-a' }, user: { id: 'owner-a', email: 'OWNER.A@EXAMPLE.TEST' }, organizations: [] }) }
  expect((await new KernelRegistry(composition(claim)).requireActor(bearer('anything'), runtime())).user!.id).toBe('owner-a')
})
