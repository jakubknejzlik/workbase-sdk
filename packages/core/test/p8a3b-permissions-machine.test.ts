import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import { identity as pluginidentity } from '@workbasehq/plugins/identity'
import { machineCredentials as pluginmachineCredentials } from '@workbasehq/plugins/machine-credentials'
import { members as pluginmembers } from '@workbasehq/plugins/members'
import { permissions as pluginpermissions } from '@workbasehq/plugins/permissions'
import { idpAuth, FakeIdpAdapter } from '../../plugins/idp-auth/src/fake'
import { canGrantRole } from '../src/execution/permissions'
import { insertDomain, json, request, runtime, setup } from '@workbasehq/test-support/helpers'

const permissions = pluginpermissions
const machine = () => [pluginmachineCredentials()]
const roles = ['owner', 'dispatcher', 'viewer']
beforeEach(async () => { await setup(); await insertDomain() })

it('Permissions owns role definitions and built-ins, projected before whole-model validation', () => {
  const { roles: _roles, organizationOwnerRole: _owner, ...input } = sample
  const provider = permissions({ roles })
  const config = defineInstance({ ...input, plugins: [provider], interactive: false } as any)
  expect(provider.name).toBe('permissions')
  expect(config.roles).toEqual([...roles, 'member'])
  expect(config.organizationOwnerRole).toBe('owner')
  expect(provider.configuration).toMatchObject({ roles, ownerRole: 'owner' })
  expect(new KernelRegistry(config).permissionsActive).toBe(true)
})
it('Permissions grants by subset independently of the configured owner name', () => {
  const config = defineInstance({ ...sample, plugins: [permissions({ roles: ['lead', 'senior', 'junior'], ownerRole: 'lead' })], interactive: false,
    permissions: {}, policies: {}, organizationPermissions: {},
  })
  expect(config.roles).toEqual(['lead', 'senior', 'junior', 'member'])
  expect(config.organizationOwnerRole).toBe('lead')
  expect(canGrantRole(config, 'lead', 'senior')).toBe(true)
  expect(canGrantRole(config, 'junior', 'lead')).toBe(true)
})
it.each([
  { roles: ['owner', 'owner'] },
  { roles: ['viewer'], ownerRole: 'missing' },
  { roles: [] },
])('Permissions rejects invalid role definitions: %j', options => {
  expect(() => new KernelRegistry({ ...sample, plugins: [permissions(options)], interactive: false })).toThrow()
})
it('Members rejects a role absent from Permissions and requires its contract', async () => {
  const app = createApp(sample, runtime())
  expect((await request(app, '/orgs/org-a/members/viewer-a', 'PATCH', { role: 'unknown' })).status).toBe(400)
  expect(() => new KernelRegistry({ ...sample, plugins: [pluginidentity, pluginmembers], interactive: false })).toThrow(/permissions/)
})
it('machine credentials are independently packaged and require Identity, Members and Permissions', () => {
  expect(machine()).toHaveLength(1)
  expect(machine()[0].provides).toEqual({ 'machine-credentials': '1.x' })
  expect(machine()[0].requires).toEqual({ identity: '^1', members: '^1', permissions: '^1' })
  expect(() => new KernelRegistry({ ...sample, plugins: machine(), interactive: false })).toThrow(/missing/)
})
async function idpOnly() {
  await env.DB.prepare("INSERT INTO identities VALUES ('owner-a','fake','https://idp.example.test','external-owner','now')").run()
  const adapter = new FakeIdpAdapter()
  const token = adapter.issue({ provider: 'fake', issuer: 'https://idp.example.test', subject: 'external-owner', email: 'owner.a@example.test', emailVerified: true })
  const config = { ...sample, plugins: [...sample.plugins!.filter(p => !p.provides?.login && !p.provides?.['machine-credentials']), idpAuth({ mode: 'test', adapter }), ...machine()] }
  const app = createApp(config, runtime())
  const owner = (path: string, method = 'GET', body?: unknown) => request(app, path, method, body, 'unused', 'org-a', { Authorization: '', 'X-Fake-Idp-Token': token })
  return { config, app, owner, token }
}
it('IdP-only login issues and revokes machine credentials, enforcing live issuer role and operation limits', async () => {
  const { app, owner } = await idpOnly()
  const issued = await owner('/orgs/org-a/tokens', 'POST', { name: 'IdP automation', role: 'owner', operations: ['clients.read', 'clients.create'] })
  expect(issued.status).toBe(201)
  const credential = await json(issued)
  const agent = (path: string, method = 'GET', body?: unknown) => request(app, path, method, body, 'unused', 'org-a', { Authorization: `Bearer ${credential.token}` })
  expect((await agent('/api/clients')).status).toBe(200)
  expect((await agent('/api/clients', 'POST', { name: 'Allowed' })).status).toBe(201)
  expect((await agent('/api/jobs')).status).toBe(403)
  await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='owner-a'").run()
  expect((await agent('/api/clients', 'POST', { name: 'Denied' })).status).toBe(403)
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='owner-a'").run()
  expect((await owner(`/orgs/org-a/tokens/${credential.id}`, 'DELETE')).status).toBe(204)
  expect((await agent('/api/clients')).status).toBe(401)
  const events = (await env.DB.prepare("SELECT payload FROM audit_outbox WHERE payload LIKE '%access_token.%'").all<{ payload: string }>()).results
  expect(events).toHaveLength(2)
  for (const event of events) {
    expect(event.payload).not.toContain(credential.token)
    expect(event.payload).not.toContain('token_hash')
    expect(JSON.parse(event.payload)).toMatchObject({ actor: { type: 'user', id: 'owner-a' }, organization_id: 'org-a' })
  }
})
it('removing Machine Credentials disables issuance and existing tokens while retaining rows', async () => {
  const app = createApp(sample, runtime())
  const issued = await request(app, '/orgs/org-a/tokens', 'POST', { name: 'Retained', role: 'viewer' })
  expect(issued.status).toBe(201)
  const credential = await json(issued)
  const config = { ...sample, plugins: sample.plugins!.filter(p => !p.provides?.['machine-credentials']) }
  const without = createApp(config, runtime())
  expect((await request(without, '/orgs/org-a/tokens', 'POST', { name: 'Denied', role: 'viewer' })).status).toBe(404)
  expect((await request(without, '/api/clients', 'GET', undefined, 'unused', 'org-a', { Authorization: `Bearer ${credential.token}` })).status).toBe(401)
  expect(await env.DB.prepare('SELECT count(*) n FROM access_tokens WHERE id=?').bind(credential.id).first('n')).toBe(1)
})
it('machine authentication and an IdP claiming the same request are ambiguous', async () => {
  const { app, owner, token } = await idpOnly()
  const issued = await owner('/orgs/org-a/tokens', 'POST', { name: 'Collision', role: 'viewer' })
  expect(issued.status).toBe(201)
  const credential = await json(issued)
  const response = await request(app, '/api/clients', 'GET', undefined, 'unused', 'org-a', { Authorization: `Bearer ${credential.token}`, 'X-Fake-Idp-Token': token })
  expect(await json(response)).toEqual({ error: 'ambiguous_login' })
})

it('only the Permissions provider can contribute role definitions', () => {
  expect(() => new KernelRegistry({ ...sample, plugins: [
    { name: 'domain', version: '1', configure: () => ({ roles: ['attacker'], organizationOwnerRole: 'attacker' }) },
  ], interactive: false })).toThrow(/permissions/)
})
it('adopts populated machine credentials through namespaced migrations and retains them on uninstall', async () => {
  const legacy = { ...sample, plugins: sample.plugins!.filter(p => !p.provides?.['machine-credentials']) }
  await setup(legacy)
  await env.DB.prepare("INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,operations,expires_at,created_at) VALUES ('retained','org-a','owner-a','Existing integration','retained-hash','wb_retained','viewer','[\"clients.read\"]','2099-01-01','now')").run()
  const before = await env.DB.prepare('SELECT * FROM access_tokens').all()
  const kernel = new KernelRegistry({ ...sample, plugins: [...sample.plugins!].reverse() })
  await kernel.applyMigrations(env.DB)
  await kernel.applyMigrations(env.DB)
  expect((await env.DB.prepare('SELECT * FROM access_tokens').all()).results).toEqual(before.results)
  expect(await env.DB.prepare("SELECT count(*) n FROM _plugin_migrations WHERE namespace='machine-credentials'").first('n')).toBe(1)
  expect(kernel.plugins.findIndex(p => p.name === 'members')).toBeLessThan(kernel.plugins.findIndex(p => p.name === 'machine-credentials'))
  await new KernelRegistry(legacy).applyMigrations(env.DB)
  expect((await env.DB.prepare('SELECT * FROM access_tokens').all()).results).toEqual(before.results)
})
it('Permissions adds the configured owner and member without default organization grants', () => {
  const provider = permissions({ roles: ['specialist'] })
  const config = defineInstance({ id: 'custom_roles', revision: 1, entities: {}, permissions: {}, plugins: [provider], interactive: false })
  expect(config.roles).toEqual(['specialist', 'owner', 'member'])
  expect(config.organizationOwnerRole).toBe('owner')
  expect(canGrantRole(config, 'specialist', 'owner')).toBe(false)
  expect(config.organizationPermissions.owner).toEqual([])
})
it.each(['identity', 'organizations', 'permissions'])('rejects explicit null configuration for %s', name => {
  expect(() => new KernelRegistry({ ...sample, pluginConfig: { ...sample.pluginConfig, [name]: null } })).toThrow()
})
