import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { createServer } from '../src/server'
import { configSource } from '../src/storage'
import { prepare } from '../src/planning'
import type { Change } from '../src/schemas'

const rule = { where: { name: { eq: 'Visible' } }, deny: 'forbidden' as const, fields: ['id', 'name'] }
const config = defineInstance({
  id: 'demo', revision: 1, roles: ['owner', 'viewer', 'reviewer'],
  entities: { assets: { fields: { name: { type: 'string' } } }, orders: { fields: { name: { type: 'string' } } } },
  permissions: { owner: { assets: ['read'] }, viewer: {}, reviewer: {} },
  policies: { assets: { owner: 'all', reviewer: rule } },
  organizationPermissions: { owner: ['members.read'], reviewer: ['members.read'] },
})
let root: string
let application: Awaited<ReturnType<typeof createServer>>
let client: Client
beforeEach(async () => {
  root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-entity-policies-')))
  await mkdir(join(root, 'migrations'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(root, 'config.ts'), configSource(config))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(config))
  application = await createServer({ root })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'entity-policies-contract', version: '1' })
  await application.server.connect(b)
  await client.connect(a)
})
afterEach(async () => {
  await client?.close(); await application?.server.close()
  cleanupTempDir(root)
})
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  return response.structuredContent as Record<string, any>
}
async function accepted(name: string, args: Record<string, unknown>) {
  const result = await call(name, args)
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result)}`)
  return result
}
const propose = (changes: Change[]) => accepted('propose_change', { instance: 'demo', baseRevision: 1, changes })
async function promote(changes: Change[]) {
  const { proposalId } = await propose(changes)
  await accepted('validate', { proposalId })
  await accepted('preview_migration', { proposalId })
  await accepted('apply_to_disposable', { proposalId })
  await accepted('promote', { proposalId, expectedRevision: 1 })
  return (await application.store.load('demo')).config
}

it('add_entity policies round-trip through real disposable verification and promoted config', async () => {
  const policies = { owner: 'all' as const, viewer: 'none' as const, reviewer: rule }
  const promoted = await promote([{ kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } },
    permissions: { owner: ['read', 'create', 'update', 'delete'] }, policies }])
  expect(promoted.policies).toEqual({ ...config.policies, customers: policies })
})

it('set_policy changes existing entities and preserves other roles through promotion', async () => {
  const promoted = await promote([
    { kind: 'set_policy', entity: 'orders', role: 'reviewer', policy: rule },
    { kind: 'set_policy', entity: 'assets', role: 'owner', policy: 'none' },
    { kind: 'set_policy', entity: 'assets', role: 'viewer', policy: 'all' },
  ])
  expect(promoted.policies).toEqual({ assets: { owner: 'none', viewer: 'all', reviewer: rule }, orders: { reviewer: rule } })
})

it('set_policy can follow add_entity in the same proposal', () => {
  expect(prepare(config, [], [
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } } },
    { kind: 'set_policy', entity: 'customers', role: 'reviewer', policy: 'all' },
  ]).target.policies.customers).toEqual({ reviewer: 'all' })
})

it.each(['add_entity', 'set_policy'] as const)('%s returns a structured planner error for an undeclared policy role', async kind => {
  const change = kind === 'add_entity'
    ? { kind, entity: 'customers', fields: {}, policies: { unknown: 'all' } }
    : { kind, entity: 'assets', role: 'unknown', policy: 'all' }
  expect(await call('propose_change', { instance: 'demo', baseRevision: 1, changes: [change] })).toEqual({
    ok: false, error: { code: 'unknown_role', status: 400, message: `Unknown policy role: ${change.entity}.unknown` },
  })
})

it('set_policy returns a structured planner error for an unknown entity', async () => {
  expect(await call('propose_change', { instance: 'demo', baseRevision: 1,
    changes: [{ kind: 'set_policy', entity: 'customers', role: 'owner', policy: 'all' }] })).toEqual({
    ok: false, error: { code: 'unknown_entity', status: 400, message: 'Unknown entity: customers' },
  })
})

it('inspect_schema exposes effective none for omitted roles and entities and preserves explicit rules', async () => {
  expect((await accepted('inspect_schema', { instance: 'demo' })).policies).toEqual({
    assets: { owner: 'all', viewer: 'none', reviewer: rule, member: 'none' },
    orders: { owner: 'none', viewer: 'none', reviewer: 'none', member: 'none' },
  })
})

it('inspect_schema exposes organizationPermissions unchanged', async () => {
  expect((await accepted('inspect_schema', { instance: 'demo' })).organizationPermissions).toEqual(config.organizationPermissions)
})

type AddEntity = Extract<Change, { kind: 'add_entity' }>
const warning = (role: string, entity = 'customers') => `${entity}.${role} grants permissions but its effective policy is 'none'; use set_policy to configure it.`
const cases: { name: string; permissions?: AddEntity['permissions']; policies?: AddEntity['policies']; warnings: string[] }[] = [
  { name: 'permissions with omitted policies', permissions: { owner: ['read'] }, warnings: [warning('owner')] },
  { name: 'permissions with an omitted role policy', permissions: { owner: ['update'] }, policies: { viewer: 'all' }, warnings: [warning('owner')] },
  { name: 'permissions with explicit none', permissions: { owner: ['delete'] }, policies: { owner: 'none' }, warnings: [warning('owner')] },
  { name: 'permissions with all', permissions: { owner: ['read'] }, policies: { owner: 'all' }, warnings: [] },
  { name: 'permissions with a rule', permissions: { owner: ['read'] }, policies: { owner: rule }, warnings: [] },
  { name: 'omitted permissions and policies', warnings: [] },
  { name: 'empty permissions with none', permissions: { owner: [] }, policies: { owner: 'none' }, warnings: [] },
  { name: 'a different role with create permission', permissions: { viewer: ['create'] }, policies: { owner: 'all' }, warnings: [warning('viewer')] },
  { name: 'two roles with permissions and none', permissions: { owner: ['read'], viewer: ['read'] }, warnings: [warning('owner'), warning('viewer')] },
]
it.each(cases)('validate warns exactly for $name', async ({ permissions, policies, warnings }) => {
  const { proposalId } = await propose([{ kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } },
    ...(permissions ? { permissions } : {}), ...(policies ? { policies } : {}) }])
  expect(await call('validate', { proposalId })).toEqual({ ok: true, errors: [], revision: 2, warnings })
})

it('validate warns for an existing entity whose policy is set to none', async () => {
  const { proposalId } = await propose([{ kind: 'set_policy', entity: 'assets', role: 'owner', policy: 'none' }])
  expect(await call('validate', { proposalId })).toEqual({ ok: true, errors: [], revision: 2, warnings: [warning('owner', 'assets')] })
})
