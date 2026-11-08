import { expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import secondary from '../../../core/test/fixtures/sample/secondary'
import accounts from '../../../core/test/fixtures/accounts/config'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { organizations } from '../src'
import { request, setup } from '@workbasehq/test-support/helpers'

it.each([sample, secondary, accounts])('SR-28 $id rejects the empty instance scope without deleting migration data', async config => {
  await setup(config)
  const kernel = new KernelRegistry(config)
  expect(await env.DB.prepare("SELECT scope_id FROM organization_scopes WHERE scope_id='instance'").first('scope_id')).toBe('instance')
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE organization_id='instance'").first('n')).toBe(0)
  expect(await organizations.resolveScopeId!(env.DB, 'instance')).toBeNull()
  await expect(kernel.resolveScopeId(env.DB, 'instance')).rejects.toMatchObject({ status: 403, code: 'organization_required' })
  expect(await kernel.resolveScopeId(env.DB, 'org-a')).toBe('org-a')
  expect(await organizations.resolveScopeId!(env.DB)).toBeNull()
  expect(await organizations.resolveScopeId!(env.DB, 'missing')).toBeNull()
  // Ordinary organizations remain resolvable before their first membership.
  await env.DB.prepare("INSERT INTO organizations (id,name) VALUES ('empty-org','Empty organization')").run()
  expect(await kernel.resolveScopeId(env.DB, 'empty-org')).toBe('empty-org')
})

it('SR-28 resolves instance only while a live membership exists and still enforces the selected actor membership', async () => {
  const app = await setup(sample)
  const kernel = new KernelRegistry(sample)
  await env.DB.prepare("INSERT INTO memberships (user_id,organization_id,role) VALUES ('owner-a','instance','owner')").run()
  expect(await kernel.resolveScopeId(env.DB, 'instance')).toBe('instance')
  expect((await request(app, '/orgs/instance/members', 'GET', undefined, 'owner-a', 'instance')).status).toBe(200)
  expect((await request(app, '/orgs/instance/members', 'GET', undefined, 'viewer-a', 'instance')).status).toBe(403)
  await env.DB.prepare("DELETE FROM memberships WHERE organization_id='instance'").run()
  await expect(kernel.resolveScopeId(env.DB, 'instance')).rejects.toMatchObject({ status: 403, code: 'organization_required' })
  const response = await request(app, '/orgs/instance/members', 'GET', undefined, 'owner-a', 'instance')
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'organization_required' })
  // /me is also the console organization picker's data source.
  expect(await (await request(app, '/me')).json()).toMatchObject({ memberships: [{ organization_id: 'org-a', name: 'Organization A', role: 'owner' }] })
})

it('SR-28 Organizations resolves scopes without the optional Members plugin', async () => {
  const config = { ...sample, plugins: sample.plugins!.filter(plugin => !['members', 'machine-credentials'].includes(plugin.name)) }
  await setup(config)
  // The check must work with the base memberships table, without members/001_scopes.
  await env.DB.prepare("INSERT INTO organizations (id,name) VALUES ('instance','Instance')").run()
  expect(await organizations.resolveScopeId!(env.DB, 'instance')).toBeNull()
  await env.DB.prepare("INSERT INTO memberships (user_id,organization_id,role) VALUES ('owner-a','instance','owner')").run()
  expect(await organizations.resolveScopeId!(env.DB, 'instance')).toBe('instance')
})
