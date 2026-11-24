import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { bootstrapInstance } from '../src/bootstrap.ts'
import { runSchemaCli } from '@workbasehq/core/migrations/schema-cli'
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
import { Store } from '../src/storage.ts'
import { Workflow } from '../src/workflow.ts'
import { schemas, compositionChangeSchema, schemaChangeSchema } from '../src/schemas.ts'
import { guardV3LegacyWrite } from '../src/v3-guard.ts'
import { copyHistoricalInstances } from './fixtures.ts'
import type { InstanceConfig } from '@workbasehq/core/config'

let root: string, legacyRoot: string, workflow: Workflow, legacy: Workflow
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-capabilities-')))
  await bootstrapInstance(root, { id: 'example', target: 'cloudflare-github' })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await runSchemaCli('plan', ['--root', root, '--init'])
  await runOpenApiCli(['--root', root, '--write'])
  await rm(join(root, 'migrations/.gitkeep'))
  const store = new Store(root); await store.init(); workflow = new Workflow(store)
  legacyRoot = await realpath(await mkdtemp(join(tmpdir(), 'mcp-capabilities-legacy-')))
  await writeFile(join(legacyRoot, 'package.json'), '{"type":"module"}')
  await copyHistoricalInstances(legacyRoot)
  // Valid canonical source shape lets the real composition handler reach its baseline guard.
  await writeFile(join(legacyRoot, 'examples/sample/runtime.ts'), await readFile(join(root, 'runtime.ts')))
  const legacyStore = new Store(legacyRoot); await legacyStore.init(); legacy = new Workflow(legacyStore)
})
afterAll(async () => { vi.restoreAllMocks(); await Promise.all([root, legacyRoot].filter(Boolean).map(path => rm(path, { recursive: true, force: true }))) })
const getMatrix = async (w = workflow, instance = 'example') => {
  const result = await w.call('capabilities', { instance })
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, instance, submissionConfigured: false })
  return result as any
}
it('enumerates the exact union of schema discriminants including nested plugin alternatives', async () => {
  const matrix = await getMatrix()
  const { schemaKinds } = await import('../src/change-routing.ts')
  const json = z.toJSONSchema(schemas.propose_change, { io: 'input' })
  const independentKinds = (node: any): string[] => node?.properties?.kind?.const ? [node.properties.kind.const]
    : ['anyOf', 'oneOf'].flatMap(key => (node?.[key] ?? []).flatMap(independentKinds))
  expect(matrix.changes.map((row: any) => row.kind)).toEqual([...new Set(independentKinds((json.properties!.changes as any).items))].sort())
  expect(matrix.changes).toHaveLength(25)
  expect(schemaKinds(compositionChangeSchema)).toContain('set_plugin')
  expect(schemaKinds(schemaChangeSchema)).toEqual(['set_constraints'])
  expect(matrix.tools).toEqual(Object.keys(schemas))
  expect(matrix.version).toBe(JSON.parse(await readFile(resolve('packages/mcp/package.json'), 'utf8')).version)
})
it.each(['legacy', 'v3'])('matches real legacy guards for every schema kind on %s', async baseline => {
  const { capabilities } = await import('../src/capabilities.ts')
  const { compositionEligibility, schemaEligibility, assertEligible } = await import('../src/change-routing.ts')
  const config = { baseline: baseline === 'v3' ? 'workbase-sdk' : undefined } as InstanceConfig
  for (const row of capabilities('example', config.baseline).changes) {
    if (row.route !== 'legacy') {
      const decision = row.route === 'composition' ? compositionEligibility(config.baseline, [{ kind: row.kind }]) : schemaEligibility(config.baseline)
      expect(row.propose.eligible).toBe(decision.eligible)
      expect(row.promote.eligible).toBe(decision.eligible)
      if (!decision.eligible) expect(() => assertEligible(decision)).toThrow(expect.objectContaining(decision.error))
      continue
    }
    for (const [operation, stage] of [['propose', row.propose], ['promote', row.promote]] as const) {
      const call = () => guardV3LegacyWrite(config, operation, [{ kind: row.kind } as never])
      if (stage.eligible) expect(call).not.toThrow()
      else expect(call).toThrow(expect.objectContaining({ code: stage.error.code, message: stage.error.message }))
    }
  }
})
it('distinguishes physical V3 proposal, promotion refusal and first submit prerequisite in real workflow', async () => {
  const matrix = await getMatrix()
  const row = matrix.changes.find((row: any) => row.kind === 'add_field')
  expect(row).toMatchObject({ route: 'legacy', propose: { eligible: true, reachable: true },
    promote: { eligible: false, reachable: false, error: { code: 'v3_promote_unsupported' } },
    submit: { eligible: true, reachable: false, firstPrerequisite: 'promotion_required', blockedBy: { stage: 'promote', code: 'v3_promote_unsupported' } } })
  const p = await workflow.call('propose_change', { instance: 'example', baseRevision: 1,
    changes: [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }] })
  expect(p).toMatchObject({ ok: true, status: 'proposed' })
  expect(await workflow.call('promote', { proposalId: p.proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: row.promote.error.code } })
  expect(await workflow.call('submit_change', { instance: 'example', proposalId: p.proposalId, expectedBaseSha: 'a'.repeat(40) })).toMatchObject({ ok: false, error: { code: row.submit.firstPrerequisite } })
})
it.each([
  { kind: 'set_permissions', entity: 'worker', role: 'staff', operations: ['read'] },
  { kind: 'set_policy', entity: 'worker', role: 'staff', policy: 'all' },
  { kind: 'set_organization_permissions', role: 'staff', actions: [] },
  { kind: 'add_user_link', entity: 'worker' },
  { kind: 'add_role', role: 'reviewer' },
  { kind: 'remove_role', role: 'staff' },
])('reports the same V3 replacement refusal as actual propose_change for $kind', async change => {
  const row = (await getMatrix()).changes.find((row: any) => row.kind === change.kind)
  expect(row.propose).toMatchObject({ eligible: false, error: { code: 'v3_unsupported_change' } })
  expect(await workflow.call('propose_change', { instance: 'example', baseRevision: 1, changes: [change] })).toMatchObject({ ok: false, error: row.propose.error })
})
it.each([
  { kind: 'set_locale', locale: 'en' },
  { kind: 'set_label', entity: 'worker', field: 'name', language: 'en', label: 'Name' },
  { kind: 'set_instance_display_name', displayName: 'Example' },
  { kind: 'set_plugin', plugin: 'organizations', options: { allowCreate: false } },
  { kind: 'set_entity_access', entity: 'worker', role: 'staff', access: { read: 'allow', create: 'deny', update: 'deny', delete: 'deny' } },
])('routes supported V3 $kind to composition in actual propose_change', async change => {
  const row = (await getMatrix()).changes.find((row: any) => row.kind === change.kind)
  expect(row).toMatchObject({ route: 'composition', propose: { eligible: true }, promote: { eligible: true } })
  const result = await workflow.call('propose_change', { instance: 'example', baseRevision: 1, changes: [change] })
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, kind: 'composition_change' })
})
it('routes constraints through the V3 schema handler and distinguishes the legacy source-shape prerequisite', async () => {
  const change = { kind: 'set_constraints', entity: 'worker', constraints: [{ kind: 'unique', name: 'worker_name_unique', fields: ['name'] }] }
  const row = (await getMatrix()).changes.find((row: any) => row.kind === change.kind)
  expect(row).toMatchObject({ route: 'schema', propose: { eligible: true }, promote: { eligible: true } })
  expect(await workflow.call('propose_change', { instance: 'example', baseRevision: 1, changes: [change] })).toMatchObject({ ok: true, kind: 'schema_change' })
  const legacyRow = (await getMatrix(legacy, 'sample')).changes.find((row: any) => row.kind === change.kind)
  expect(legacyRow.propose).toMatchObject({ eligible: false, error: { code: 'schema_requires_v3' } })
  const result = await legacy.call('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ ...change, entity: 'workers' }] })
  const { assertEligible, schemaEligibility } = await import('../src/change-routing.ts')
  expect(() => assertEligible(schemaEligibility(undefined))).toThrow(expect.objectContaining(legacyRow.propose.error))
  // Legacy source fails literal loading before its baseline guard. Matrix support is
  // conditional on source shape, rather than a prediction of the first runtime error.
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'invalid_access', message: expect.stringContaining('direct SDK defineConfig') } })
})
it('routes shared caption/locale kinds through legacy and composition-only kinds to their baseline refusal', async () => {
  const matrix = await getMatrix(legacy, 'sample')
  for (const change of [{ kind: 'set_locale', locale: 'en' }, { kind: 'set_label', entity: 'workers', language: 'en', plural: 'Workers' }]) {
    expect(matrix.changes.find((row: any) => row.kind === change.kind)).toMatchObject({ route: 'legacy', propose: { eligible: true }, promote: { eligible: true }, viaProposeComposition: { eligible: false, error: { code: 'composition_requires_v3' } } })
    expect(await legacy.call('propose_change', { instance: 'sample', baseRevision: 2, changes: [change] })).toMatchObject({ ok: true, status: 'proposed' })
  }
  const row = matrix.changes.find((row: any) => row.kind === 'set_plugin')
  expect(row.propose).toMatchObject({ eligible: false, error: { code: 'composition_requires_v3' } })
  expect(await legacy.call('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ kind: 'set_plugin', plugin: 'audit' }] })).toMatchObject({ ok: false, error: row.propose.error })
})
it.each([
  [{ kind: 'set_constraints', entity: 'worker', constraints: [] }, { kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }],
  [{ kind: 'set_plugin', plugin: 'audit' }, { kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }],
  [{ kind: 'set_locale', locale: 'en' }, { kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }],
  [{ kind: 'set_instance_display_name', displayName: 'Example' }, { kind: 'set_plugin', plugin: 'audit' }],
])('shares mixed-batch restrictions with the actual routed workflow (%j)', async (...changes) => {
  const { changeRoute, compositionEligibility, assertEligible } = await import('../src/change-routing.ts')
  const decide = () => { if (changeRoute('workbase-sdk', changes) === 'composition') assertEligible(compositionEligibility('workbase-sdk', changes)) }
  expect(decide).toThrow(expect.objectContaining({ code: 'mixed_change_kinds' }))
  expect(await workflow.call('propose_change', { instance: 'example', baseRevision: 1, changes })).toMatchObject({ ok: false, error: { code: 'mixed_change_kinds' } })
})
it('uses only trusted per-instance metadata, defaults false even with a GitHub callback, and redacts failures', async () => {
  const github = vi.fn(async () => { throw new Error('credential/target must never be retrieved') })
  const app = new Workflow(workflow.store, github)
  expect(await app.call('capabilities', { instance: 'example' })).toMatchObject({ ok: true, submissionConfigured: false })
  const { capabilities } = await import('../src/capabilities.ts')
  const configured = vi.fn((instance: string) => instance === 'example')
  const ready = new Workflow(workflow.store, github, configured)
  expect(await ready.call('capabilities', { instance: 'example' })).toMatchObject({ ok: true, submissionConfigured: true })
  const matrix = capabilities('other', 'workbase-sdk', configured)
  expect(matrix.submissionConfigured).toBe(false)
  expect(matrix.changes.find(row => row.kind === 'set_instance_display_name')?.submit).toMatchObject({ eligible: true, reachable: false, blockedBy: { code: 'github_not_configured' } })
  const failed = capabilities('example', 'workbase-sdk', () => { throw new Error('private-metadata') })
  expect(failed.submissionConfigured).toBe(false)
  expect(JSON.stringify(failed)).not.toContain('private-metadata')
  expect(github).not.toHaveBeenCalled()
  expect(await ready.call('capabilities', { instance: 'example', submissionConfigured: true })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(await ready.call('capabilities', { instance: 'other' })).toMatchObject({ ok: false, error: { code: 'instance_not_allowed' } })
})
it('advertises docs/capabilities through MCP with strict inputs and read-only hints', async () => {
  const { createServer } = await import('../src/server.ts')
  const github = vi.fn(async () => undefined)
  const app = await createServer({ root, github, submissionConfigured: instance => instance === 'example' })
  const client = new Client({ name: 'example', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await app.server.connect(b); await client.connect(a)
    const tools = (await client.listTools()).tools
    for (const name of ['list_docs', 'read_doc', 'capabilities']) {
      const tool = tools.find(tool => tool.name === name)!
      expect(tool).toBeDefined()
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
    expect((await client.callTool({ name: 'capabilities', arguments: { instance: 'example' } })).structuredContent).toMatchObject({ ok: true, submissionConfigured: true })
    expect((await client.callTool({ name: 'read_doc', arguments: { name: '../package.json' } })).structuredContent).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(github).not.toHaveBeenCalled()
  } finally { await client.close(); await app.server.close() }
})
