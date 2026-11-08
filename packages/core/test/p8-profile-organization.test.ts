import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import accounts from './fixtures/accounts/config'
import { createApp } from '../src/app'
import { capabilities } from '../src/capabilities'
import { resolveActor, requireScope } from '../src/authorization'
import { KernelRegistry } from '../src/kernel/registry'
import { sha256 } from '../src/crypto'
import { FakeIdpAdapter, idpAuth } from '../../plugins/idp-auth/src/fake'
import { json, request, runtime, setup } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })
it('self profile needs authentication, not membership, and authentication never completes names', async () => {
  const app = createApp(sample, runtime())
  expect((await app.request('http://localhost/me/profile')).status).toBe(401)
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='viewer-a'").run()
  const response = await request(app, '/me/profile', 'GET', undefined, 'viewer-a')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await json(response)).toMatchObject({ email: 'viewer.a@example.test', firstName: null, lastName: null, displayName: 'viewer-a', authority: { kind: 'local' }, capabilities: { canEditNames: true, canEditEmail: false }, completeness: { complete: false, missingFields: ['firstName', 'lastName'] } })
  const saved = await json(await request(app, '/me/profile', 'PATCH', { firstName: '  Ada ', lastName: ' Lovelace  ' }, 'viewer-a'))
  expect(saved).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace', completeness: { complete: true, missingFields: [] } })
  expect(await json(await request(app, '/me/profile', 'GET', undefined, 'viewer-a'))).toEqual(saved)
  expect(await env.DB.prepare('SELECT name FROM "user" WHERE id=?').bind('viewer-a').first('name')).toBe('Ada Lovelace')
})
it.each([{ firstName: '', lastName: 'Name' }, { firstName: '  ', lastName: 'Name' }, { firstName: 'Ada', lastName: 'L'.repeat(201) }, { firstName: 'Ada', lastName: 'Love\nLace' }, { firstName: 'Ada' }, { firstName: 'Ada', lastName: 'Lovelace', email: 'changed@example.test' }, { firstName: 'Ada', lastName: 'Lovelace', userId: 'owner-b' }])('rejects invalid or immutable profile input %j', async body => {
  const app = createApp(sample, runtime())
  const before = await json(await request(app, '/me/profile'))
  const response = await request(app, '/me/profile', 'PATCH', body)
  expect(response.status).toBe(400)
  expect(await json(response)).toEqual({ error: 'validation_error' })
  expect(await json(await request(app, '/me/profile'))).toEqual(before)
})
it('mixed login follows the linked user authority even through a local session; fake IdP sync persists names', async () => {
  const adapter = new FakeIdpAdapter()
  const config = { ...sample, plugins: [...sample.plugins!, idpAuth({ mode: 'test', adapter })] }
  const app = createApp(config, runtime())
  await env.DB.prepare("INSERT INTO identities VALUES ('viewer-a','fake','https://idp.example.test','external-viewer','now')").run()
  const read = await json(await request(app, '/me/profile', 'GET', undefined, 'viewer-a'))
  expect(read).toMatchObject({ authority: { kind: 'idp', provider: 'fake', synchronization: adapter.synchronization }, capabilities: { canEditNames: false }, completeness: { complete: false } })
  const blocked = await request(app, '/me/profile', 'PATCH', { firstName: 'Local', lastName: 'Overwrite' }, 'viewer-a')
  expect(blocked.status).toBe(403)
  expect(await json(blocked)).toEqual({ error: 'profile_read_only' })
  expect(await json(await request(app, '/me/profile'))).toMatchObject({ authority: { kind: 'local' }, capabilities: { canEditNames: true } })
  const token = adapter.issue({ provider: 'fake', issuer: 'https://idp.example.test', subject: 'external-viewer', email: 'viewer.a@example.test', emailVerified: true, firstName: '  Grace ', lastName: ' Hopper ' })
  const response = await app.request('http://localhost/me/profile', { headers: { 'X-Fake-Idp-Token': token } })
  expect(await json(response)).toMatchObject({ firstName: 'Grace', lastName: 'Hopper', displayName: 'Grace Hopper', completeness: { complete: true } })
})
it('rename requires a live organization management grant and refreshes Me labels', async () => {
  const app = createApp(sample, runtime())
  for (const [user, org] of [['viewer-a', 'org-a'], ['dispatcher-a', 'org-a'], ['owner-b', 'org-a']]) expect((await request(app, `/organizations/${org}`, 'PATCH', { name: 'Forbidden' }, user, org)).status).toBe(403)
  for (const body of [{ name: '  ' }, { name: 'x'.repeat(201) }, { name: 'Valid', id: 'org-b' }]) expect((await request(app, '/organizations/org-a', 'PATCH', body)).status).toBe(400)
  const renamed = await request(app, '/organizations/org-a', 'PATCH', { name: '  Renamed organization  ' })
  expect(renamed.status).toBe(200)
  expect(await json(renamed)).toEqual({ id: 'org-a', name: 'Renamed organization', invalidates: ['me', 'memberships', 'selectedOrganization'] })
  expect(await json(await request(app, '/me'))).toMatchObject({ memberships: [{ organization_id: 'org-a', name: 'Renamed organization', role: 'owner' }] })
  expect(await env.DB.prepare("SELECT name FROM organizations WHERE id='org-b'").first('name')).toBe('Organization B')
  expect((await request(app, '/orgs/org-a', 'PATCH', { name: 'Legacy alias' })).status).toBe(200)
})
it('health detects an invalid deploy manifest without gating profile writes', async () => {
  const app = createApp(sample, { ...runtime(), SCHEMA_EXPECTED: '{}' })
  const response = await request(app, '/me/profile', 'PATCH', { firstName: 'Ada', lastName: 'Lovelace' })
  expect(response.status).toBe(200)
  expect((await app.request('/health')).status).toBe(503)
  const kernel = new KernelRegistry(sample)
  expect(kernel.migrations.some(m => m.name === 'identity/001_profiles')).toBe(true)
})
it('the configured Policy graph administrator can rename even when creation is disabled', async () => {
  const app = await setup(accounts)
  await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256('synthetic-administrator'), 'administrator', new Date(Date.now() + 86400000).toISOString()).run()
  expect((await request(app, '/organizations/org-a', 'PATCH', { name: 'Renamed practice' }, 'administrator')).status).toBe(200)
  expect((await request(app, '/orgs', 'POST', { name: 'Creation stays disabled' }, 'administrator')).status).toBe(403)
})
it('linked IdP authority never treats a previous local profile as a synchronized complete profile', async () => {
  const app = createApp(sample, runtime())
  expect((await request(app, '/me/profile', 'PATCH', { firstName: 'Local', lastName: 'Name' })).status).toBe(200)
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','linked-later','now')").run()
  expect(await json(await request(app, '/me/profile'))).toMatchObject({ firstName: null, lastName: null, authority: { kind: 'idp', synchronization: null }, completeness: { complete: false }, syncedAt: null })
})
it('multiple external authorities fail closed rather than selecting by order', async () => {
  const app = createApp(sample, runtime())
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','a','https://a.example.test','a','now'),('owner-a','b','https://b.example.test','b','now')").run()
  const response = await request(app, '/me/profile')
  expect(response.status).toBe(409)
  expect(await json(response)).toEqual({ error: 'profile_authority_ambiguous' })
})
it('profile migration preserves populated legacy users and never guesses first/last names', async () => {
  const kernel = new KernelRegistry(sample)
  await env.DB.prepare('DROP TABLE identity_profiles').run()
  await env.DB.prepare("DELETE FROM _plugin_migrations WHERE namespace='identity'").run()
  const before = (await env.DB.prepare('SELECT * FROM "user" ORDER BY id').all()).results
  await kernel.applyMigrations(env.DB)
  await kernel.applyMigrations(env.DB)
  expect((await env.DB.prepare('SELECT * FROM "user" ORDER BY id').all()).results).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM identity_profiles').first('n')).toBe(0)
})
it('self profile stays available without Members, Organizations or Permissions; organization rename fails without Permissions', async () => {
  const minimal = { ...sample, plugins: sample.plugins!.filter(p => p.provides?.identity || p.provides?.login) }
  const app = createApp(minimal, runtime())
  expect((await request(app, '/me/profile', 'PATCH', { firstName: 'Personal', lastName: 'Settings' })).status).toBe(200)
  const noPermissions = createApp({ ...minimal, plugins: [...minimal.plugins!, sample.plugins!.find(p => p.provides?.organizations)!] }, runtime())
  expect((await request(noPermissions, '/organizations/org-a', 'PATCH', { name: 'Denied' })).status).toBe(403)
})
it('a removed manager loses rename access immediately and path/header mismatch cannot select another organization', async () => {
  const app = createApp(sample, runtime())
  expect((await request(app, '/organizations/org-b', 'PATCH', { name: 'Denied' })).status).toBe(403)
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='owner-a'").run()
  expect((await request(app, '/organizations/org-a', 'PATCH', { name: 'Denied' })).status).toBe(403)
})
it('cookie-authenticated profile and canonical rename writes require same-origin JSON provenance', async () => {
  const app = createApp(sample, runtime())
  for (const path of ['/me/profile', '/organizations/org-a']) {
    const response = await app.request(`http://localhost${path}`, { method: 'PATCH', headers: { Cookie: '__Host-workbase.session=synthetic', 'Content-Type': 'application/json', Origin: 'https://foreign.example.test' }, body: JSON.stringify({ firstName: 'Unsafe', lastName: 'Request', name: 'Unsafe' }) })
    expect(response.status).toBe(403)
    expect(await json(response)).toEqual({ error: 'csrf_failed' })
  }
})
it('ambiguous credentials cannot synchronize profile data before authentication succeeds', async () => {
  const adapter = new FakeIdpAdapter()
  const app = createApp({ ...sample, plugins: [...sample.plugins!, idpAuth({ mode: 'test', adapter })] }, runtime())
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','ambiguous','now')").run()
  const token = adapter.issue({ provider: 'fake', issuer: 'https://idp.example.test', subject: 'ambiguous', email: 'owner.a@example.test', emailVerified: true, firstName: 'Should', lastName: 'Not persist' })
  const response = await request(app, '/me/profile', 'GET', undefined, 'owner-a', 'org-a', { 'X-Fake-Idp-Token': token })
  expect(response.status).toBe(401)
  expect(await json(response)).toEqual({ error: 'ambiguous_login' })
  expect(await env.DB.prepare("SELECT count(*) n FROM identity_profiles WHERE user_id='owner-a'").first('n')).toBe(0)
})
it('profile persistence rechecks linking authority atomically and rolls back a lost authority race', async () => {
  const kernel = new KernelRegistry(sample)
  let linked = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!linked) {
        linked = true
        await target.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','race','now')").run()
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(kernel.identity.updateProfile({ ...runtime(), DB: db }, kernel.config, 'owner-a', { firstName: 'Lost', lastName: 'Authority' })).rejects.toMatchObject({ status: 409, code: 'profile_conflict' })
  expect(await env.DB.prepare("SELECT count(*) n FROM identity_profiles WHERE user_id='owner-a'").first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT name FROM "user" WHERE id=?').bind('owner-a').first('name')).toBe('owner-a')
})
it('machine credentials cannot read or mutate personal profiles or rename organizations', async () => {
  const app = createApp(sample, runtime())
  const issued = await json(await request(app, '/orgs/org-a/tokens', 'POST', { name: 'Profile denial probe', role: 'owner' }))
  expect(issued.token).toEqual(expect.any(String))
  const headers = { Authorization: `Bearer ${issued.token}` }
  for (const [path, method, body] of [
    ['/me/profile', 'GET', undefined],
    ['/me/profile', 'PATCH', { firstName: 'Agent', lastName: 'Denied' }],
    ['/organizations/org-a', 'PATCH', { name: 'Agent denied' }],
  ] as const) expect((await request(app, path, method, body, 'owner-a', 'org-a', headers)).status).toBe(403)
})

it.each(['owner-a', 'dispatcher-a', 'viewer-a'])('rename capability matches the installed live endpoint for %s', async user => {
  const app = createApp(sample, runtime())
  const capabilities = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, user))
  const renamed = await request(app, '/organizations/org-a', 'PATCH', { name: 'Capability checked' }, user)
  expect(capabilities.resources['organizations.update']).toBe(renamed.status === 200)
  expect(capabilities.resources['organizations.update']).toBe(user === 'owner-a')
})
it('rename capability is false without Organizations even when Permissions grants the action', async () => {
  const { organizations: _organizations, ...pluginConfig } = sample.pluginConfig ?? {}
  const config = { ...sample, plugins: sample.plugins!.filter(plugin => !plugin.provides?.organizations), pluginConfig }
  const installed = new KernelRegistry(sample)
  const resolved = await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), installed.config)
  const scope = await requireScope(resolved, 'org-a', installed.config)
  const document = capabilities(new KernelRegistry(config), scope)
  expect(document.resources['organizations.update']).toBe(false)
})
