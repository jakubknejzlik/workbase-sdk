import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { createApp } from '@workbasehq/core/app'
import { sha256 } from '@workbasehq/core/crypto'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup({ ...sample, plugins: [identity, localAuth, rbac] }) })
const single = () => ({ ...sample, plugins: [identity, localAuth, rbac, members, mailOutbox()] })
beforeEach(completeInvitationProfiles)
it('Members requires Identity and Permissions, optionally orders Organizations first', () => {
  expect(() => new KernelRegistry({ ...single(), plugins: [identity, localAuth, members] })).toThrow(/permissions/i)
  const kernel = new KernelRegistry({ ...sample, plugins: [members, organizations, rbac, identity, localAuth] })
  expect(kernel.plugins.indexOf(organizations)).toBeLessThan(kernel.plugins.indexOf(members))
  expect(members.requires).toEqual({ identity: '^1', permissions: '^1' })
  expect(members.optionalRequires).toEqual({ organizations: '^1', 'mail-outbox': '^1', console: '^1' })
})
it('single-tenant Members supports invitations with one stable scope and no Organizations', async () => {
  const kernel = new KernelRegistry(single())
  await kernel.applyMigrations(env.DB)
  const scope = await kernel.resolveScopeId(env.DB)
  await env.DB.prepare('INSERT INTO memberships (user_id,organization_id,role) VALUES (?,?,?)').bind('owner-a', scope, 'owner').run()
  const app = createApp(single(), runtime())
  expect((await request(app, '/orgs', 'POST', { name: 'No' })).status).toBe(404)
  const invited = await request(app, `/orgs/${scope}/invitations`, 'POST', { email: 'viewer.a@example.test', role: 'viewer' }, 'owner-a', scope)
  expect(invited.status).toBe(201)
  const raw = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='viewer.a@example.test'").first<string>('body')
  const token = new URL(raw!.replace('Accept: ', '')).searchParams.get('token')
  const accepted = await request(app, '/invitations/accept', 'POST', { token }, 'viewer-a', scope)
  expect(accepted.status).toBe(201)
  expect(await env.DB.prepare('SELECT scope_id FROM memberships WHERE user_id=? AND organization_id=?').bind('viewer-a', scope).first('scope_id')).toBe(scope)
  expect((await request(app, `/orgs/org-a/members`, 'GET', undefined, 'owner-a', 'org-a')).status).toBe(403)
})
it('single-tenant Members exposes only instance in /me and the organization switcher projection', async () => {
  const config = single()
  await new KernelRegistry(config).applyMigrations(env.DB)
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='owner-a'").run()
  await env.DB.prepare("INSERT INTO memberships (user_id,organization_id,role) VALUES ('owner-a','instance','owner'),('owner-a','org-a','viewer')").run()
  const response = await request(createApp(config, runtime()), '/me', 'GET', undefined, 'owner-a', 'instance')
  expect(response.status).toBe(200)
  // useOrganizations and the switcher read the memberships projection of /me.
  expect(await response.json()).toMatchObject({ memberships: [{ organization_id: 'instance', name: 'Instance', role: 'owner' }] })
})
it('adding Organizations preserves populated scope, role and pending invitation; uninstall retains data', async () => {
  const kernel = new KernelRegistry(single())
  await kernel.applyMigrations(env.DB)
  const scope = await kernel.resolveScopeId(env.DB)
  await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind('owner-a', scope, 'owner').run()
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)')
    .bind('pending', scope, 'new@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-a').run()
  const upgraded = new KernelRegistry({ ...sample, plugins: [members, organizations, identity, localAuth, rbac] })
  await upgraded.applyMigrations(env.DB)
  expect(await upgraded.resolveScopeId(env.DB, scope)).toBe(scope)
  expect(await env.DB.prepare('SELECT role,scope_id FROM memberships WHERE user_id=? AND scope_id=?').bind('owner-a', scope).first()).toEqual({ role: 'owner', scope_id: scope })
  expect(await env.DB.prepare('SELECT scope_id FROM invitations WHERE id=?').bind('pending').first('scope_id')).toBe(scope)
  await new KernelRegistry({ ...sample, interactive: false, plugins: [] }).applyMigrations(env.DB)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations WHERE id=?').bind('pending').first('n')).toBe(1)
})
it('Organizations allowCreate=false disables creation while keeping member routes', async () => {
  const config = { ...sample, plugins: [identity, localAuth, rbac, members, organizations], pluginConfig: { organizations: { allowCreate: false } } }
  const kernel = new KernelRegistry(config)
  await kernel.applyMigrations(env.DB)
  const app = createApp(config, runtime())
  expect((await request(app, '/orgs', 'POST', { name: 'No' })).status).toBe(403)
  expect((await request(app, '/orgs/org-a/members')).status).toBe(200)
  expect(await (await request(app, '/me')).json()).toMatchObject({ organizationCreationAllowed: false })
})
it('Members absent leaves no membership or invitation routes despite retained tables', async () => {
  const app = createApp({ ...sample, plugins: [identity, localAuth, rbac, organizations] }, runtime())
  for (const path of ['/orgs/org-a/members', '/orgs/org-a/invitations']) expect((await request(app, path)).status).toBe(404)
  expect((await request(app, '/invitations/accept', 'POST', { token: 'a'.repeat(64) })).status).toBe(404)
})
it('all new membership and invitation rows have non-null scope_id and scopes cannot drift', async () => {
  const kernel = new KernelRegistry({ ...sample, plugins: [identity, localAuth, rbac, members, organizations] })
  await kernel.applyMigrations(env.DB)
  expect(await env.DB.prepare('SELECT count(*) n FROM memberships WHERE scope_id IS NULL OR scope_id<>organization_id').first('n')).toBe(0)
  await expect(env.DB.prepare("UPDATE memberships SET scope_id='other' WHERE user_id='owner-a'").run()).rejects.toThrow()
})
it('a failed Organizations migration preserves the single-tenant scope and pending invitations', async () => {
  const kernel = new KernelRegistry(single())
  await kernel.applyMigrations(env.DB)
  const scope = await kernel.resolveScopeId(env.DB)
  await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind('owner-a', scope, 'owner').run()
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)')
    .bind('rollback-pending', scope, 'viewer.a@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-a').run()
  const failedOrganizations = { ...organizations, migrations: [{ ...organizations.migrations![0], sql: organizations.migrations![0].sql + '; INSERT INTO nonexistent_scope_table VALUES (1);' }] }
  const upgraded = new KernelRegistry({ ...sample, plugins: [identity, localAuth, rbac, members, failedOrganizations] })
  await expect(upgraded.applyMigrations(env.DB)).rejects.toThrow()
  expect(await kernel.resolveScopeId(env.DB)).toBe(scope)
  const app = createApp(single(), runtime())
  expect((await request(app, `/orgs/${scope}/members`, 'GET', undefined, 'owner-a', scope)).status).toBe(200)
  expect((await request(app, '/invitations/accept', 'POST', { token: 'a'.repeat(64) }, 'viewer-a', scope)).status).toBe(201)
  expect(await env.DB.prepare("SELECT count(*) n FROM sqlite_master WHERE name='organization_scopes'").first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT count(*) n FROM _plugin_migrations WHERE namespace='organizations'").first('n')).toBe(0)
})

it.each(['remove', 'demote', 'leave'])('single-tenant last-owner %s remains forbidden', async action => {
  const config = single(); const kernel = new KernelRegistry(config)
  await kernel.applyMigrations(env.DB)
  await env.DB.prepare("INSERT INTO memberships VALUES ('owner-a','instance','owner')").run()
  const app = createApp(config, runtime())
  const response = await request(app, action === 'leave' ? '/orgs/instance/leave' : '/orgs/instance/members/owner-a', action === 'leave' ? 'POST' : action === 'remove' ? 'DELETE' : 'PATCH', action === 'demote' ? { role: 'viewer' } : undefined, 'owner-a', 'instance')
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'last_owner' })
})
it('a single-tenant invitation to A cannot be accepted by B or overwrite B profile', async () => {
  const config = single(); const kernel = new KernelRegistry(config)
  await kernel.applyMigrations(env.DB)
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)')
    .bind('wrong-recipient', 'instance', 'viewer.a@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-a').run()
  const app = createApp(config, runtime())
  const response = await request(app, '/invitations/accept', 'POST', { token: 'a'.repeat(64) }, 'owner-a', 'instance')
  expect(response.status).toBe(403)
  expect(await env.DB.prepare("SELECT accepted_at FROM invitations WHERE id='wrong-recipient'").first('accepted_at')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE scope_id='instance'").first('n')).toBe(0)
})

it('canonical scope filtering preserves existing idempotency receipts; custom filters still require policy receipts', async () => {
  const { needsPolicyReceipt } = await import('../../../core/src/execution/policy-receipts')
  expect(needsPolicyReceipt(new KernelRegistry(single()))).toBe(false)
  expect(needsPolicyReceipt(new KernelRegistry({ ...single(), plugins: [identity, localAuth, rbac, { ...members }] }))).toBe(true)
})

it('single-tenant Members cannot accept an invitation retained from an uninstalled organization scope', async () => {
  const config = single(); const kernel = new KernelRegistry(config)
  await kernel.applyMigrations(env.DB)
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)')
    .bind('retained-foreign-scope', 'org-a', 'new@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-a').run()
  const response = await createApp(config, runtime()).request('http://localhost/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64) }) })
  expect(response.status).toBe(403)
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT accepted_at FROM invitations WHERE id='retained-foreign-scope'").first('accepted_at')).toBeNull()
})
