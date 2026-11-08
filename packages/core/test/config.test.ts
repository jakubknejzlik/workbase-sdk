import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { bodyValidator, defineInstance, organizationActions, defaultOrganizationPermissions } from '../src/config'
import { initialSchema } from '../src/migrations/schema'
import sample from './fixtures/sample/config'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { permissions } from '@workbasehq/plugins/permissions'
import { sha256 } from '../src/crypto'
import type { InstanceConfig } from '../src/config'
import type { WorkbasePlugin } from '../src/kernel/plugin'
declare global {
  interface ImportMeta { glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T> }
}
beforeEach(reset)

it('preserves the runtime default grant table and sparse instance grants', () => {
  expect(defaultOrganizationPermissions).toEqual({
    owner: [...organizationActions],
    dispatcher: ['invitations.create', 'invitations.read', 'invitations.revoke'],
    viewer: [],
  })
  const config = defineInstance({ id: 'runtime_roles', revision: 1,
    roles: ['owner', 'dispatcher', 'viewer', 'administrator', 'unknown'],
    entities: {}, permissions: {}, organizationPermissions: {} })
  expect(config.organizationPermissions).toEqual(defaultOrganizationPermissions)
})

it('merges configured organization grants per role with defaults, while explicit input wins', () => {
  const plugins: WorkbasePlugin[] = [
    { ...permissions({ roles: ['owner', 'dispatcher', 'viewer'] }), configure: () => ({ organizationPermissions: { viewer: ['members.read'] } }) },
  ]
  const input = { id: 'contributed_grants', revision: 1, interactive: false, plugins, roles: ['owner', 'dispatcher', 'viewer'], entities: {}, permissions: {} }
  expect(defineInstance(input).organizationPermissions).toEqual({ owner: [...organizationActions], dispatcher: ['invitations.create', 'invitations.read', 'invitations.revoke'], viewer: ['members.read'] })
  expect(defineInstance({ ...input, organizationPermissions: { viewer: [] } }).organizationPermissions).toEqual({ owner: [...organizationActions], dispatcher: ['invitations.create', 'invitations.read', 'invitations.revoke'], viewer: [] })
})

it('derives real D1 tables and validators from an instance-only field', async () => {
  const extended = defineInstance({ ...sample, entities: { ...sample.entities, jobs: { ...sample.entities.jobs, fields: { ...sample.entities.jobs.fields, extra: { type: 'string', default: 'new' } } } } })
  await env.DB.exec(initialSchema(extended).replaceAll('\n', ' '))
  const columns = await env.DB.prepare('PRAGMA table_info(jobs)').all<{ name: string }>()
  expect(columns.results.map(r => r.name)).toEqual(expect.arrayContaining(['id', 'organization_id', 'created_at', 'updated_at', 'version', 'extra']))
  expect(bodyValidator(extended.entities.jobs).parse({ title: 'Synthetic job', client_id: 'c' }).extra).toBe('new')
  expect(() => bodyValidator(extended.entities.jobs).parse({ title: 3 })).toThrow()
})
it('rejects unsafe identifiers, reserved columns and invalid references', () => {
  expect(() => defineInstance({ ...sample, id: 'bad;DROP' })).toThrow()
  expect(() => defineInstance({ ...sample, entities: { clients: { fields: { id: { type: 'string' } } } } })).toThrow()
  expect(() => defineInstance({ ...sample, entities: { clients: { fields: { other: { type: 'ref', entity: 'missing' } } } } })).toThrow()
})
it('proves changes() chaining and full batch rollback on real D1', async () => {
  await env.DB.exec('CREATE TABLE counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL); CREATE TABLE children (id TEXT PRIMARY KEY, n INTEGER NOT NULL); CREATE TABLE events (id TEXT PRIMARY KEY, payload TEXT NOT NULL); INSERT INTO counters VALUES (\'s\',0);')
  const batch = (id: string, payload: string | null) => env.DB.batch([
    env.DB.prepare('UPDATE counters SET n=n+1 WHERE id=? AND n<1').bind('s'),
    env.DB.prepare('INSERT INTO children SELECT ?,1 WHERE changes()=1').bind(id),
    env.DB.prepare('INSERT INTO events SELECT ?,? WHERE changes()=1').bind(id, payload),
  ])
  await expect(batch('bad', null)).rejects.toThrow()
  expect(await env.DB.prepare('SELECT n FROM counters').first('n')).toBe(0)
  const first = await batch('ok', '{}'); const second = await batch('full', '{}')
  expect(first.map(r => r.meta.changes)).toEqual([1, 1, 1])
  expect(second.map(r => r.meta.changes)).toEqual([0, 0, 0])
  expect(await env.DB.prepare('SELECT count(*) AS n FROM events').first('n')).toBe(1)
})
it('rejects invalid defaults and preserves bounded SQL generation', () => {
  const invalidDefault = { ...sample, entities: { ...sample.entities, clients: { ...sample.entities.clients, fields: { state: { type: 'enum' as const, values: ['open'], default: 'invalid' } } } } }
  expect(() => defineInstance(invalidDefault)).toThrow('Invalid default')
  expect(() => defineInstance({ ...sample, entities: { ...sample.entities, clients: { ...sample.entities.clients, fields: Object.fromEntries(Array.from({ length: 91 }, (_, i) => [`field_${i}`, { type: 'string' as const }])) } } })).toThrow('budget')
})

it('O implicit organization grants are isolated across configs and cannot authorize another config', async () => {
  const { organizationPermissions: _defaults, ...input } = sample
  const a = defineInstance(input)
  const b = defineInstance(input)
  a.organizationPermissions.viewer.push('invitations.create')
  expect(b.organizationPermissions.viewer).toEqual([])
  const { setup, request, json } = await import('@workbasehq/test-support/helpers')
  const app = await setup(b)
  const response = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }, 'viewer-a')
  expect(response.status).toBe(403)
  expect(await json(response)).toEqual({ error: 'permission_denied' })
})
it('O owner-only configs retain implicit owner grants and reject explicit undeclared grants', async () => {
  const config = defineInstance({ plugins: [...sample.plugins!.filter(plugin => !['permissions', 'mail-outbox'].includes(plugin.name)), permissions({ roles: ['owner'] }), mailOutbox()], interactive: true, id: 'owner_only', revision: 1, roles: ['owner'], permissions: { owner: {} }, entities: {} })
  expect(config.organizationPermissions).toEqual({ owner: [...organizationActions] })
  const { setup, request, json } = await import('@workbasehq/test-support/helpers')
  const app = await setup(config)
  expect((await request(app, '/orgs/org-a/members')).status).toBe(200)
  const response = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'owner' })
  expect(response.status).toBe(201)
  expect((await json(response)).role).toBe('owner')
  expect(() => defineInstance({ id: 'owner_only', revision: 1, roles: ['owner'], permissions: { owner: {} }, entities: {}, organizationPermissions: { dispatcher: [] } })).toThrow('Unknown organization role dispatcher')
})

it('C7b validates additive filter kinds and named-view grammar at config load', () => {
  const input = { ...sample, ui: { entities: { jobs: { list: { filter: { title: 'text' as const, client_id: false as const }, views: [{ id: 'open', label: 'viewOpen', where: { title: { contains: 'Case' } } }] } } } } }
  expect(defineInstance(input).ui).toEqual(input.ui)
  for (const list of [
    { filter: { missing: false } }, { filter: { title: 'number' } }, { views: [{ id: 'all', label: 'viewAll', where: {} }] },
    { views: [{ id: 'open', label: 'Open', where: { unknown: { eq: 'x' } } }] },
    { views: [{ id: 'open', label: 'Open', where: { title: { sql: 'x' } } }] },
    { views: [{ id: 'open', label: 'Open', where: {} }, { id: 'open', label: 'Again', where: {} }] },
  ]) expect(() => defineInstance({ ...input, ui: { entities: { jobs: { list } } } } as any)).toThrow(/UI|filter|view/i)
})
