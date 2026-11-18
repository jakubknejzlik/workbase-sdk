import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { loadConfig } from '@workbasehq/core/schema/load'
import { effectiveEntityGrants, effectiveSystemGrant } from '../../core/src/access-evaluator.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'
import { createServer } from '../src/server.ts'
import { managedLocalTarget } from '../src/local-target.ts'
import * as storage from '../src/storage.ts'
import * as migration from '../src/migration-replay.ts'
import { stateRoot } from '../src/disposable.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const instance = 'local-roles'
const roles = ['owner', 'dispatcher', 'viewer', 'member']
const restricted = { read: { where: { user: { eq: '$actor.id' } }, fields: ['name'] }, create: 'deny', update: 'deny', delete: 'deny' }
const initialComposition = { roles, organizationOwnerRole: 'owner', access: [
  { kind: 'set_system_access', role: 'owner', grants: Object.fromEntries(accessSystemActions.map(action => [action, 'allow'])) },
  ...[...accessEntities, 'worker'].map(entity => ({ kind: 'set_entity_access', entity, role: 'owner', access: { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } })),
  { kind: 'set_entity_access', entity: 'worker', role: 'member', access: restricted },
  { kind: 'set_account_link', entity: 'worker', invitationRole: 'member' },
] }
type Call = (name: string, input: Record<string, unknown>) => Promise<any>
async function accepted(call: Call, name: string, input: Record<string, unknown>) {
  const result = await call(name, input)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  return result
}
async function empty() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'local-target-')))
  roots.push(root)
  // Dependencies are available before bootstrap; no target setup or mapping.
  await fs.symlink(resolve('node_modules'), join(root, 'node_modules'))
  return root
}
async function initialize(call: Call, custom = true) {
  await accepted(call, 'bootstrap_instance', { id: 'local_roles', target: 'cloudflare-github', ...(custom ? { initialComposition } : {}) })
  const preview = await accepted(call, 'initialize_instance', { instance })
  await accepted(call, 'initialize_instance', { instance, mode: 'apply', planHash: preview.planHash })
  return preview
}
async function target(call: Call) {
  const preview = await accepted(call, 'create_local_target', { instance })
  return accepted(call, 'create_local_target', { instance, mode: 'apply', planHash: preview.planHash })
}
async function propose(call: Call, changes: unknown[] = [{ kind: 'set_entity_access', entity: 'worker', role: 'viewer', access: restricted }]) {
  const { proposalId } = await accepted(call, 'propose_composition', { instance, baseRevision: 1, changes })
  await accepted(call, 'validate', { proposalId })
  await accepted(call, 'preview_migration', { proposalId })
  return proposalId
}
function interruptMigration() {
  const replay = migration.replayInstance
  let interrupted = false
  vi.spyOn(migration, 'replayInstance').mockImplementation(async (...args) => {
    if (!interrupted && args[0].prepare('PRAGMA database_list').get()?.file) {
      interrupted = true
      throw new Error('interrupted migration')
    }
    return replay(...args)
  })
}
async function fixture() {
  const root = await empty(), app = await createServer({ root })
  const call: Call = (name, input) => app.workflow.call(name, input)
  await initialize(call)
  return { root, app, call }
}

it.each(['bun', 'node'])('accepts empty-root bootstrap → target → verification → promotion → restart over %s stdio', async runtime => {
  const root = await empty()
  async function connect() {
    const client = new Client({ name: 'local-target-acceptance', version: '1' })
    const transport = new StdioClientTransport({ command: runtime, args: [
      ...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
      resolve('packages/mcp/src/stdio.ts'), '--root', root,
    ], stderr: 'pipe', env: { ...process.env, WORKBASE_MCP_ROLE_DATABASES: '{}' } as Record<string, string> })
    transport.stderr?.on('data', () => {})
    await client.connect(transport)
    return { client, call: (async (name, input) => (await client.callTool({ name, arguments: input }, undefined, { timeout: 120000 })).structuredContent) as Call,
      close: async () => { await client.close(); await transport.close() } }
  }
  let session = await connect()
  try {
    expect((await session.client.listTools()).tools.find(tool => tool.name === 'create_local_target')?.inputSchema.additionalProperties).toBe(false)
    const initial = await initialize(session.call)
    const baselineRoot = await empty(), baseline = await createServer({ root: baselineRoot })
    try {
      const defaultPlan = await initialize((name, args) => baseline.workflow.call(name, args), false)
      for (const path of ['schema.lock.json', 'migrations/0001_r1.sql']) {
        expect(initial.files.find((f: any) => f.path === path).data).toBe(defaultPlan.files.find((f: any) => f.path === path).data)
      }
    } finally { await baseline.server.close() }
    const stable = await Promise.all(['schema.lock.json', 'migrations/0001_r1.sql'].map(path => fs.readFile(join(root, path))))
    const created = await target(session.call)
    expect(created).toMatchObject({ status: 'created', instanceId: expect.any(String), targetId: expect.any(String) })
    expect(created.path.startsWith(join(root, '.local', 'mcp-target'))).toBe(true)
    expect(created.path.startsWith(stateRoot)).toBe(false)
    const proposalId = await propose(session.call)
    const disposableBefore = (await fs.readdir(stateRoot)).filter(name => name.startsWith('proposal-'))
    await accepted(session.call, 'apply_to_disposable', { proposalId })
    expect((await fs.readdir(stateRoot)).filter(name => name.startsWith('proposal-'))).toEqual(disposableBefore)
    await accepted(session.call, 'promote', { proposalId, expectedRevision: 1 })
    await session.close(); session = await connect()
    expect(await accepted(session.call, 'inspect_schema', { instance })).toMatchObject({ roles, organizationOwnerRole: 'owner', revision: 1, validation: { ok: true } })
    const again = await target(session.call)
    expect(again).toMatchObject({ status: 'unchanged', targetId: created.targetId, instanceId: created.instanceId, path: created.path, creationPlanHash: created.creationPlanHash })
    const loaded = await loadConfig(join(root, 'config.ts'))
    expect(loaded.config.entities.users.fields.role.values).toEqual(roles)
    expect(loaded.authoredAccess.shared?.accountLinks?.worker.invitationRole).toBe('member')
    expect(parseRuntimeSource(await fs.readFile(join(root, 'runtime.ts'), 'utf8')).plugins.find(p => p.plugin === 'permissions')?.options).toEqual({ roles, ownerRole: 'owner' })
    for (const action of accessSystemActions) expect(effectiveSystemGrant(loaded.config.effectiveAccess!, ['owner'], action)).toBe(true)
    for (const role of ['viewer', 'member']) expect(effectiveEntityGrants(loaded.config.effectiveAccess!, [role], 'worker', 'read')).toEqual([expect.objectContaining({ where: { user: { eq: '$actor.id' } }, fields: ['id', 'name'] })])
    for (const path of ['access.lock.json', 'access.lock.md', 'openapi.json']) {
      const text = await fs.readFile(join(root, path), 'utf8')
      for (const role of roles) expect(text).toContain(role)
    }
    expect(await Promise.all(['schema.lock.json', 'migrations/0001_r1.sql'].map(path => fs.readFile(join(root, path))))).toEqual(stable)
    expect((await fs.readdir(join(root, 'migrations'))).filter(path => path.endsWith('.sql'))).toEqual(['0001_r1.sql'])
    // A receipt is provenance only. The real seeded organization still counts.
    const ownerChange = await propose(session.call, [{ kind: 'set_roles', roles, organizationOwnerRole: 'dispatcher' }])
    expect(await session.call('apply_to_disposable', { proposalId: ownerChange })).toMatchObject({ ok: false, error: { code: 'owner_change_requires_fresh_target' } })
  } finally { await session.close() }
})

it('refuses stale source/dependency plans and caller freshness/path/SQL inputs', async () => {
  const { root, app, call } = await fixture()
  try {
    const preview = await accepted(call, 'create_local_target', { instance })
    for (const path of ['runtime.ts', 'package.json']) {
      const bytes = await fs.readFile(join(root, path))
      await fs.writeFile(join(root, path), Buffer.concat([bytes, Buffer.from('\n')]))
      expect(await call('create_local_target', { instance, mode: 'apply', planHash: preview.planHash })).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
      await fs.writeFile(join(root, path), bytes)
    }
    for (const extra of [{ fresh: true }, { path: join(root, 'target.sqlite') }, { sql: 'DELETE FROM organizations' }]) {
      expect(await call('create_local_target', { instance, mode: 'apply', planHash: preview.planHash, ...extra })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
    expect(await managedLocalTarget(root, instance)).toBeUndefined()
  } finally { await app.server.close() }
})

it.each(['migration', 'ready-receipt', 'publication', 'active-receipt'])('recovers interrupted %s without overwriting populated attempts', async phase => {
  const { root, app, call } = await fixture()
  try {
    const original = storage.durableAtomic
    if (phase === 'migration') interruptMigration()
    else if (phase === 'publication') { vi.spyOn(fs, 'link').mockRejectedValueOnce(new Error('interrupted publication')); syncBuiltinESMExports() }
    else vi.spyOn(storage, 'durableAtomic').mockImplementation(async (path, data) => {
      if (path.endsWith('receipt.json') && JSON.parse(data).state === (phase === 'ready-receipt' ? 'ready' : 'active')) throw new Error('interrupted receipt')
      return original(path, data)
    })
    const preview = await accepted(call, 'create_local_target', { instance })
    const apply = { instance, mode: 'apply', planHash: preview.planHash }
    expect(await call('create_local_target', apply)).toMatchObject({ ok: false })
    vi.restoreAllMocks(); syncBuiltinESMExports()
    const dir = join(root, '.local', 'mcp-target')
    const receipt = JSON.parse(await fs.readFile(join(dir, 'receipt.json'), 'utf8'))
    expect(await call('apply_to_disposable', { proposalId: await propose(call) })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
    let preserved: Buffer | undefined, orphan: string | undefined
    if (receipt.state === 'preparing') {
      orphan = join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.pending.sqlite'))!)
      const db = new DatabaseSync(orphan)
      try { db.exec('CREATE TABLE interrupted_data (value TEXT); INSERT INTO interrupted_data VALUES (\'preserve\')') } finally { db.close() }
      preserved = await fs.readFile(orphan)
    }
    // A new Store models recovery after server restart; neither proposal nor
    // disposable state participates in the durable identity.
    const restarted = await createServer({ root })
    try {
      const recovered = await accepted((name, args) => restarted.workflow.call(name, args), 'create_local_target', apply)
      expect(recovered).toMatchObject({ targetId: receipt.targetId, instanceId: receipt.instanceId })
      if (orphan) expect(await fs.readFile(orphan)).toEqual(preserved)
      const db = new DatabaseSync(recovered.path)
      try { expect(db.prepare('SELECT id FROM organizations').all()).toEqual([{ id: 'instance' }]) } finally { db.close() }
      expect(await target(call)).toMatchObject({ status: 'unchanged', targetId: receipt.targetId })
    } finally { await restarted.server.close() }
  } finally { await app.server.close() }
})

it.each(['substitution', 'contents', 'missing', 'incomplete'])('refuses target %s between verification and promotion', async change => {
  const { root, app, call } = await fixture()
  try {
    const created = await target(call), proposalId = await propose(call)
    await accepted(call, 'apply_to_disposable', { proposalId })
    if (change === 'substitution') {
      await fs.copyFile(created.path, created.path + '.replacement')
      await fs.rename(created.path + '.replacement', created.path)
    } else if (change === 'missing') await fs.rename(created.path, created.path + '.missing')
    else {
      const db = new DatabaseSync(created.path)
      try { db.exec(change === 'contents' ? "INSERT INTO organizations VALUES ('later','Later')" : 'DROP TABLE invitations') } finally { db.close() }
    }
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
    expect(await fs.readFile(join(root, 'schema/worker.ts'), 'utf8')).not.toContain("viewer: { read: {")
  } finally { await app.server.close() }
})

it.each(['occupied', 'pending-substitution', 'pending-populated', 'pending-stale'])('preserves %s targets and refuses unsafe recovery', async fault => {
  const { root, app, call } = await fixture()
  try {
    const original = storage.durableAtomic
    if (fault === 'occupied') interruptMigration()
    else vi.spyOn(storage, 'durableAtomic').mockImplementation(async (path, data) => {
      if (path.endsWith('receipt.json') && JSON.parse(data).state === 'active') throw new Error('interrupted')
      return original(path, data)
    })
    const preview = await accepted(call, 'create_local_target', { instance })
    const apply = { instance, mode: 'apply', planHash: preview.planHash }
    expect(await call('create_local_target', apply)).toMatchObject({ ok: false })
    vi.restoreAllMocks(); syncBuiltinESMExports()
    const dir = join(root, '.local', 'mcp-target'), path = join(dir, 'receipt.json')
    const receipt = JSON.parse(await fs.readFile(path, 'utf8')), database = join(dir, `${receipt.targetId}.sqlite`)
    if (fault === 'pending-stale') {
      const source = join(root, 'runtime.ts'), bytes = await fs.readFile(source)
      await fs.writeFile(source, Buffer.concat([bytes, Buffer.from('\n')]))
      const changed = await accepted(call, 'create_local_target', { instance })
      expect(await call('create_local_target', { ...apply, planHash: changed.planHash })).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
      await fs.writeFile(source, bytes)
      expect(await call('create_local_target', apply)).toMatchObject({ ok: true, targetId: receipt.targetId })
      return
    }
    if (fault === 'pending-substitution') {
      await fs.copyFile(database, database + '.replacement')
      await fs.rename(database + '.replacement', database)
    } else {
      const db = new DatabaseSync(database)
      try { db.exec('CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES (\'populated\')') } finally { db.close() }
    }
    const bytes = await fs.readFile(database)
    expect(await call('create_local_target', apply)).toMatchObject({ ok: false, error: { code: 'local_target_conflict' } })
    expect(await fs.readFile(database)).toEqual(bytes)
  } finally { await app.server.close() }
})

it('rejects symlinked target ancestry and invalid explicit operator evidence without falling back', async () => {
  const { root, app, call } = await fixture()
  try {
    const created = await target(call)
    const proposalId = await propose(call)
    vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', JSON.stringify({ [instance]: join(root, 'missing.sqlite') }))
    const ownerChange = await propose(call, [{ kind: 'set_roles', roles, organizationOwnerRole: 'dispatcher' }])
    expect(await call('apply_to_disposable', { proposalId: ownerChange })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
    vi.unstubAllEnvs()
    await fs.rename(join(root, '.local'), join(root, 'saved-local'))
    await fs.symlink(join(root, 'saved-local'), join(root, '.local'))
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
    expect(await call('create_local_target', { instance })).toMatchObject({ ok: false, error: { code: 'unsafe_path' } })
    expect(await fs.readFile(join(root, 'saved-local', 'mcp-target', `${created.targetId}.sqlite`))).toBeDefined()
  } finally { vi.unstubAllEnvs(); await app.server.close() }
})
