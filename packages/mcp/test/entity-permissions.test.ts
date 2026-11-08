import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { createServer } from '../src/server'
import { configSource } from '../src/storage'
import { prepare } from '../src/planning'
import { changeSchema, type Change } from '../src/schemas'

const config = defineInstance({
  id: 'demo', revision: 1, roles: ['owner', 'dispatcher', 'viewer', 'auditor'],
  entities: { orders: { fields: { name: { type: 'string' } } } },
  permissions: { owner: { orders: ['read', 'create'] }, dispatcher: {}, viewer: {}, auditor: { orders: ['read'] } },
  policies: { orders: { owner: 'all', auditor: 'all' } },
})
let root: string
let application: Awaited<ReturnType<typeof createServer>>
let client: Client
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-entity-permissions-'))
  await mkdir(join(root, 'migrations'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(root, 'config.ts'), configSource(config))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(config))
  application = await createServer({ root })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'entity-permissions-contract', version: '1' })
  await application.server.connect(b)
  await client.connect(a)
})
afterEach(async () => {
  await client?.close(); await application?.server.close()
  await rm(root, { recursive: true, force: true })
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

it('inspect_schema preserves permissions for custom and built-in roles', async () => {
  expect((await accepted('inspect_schema', { instance: 'demo' })).permissions).toEqual(config.permissions)
})

it('validate warns for a custom role with permissions and an omitted policy', async () => {
  const { proposalId } = await accepted('propose_change', { instance: 'demo', baseRevision: 1, changes: [
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } }, permissions: { auditor: ['read'] } },
  ] })
  expect(await call('validate', { proposalId })).toEqual({ ok: true, errors: [], revision: 2,
    warnings: ["customers.auditor grants permissions but its effective policy is 'none'; use set_policy to configure it."] })
})

it('validate returns the actionable core displayField error for a new listed entity', async () => {
  const { proposalId } = await accepted('propose_change', { instance: 'demo', baseRevision: 1, changes: [
    { kind: 'add_entity', entity: 'zakaznik', fields: { jmeno: { type: 'string', required: true } }, displayField: 'missing', permissions: { auditor: ['read'] } },
  ] })
  expect(await call('validate', { proposalId })).toMatchObject({ ok: false, errors: [{ code: 'invalid_display_field', entity: 'zakaznik', message: expect.stringContaining("Invalid displayField: zakaznik; set displayField: 'jmeno'"), suggestedChange: { kind: 'set_display_field', entity: 'zakaznik', displayField: 'jmeno' } }] })
})

it('custom permissions round-trip through propose, validate, preview, disposable apply and promoted config.ts', async () => {
  const { proposalId } = await accepted('propose_change', { instance: 'demo', baseRevision: 1, changes: [
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } },
      permissions: { auditor: ['read'] }, policies: { auditor: 'all' } },
  ] })
  expect(await call('validate', { proposalId })).toEqual({ ok: true, errors: [], revision: 2, warnings: [] })
  expect((await accepted('preview_migration', { proposalId })).configDiff).toContainEqual({
    op: 'add', path: '/config/permissions/auditor/customers', value: ['read'],
  })
  expect(await call('apply_to_disposable', { proposalId })).toEqual({ ok: true, verified: true, diffs: [] })
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({
    ok: true, status: 'promoted', revision: 2, appliesToDatabase: false,
  })
  // Store.load imports the promoted config.ts from disk, rather than the planner's target.
  expect((await application.store.load('demo')).config.permissions).toEqual({
    owner: { orders: ['read', 'create'], customers: [] }, dispatcher: { customers: [] },
    viewer: { customers: [] }, auditor: { orders: ['read'], customers: ['read'] }, member: { customers: [] },
  })
})

it('an undeclared permission role returns a structured planner error without throwing', async () => {
  expect(await call('propose_change', { instance: 'demo', baseRevision: 1, changes: [
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } }, permissions: { unknown: ['read'] } },
  ] })).toEqual({ ok: false, error: { code: 'unknown_role', status: 400,
    message: 'Unknown permission role: customers.unknown; declared roles: owner, dispatcher, viewer, auditor, member' } })
})

const invalidRecordKeys = ['__proto__', 'constructor', 'prototype', 'Uppercase', 'with space', '']
const invalidRecordCases = ['permissions', 'policies', 'fields'].flatMap(record => invalidRecordKeys.map(key => ({ record, key })))
it.each(invalidRecordCases)('$record rejects invalid raw JSON key "$key" without recording a proposal', async ({ record, key }) => {
  const value = record === 'permissions' ? ['read'] : record === 'policies' ? 'all' : { type: 'string' }
  // JSON.parse creates an own __proto__ property; an object literal would set the prototype instead.
  const raw = JSON.parse(`{"instance":"demo","baseRevision":1,"changes":[{"kind":"add_entity","entity":"customers","fields":{},"${record}":{${JSON.stringify(key)}:${JSON.stringify(value)}}}]}`)
  expect(Object.getOwnPropertyNames(raw.changes[0][record])).toEqual([key])
  const result = await application.workflow.call('propose_change', raw)
  expect.soft(result).toMatchObject({ ok: false, error: {
    code: 'invalid_input', status: 400, message: 'Input does not match the tool schema',
    issues: [expect.objectContaining({ path: ['changes', 0, record, key] })],
  } })
  expect.soft((await call('inspect_schema', { instance: 'demo' })).pendingProposals).toEqual([])
  expect.soft((await readdir(join(root, 'proposals'))).filter(file => file.endsWith('.json'))).toEqual([])
})

it('built-in permission inputs preserve operation order, duplicates, empty arrays and omissions', () => {
  const inputs: Extract<Change, { kind: 'add_entity' }>[] = [
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } }, permissions: {
      owner: ['delete', 'update', 'create', 'read'], dispatcher: ['update', 'read'], viewer: ['read', 'read'],
    } },
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } }, permissions: { owner: [], viewer: ['read'] } },
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } }, permissions: {} },
    { kind: 'add_entity', entity: 'customers', fields: { name: { type: 'string' } } },
  ]
  expect(inputs.map(change => ({ parsed: changeSchema.parse(change), permissions: prepare(config, [], [change]).target.permissions })))
    .toEqual(inputs.map(change => ({ parsed: change, permissions: Object.fromEntries(config.roles.map(role => [role, {
      ...config.permissions[role], customers: change.permissions?.[role] ?? [],
    }])) })))
})
