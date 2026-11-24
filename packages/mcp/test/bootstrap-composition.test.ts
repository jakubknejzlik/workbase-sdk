import { provisionLocalSdk } from './fixtures/local-sdk.ts'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { loadConfig } from '@workbasehq/core/schema/load'
import { effectiveEntityGrants, effectiveSystemGrant } from '../../core/src/access-evaluator.ts'
import { bootstrapInstance } from '../src/bootstrap.ts'
import { createServer } from '../src/server.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'
import { errorResult } from '../src/workflow.ts'
import { stateRoot } from '../src/disposable.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function empty() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bootstrap-composition-')))
  roots.push(root)
  return root
}
const roles = ['owner', 'dispatcher', 'viewer', 'member']
const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' }
const initialComposition = {
  roles, organizationOwnerRole: 'owner',
  access: [
    { kind: 'set_system_access', role: 'owner', grants: Object.fromEntries(accessSystemActions.map(action => [action, 'allow'])) },
    ...[...accessEntities, 'worker'].map(entity => ({ kind: 'set_entity_access', entity, role: 'owner', access: all })),
    { kind: 'set_entity_access', entity: 'worker', role: 'member', access: {
      read: { where: { user: { eq: '$actor.id' } }, fields: ['name'] }, create: 'deny', update: 'deny', delete: 'deny',
    } },
    { kind: 'set_account_link', entity: 'worker', invitationRole: 'member' },
  ],
}
const input = { id: 'initial_roles', target: 'cloudflare-github' }
async function fixture(composition?: unknown) {
  const root = await empty()
  await bootstrapInstance(root, { ...input, ...(composition === undefined ? {} : { initialComposition: composition }) })
  await provisionLocalSdk(root)
  const app = await createServer({ root })
  const call = (mode = 'preview', planHash?: string) => app.workflow.call('initialize_instance', { instance: 'initial-roles', mode, ...(planHash ? { planHash } : {}) }) as Promise<any>
  return { root, app, call }
}

it('compiles the initial graph and preserves physical schema, domain migration bytes and revision', async () => {
  const baseline = await fixture()
  const custom = await fixture(initialComposition)
  try {
    const standard = await baseline.call(), preview = await custom.call()
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, conflicts: [] })
    for (const path of ['schema.lock.json', 'migrations/0001_r1.sql']) {
      expect(preview.files.find((file: any) => file.path === path).data).toBe(standard.files.find((file: any) => file.path === path).data)
    }
    expect(preview.planHash).not.toBe(standard.planHash)
    expect(await custom.call('apply', preview.planHash)).toMatchObject({ ok: true, status: 'initialized' })
    const loaded = await loadConfig(join(custom.root, 'config.ts'))
    expect(loaded.config).toMatchObject({ roles, organizationOwnerRole: 'owner', revision: 1 })
    expect(loaded.config.entities.users.fields.role.values).toEqual(roles)
    expect(loaded.authoredAccess.shared?.accountLinks?.worker.invitationRole).toBe('member')
    expect(Object.keys(loaded.authoredAccess.entities.worker!)).toEqual(roles)
    expect(parseRuntimeSource(await readFile(join(custom.root, 'runtime.ts'), 'utf8')).plugins.find(plugin => plugin.plugin === 'permissions')?.options)
      .toEqual({ roles, ownerRole: 'owner' })
    const policy = loaded.config.effectiveAccess!
    for (const action of accessSystemActions) expect(effectiveSystemGrant(policy, ['owner'], action)).toBe(true)
    for (const role of roles.slice(1)) {
      expect(effectiveSystemGrant(policy, [role], 'members.update')).toBe(false)
      expect(effectiveEntityGrants(policy, [role], 'worker', 'update')).toEqual([])
    }
    expect(effectiveEntityGrants(policy, ['member'], 'worker', 'read')).toEqual([
      expect.objectContaining({ where: { user: { eq: '$actor.id' } }, fields: ['id', 'name'] }),
    ])
    expect(effectiveEntityGrants(policy, ['viewer'], 'worker', 'read')).toEqual([])
    expect((await readdir(join(custom.root, 'migrations'))).filter(path => path.endsWith('.sql'))).toEqual(['0001_r1.sql'])
  } finally { await baseline.app.server.close(); await custom.app.server.close() }
})

it('carries the bootstrap role/access graph through fresh composition verification and exact promotion', async () => {
  const custom = await fixture(initialComposition)
  try {
    const call = (name: string, input: Record<string, unknown>) => custom.app.workflow.call(name, input) as Promise<any>
    const sources = await Promise.all(['config.ts', 'access.ts', 'schema/worker.ts'].map(path => readFile(join(custom.root, path), 'utf8')))
    const runtime = await readFile(join(custom.root, 'runtime.ts'), 'utf8')
    const composition = { interactive: false, plugins: [
      { plugin: 'identity' }, { plugin: 'permissions' }, { plugin: 'members' },
      { plugin: 'organizations', options: { allowCreate: true } },
    ] }
    // A custom role graph permits only the exact bootstrap runtime, not authored additions.
    await writeFile(join(custom.root, 'runtime.ts'), runtime + '// authored\n')
    expect(await call('propose_initial_composition', { instance: 'initial-roles', composition }))
      .toMatchObject({ ok: false, error: { code: 'fresh_state_conflict', details: { conflicts: ['runtime.ts'] } } })
    await writeFile(join(custom.root, 'runtime.ts'), runtime)
    const proposed = await call('propose_initial_composition', { instance: 'initial-roles', composition })
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, kind: 'initial_composition', revision: 1 })
    const args = { proposalId: proposed.proposalId }
    expect(await call('validate', args)).toMatchObject({ ok: true })
    const preview = await call('preview_migration', args)
    expect(preview).toMatchObject({ ok: true, resolvedOptions: { plugins: expect.arrayContaining([
      { plugin: 'permissions', options: { roles, ownerRole: 'owner' } },
    ]) } })
    expect(await call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    for (const file of preview.files) expect(await readFile(join(custom.root, file.path), 'utf8')).toBe(file.data)
    expect(await Promise.all(['config.ts', 'access.ts', 'schema/worker.ts'].map(path => readFile(join(custom.root, path), 'utf8')))).toEqual(sources)
    const loaded = await loadConfig(join(custom.root, 'config.ts'))
    expect(loaded.config).toMatchObject({ roles, organizationOwnerRole: 'owner', revision: 1 })
    expect(loaded.authoredAccess.shared?.accountLinks?.worker.invitationRole).toBe('member')
    expect(effectiveEntityGrants(loaded.config.effectiveAccess!, ['member'], 'worker', 'read')).toEqual([
      expect.objectContaining({ where: { user: { eq: '$actor.id' } }, fields: ['id', 'name'] }),
    ])
    const initialized = await custom.call()
    expect(initialized).toMatchObject({ ok: true, conflicts: [] })
    expect(await custom.call('apply', initialized.planHash)).toMatchObject({ ok: true, status: 'unchanged' })
  } finally { await custom.app.server.close() }
})

it.each([
  { ...initialComposition, organizationOwnerRole: 'missing' },
  { ...initialComposition, roles: [...roles, 'owner'] },
  { ...initialComposition, access: [...initialComposition.access, { kind: 'set_account_link', entity: 'worker', invitationRole: 'missing' }] },
  { ...initialComposition, access: [...initialComposition.access, { kind: 'set_account_link', entity: 'worker', invitationRole: 'owner' }] },
  { ...initialComposition, access: [...initialComposition.access, { kind: 'set_entity_access', entity: 'missing', role: 'owner', access: all }] },
  { ...initialComposition, access: [...initialComposition.access, { kind: 'set_system_access', role: 'owner', grants: { 'unknown.action': 'allow' } }] },
])('rejects an invalid complete graph before publishing anything (%#)', async composition => {
  const root = await empty()
  await expect(bootstrapInstance(root, { ...input, initialComposition: composition })).rejects.toBeDefined()
  expect(await readdir(root)).toEqual([])
})

it.each([
  { kind: 'set_entity_access', entity: 'missing', role: 'owner', access: all },
  { kind: 'set_system_access', role: 'owner', grants: { 'unknown.action': 'allow' } },
  { kind: 'set_system_access', role: 'missing', grants: { 'members.update': 'allow' } },
])('returns stable scaffold diagnostics for an invalid graph (%#)', async change => {
  const diagnostics = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const root = await empty()
    const diagnostic = await bootstrapInstance(root, {
      ...input, initialComposition: { ...initialComposition, access: [...initialComposition.access, change] },
    }).then(() => { throw new Error('Expected graph validation to reject') }, errorResult)
    expect(await readdir(root)).toEqual([])
    diagnostics.push(diagnostic)
  }
  expect(diagnostics[1]).toEqual(diagnostics[0])
  for (const diagnostic of diagnostics) {
    expect(diagnostic).toMatchObject({ ok: false, error: {
      code: 'invalid_access', status: 422, details: { file: 'access.ts', line: expect.any(Number), column: expect.any(Number) },
    } })
    const serialized = JSON.stringify(diagnostic)
    for (const path of [tmpdir(), await realpath(tmpdir()), stateRoot, await realpath(stateRoot)]) {
      expect(serialized).not.toContain(path)
    }
    expect(serialized).not.toMatch(/(?:bootstrap|access)-[A-Za-z0-9]{6}/)
  }
})

it('keeps every omitted-input scaffold byte identical to the shipped template', async () => {
  const root = await empty()
  const report = await bootstrapInstance(root, input)
  const { version } = JSON.parse(await readFile(resolve('packages/mcp/package.json'), 'utf8'))
  for (const { path } of report.files) {
    const original = await readFile(resolve('packages/mcp/templates/standalone', path === '.gitignore' ? 'gitignore' : path), 'utf8')
    expect(await readFile(join(root, path), 'utf8')).toBe(original.replaceAll('{{SDK_VERSION}}', version)
      .replaceAll('{{INSTANCE_ID}}', input.id).replaceAll('{{INSTANCE_SELECTOR}}', 'initial-roles')
      .replaceAll('{{INSTANCE_DISPLAY_NAME}}', JSON.stringify(input.id)))
  }
})

it('conflicts on existing source without filling missing scaffold files or changing the owner', async () => {
  const root = await empty()
  await bootstrapInstance(root, input)
  await rm(join(root, 'runtime.ts'))
  const before = await readFile(join(root, 'config.ts'))
  const report = await bootstrapInstance(root, { ...input, initialComposition })
  expect(report.files.some(file => file.status === 'conflict')).toBe(true)
  expect(report.files.some(file => file.status === 'created')).toBe(false)
  expect(await readFile(join(root, 'config.ts'))).toEqual(before)
  await expect(readFile(join(root, 'runtime.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a pre-existing target without publishing source', async () => {
  const root = await empty()
  await writeFile(join(root, 'target.sqlite'), 'existing-target')
  const report = await bootstrapInstance(root, { ...input, initialComposition })
  expect(report.files.every(file => file.status === 'conflict')).toBe(true)
  expect(await readFile(join(root, 'target.sqlite'), 'utf8')).toBe('existing-target')
  await expect(readFile(join(root, 'config.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['config.ts', 'runtime.ts', 'access.ts', 'schema/worker.ts'])('fences %s graph edits between initialization preview and apply', async path => {
  const { root, app, call } = await fixture(initialComposition)
  try {
    const preview = await call()
    expect(preview).toMatchObject({ ok: true })
    await writeFile(join(root, path), await readFile(join(root, path), 'utf8') + '\n// changed graph source\n')
    expect(await call('apply', preview.planHash)).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
    await expect(readFile(join(root, 'schema.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await app.server.close() }
})

it('rejects an independently edited runtime role list before initialization publication', async () => {
  const { root, app, call } = await fixture(initialComposition)
  try {
    const path = join(root, 'runtime.ts')
    await writeFile(path, (await readFile(path, 'utf8')).replace("'dispatcher'", "'other'"))
    expect(await call()).toMatchObject({ ok: false, error: { code: 'runtime_not_canonical' } })
    await expect(readFile(join(root, 'schema.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await app.server.close() }
})


it.each(['bun', 'node'])('discovers, bootstraps and reloads the initial graph through %s stdio', async runtime => {
  const root = await empty()
  async function connect() {
    const client = new Client({ name: 'bootstrap-initial-graph', version: '1' })
    const transport = new StdioClientTransport({ command: runtime, args: [
      ...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
      resolve('packages/mcp/src/stdio.ts'), '--root', root,
    ], stderr: 'pipe', env: { ...process.env } as Record<string, string> })
    transport.stderr?.on('data', () => {})
    await client.connect(transport)
    return { client, call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent as any,
      close: async () => { await client.close(); await transport.close() } }
  }
  const first = await connect()
  try {
    const tools = (await first.client.listTools()).tools
    expect(tools.find(tool => tool.name === 'bootstrap_instance')?.inputSchema.properties).toHaveProperty('initialComposition')
    expect(await first.call('bootstrap_instance', { ...input, initialComposition })).toMatchObject({ ok: true })
    await provisionLocalSdk(root)
    const preview = await first.call('initialize_instance', { instance: 'initial-roles' })
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, conflicts: [] })
    expect(await first.call('initialize_instance', { instance: 'initial-roles', mode: 'apply', planHash: preview.planHash }))
      .toMatchObject({ ok: true, status: 'initialized' })
    const access = JSON.parse(await readFile(join(root, 'access.lock.json'), 'utf8'))
    expect(JSON.stringify(access)).toContain('member')
    expect(await readFile(join(root, 'access.lock.md'), 'utf8')).toContain('owner')
    const openapi = await readFile(join(root, 'openapi.json'), 'utf8')
    for (const role of roles) expect(openapi).toContain('"' + role + '"')
  } finally { await first.close() }
  const restarted = await connect()
  try {
    expect(await restarted.call('inspect_schema', { instance: 'initial-roles' }))
      .toMatchObject({ ok: true, roles, organizationOwnerRole: 'owner', revision: 1, validation: { ok: true } })
    const before = await readFile(join(root, 'config.ts'))
    const retry = await restarted.call('bootstrap_instance', { ...input, initialComposition: { ...initialComposition, organizationOwnerRole: 'viewer' } })
    expect(retry).toMatchObject({ ok: true })
    expect(retry.files.every((file: any) => file.status === 'conflict')).toBe(true)
    expect(await readFile(join(root, 'config.ts'))).toEqual(before)
  } finally { await restarted.close() }
})

it('includes generated graph projections in initialization conflicts', async () => {
  const { root, app, call } = await fixture(initialComposition)
  try {
    const preview = await call()
    expect(await call('apply', preview.planHash)).toMatchObject({ ok: true })
    for (const path of ['access.lock.json', 'access.lock.md', 'openapi.json']) {
      await writeFile(join(root, path), 'conflicting generated projection')
    }
    const conflict = await call()
    expect(conflict).toMatchObject({ ok: true, conflicts: ['access.lock.json', 'access.lock.md', 'openapi.json'] })
    expect(await call('apply', conflict.planHash)).toMatchObject({ ok: false, error: { code: 'initialization_conflict' } })
    for (const path of conflict.conflicts) expect(await readFile(join(root, path), 'utf8')).toBe('conflicting generated projection')
  } finally { await app.server.close() }
})
