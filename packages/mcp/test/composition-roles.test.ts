import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { getPlatformProxy } from 'wrangler'
import { createApp } from '@workbasehq/core/app'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { migrateInstance, readMigrationFiles } from '@workbasehq/core/infra'
import { splitStatements } from '@workbasehq/core/kernel/migrations'
import { sha256 } from '@workbasehq/core/crypto'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { loadConfig } from '@workbasehq/core/schema/load'
import { effectiveEntityGrants, effectiveSystemGrant } from '../../core/src/access-evaluator.ts'
import { createServer } from '../src/server.ts'
import { Store } from '../src/storage.ts'
import { replayEngine } from '../src/offline.ts'
import { replayInstance } from '../src/migration-replay.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'
import { replaceLiteral } from '../src/composition/literal-edit.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})
const instance = 'roles-fixture'
const roles = ['owner', 'dispatcher', 'viewer', 'member']
const setRoles = { kind: 'set_roles', roles, organizationOwnerRole: 'owner' }
const denySystem = Object.fromEntries(accessSystemActions.map(action => [action, 'deny']))
const allowSystem = Object.fromEntries(accessSystemActions.map(action => [action, 'allow']))
const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' }
const restricted = { read: { where: { user: { eq: '$actor.id' } }, fields: ['name'] }, create: 'deny', update: 'deny', delete: 'deny' }
const link = { kind: 'set_account_link', entity: 'worker', invitationRole: 'dispatcher' }
const changes = [
  // Deliberately put grants before set_roles: compilation must see the final graph.
  { kind: 'set_entity_access', entity: 'worker', role: 'dispatcher', access: restricted },
  link, setRoles,
  { kind: 'set_system_access', role: 'owner', grants: allowSystem },
  ...[...accessEntities, 'worker'].map(entity => ({ kind: 'set_entity_access', entity, role: 'owner', access: all })),
]
type Call = (name: string, args: Record<string, unknown>) => Promise<any>
async function session(root: string, runtime?: string, environment: Record<string, string> = {}) {
  const client = new Client({ name: 'roles-contract', version: '1' })
  const errors: unknown[] = []
  client.onerror = error => errors.push(error)
  let close: () => Promise<unknown>
  if (runtime) {
    const transport = new StdioClientTransport({ command: runtime, args: [
      ...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
      resolve('packages/mcp/src/stdio.ts'), '--root', root,
    ], stderr: 'pipe', env: { ...process.env, ...environment } as Record<string, string> })
    transport.stderr?.on('data', () => {})
    await client.connect(transport)
    close = async () => { await client.close(); await transport.close() }
  } else {
    const app = await createServer({ root })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await app.server.connect(b); await client.connect(a)
    close = async () => { await client.close(); await app.server.close() }
  }
  cleanups.push(close)
  const discovery = await client.listTools()
  expect(JSON.stringify(discovery.tools.find(tool => tool.name === 'propose_change')?.inputSchema)).toContain('set_roles')
  const call: Call = async (name, args) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent
  return { call, close, errors }
}
async function accepted(call: Call, name: string, args: Record<string, unknown>) {
  const result = await call(name, args)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  return result
}
async function fixture(runtime?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'composition-roles-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  // The target is independently provisioned from the initialized base, never
  // inferred from the disposable used to verify a proposal.
  const targetPath = join(root, 'target.sqlite')
  const environment = { WORKBASE_MCP_ROLE_DATABASES: JSON.stringify({ [instance]: targetPath }) }
  vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', environment.WORKBASE_MCP_ROLE_DATABASES)
  const connection = await session(root, runtime, environment)
  await accepted(connection.call, 'bootstrap_instance', { id: 'roles_fixture', target: 'cloudflare-github' })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  for (const path of ['config.ts', 'access.ts', 'schema/worker.ts', 'runtime.ts']) {
    await writeFile(join(root, path), '// authored header: žluťoučký\r\n' + await readFile(join(root, path), 'utf8') + '\n// authored footer\n')
  }
  const preview = await accepted(connection.call, 'initialize_instance', { instance, mode: 'preview' })
  await accepted(connection.call, 'initialize_instance', { instance, mode: 'apply', planHash: preview.planHash })
  const store = new Store(root); await store.init()
  const bundle = await store.load(instance, { canonicalRuntime: true })
  const db = new DatabaseSync(targetPath)
  try {
    await replayInstance(db, bundle.migrations, replayEngine(bundle.config, bundle.runtime))
    // Provision an explicitly empty synthetic target. Members' migration seeds
    // an empty "instance" organization; it too counts as populated for safety.
    expect(db.prepare('SELECT id FROM organizations').all()).toEqual([{ id: 'instance' }])
    expect(db.prepare('SELECT 1 FROM memberships').all()).toEqual([])
    db.exec("DELETE FROM organization_scopes WHERE scope_id='instance'; DELETE FROM organizations WHERE id='instance'")
  }
  finally { db.close() }
  const propose = async (operations: unknown[] = changes) => (await accepted(connection.call, 'propose_change', { instance, baseRevision: 1, changes: operations })).proposalId as string
  return { root, store, targetPath, propose, ...connection }
}

it.each(['bun', 'node'])('authors the four-role graph entirely through %s MCP and reloads every projection', async runtime => {
  const { root, targetPath, call, close, errors, propose } = await fixture(runtime)
  const targetBefore = await readFile(targetPath)
  const paths = ['config.ts', 'access.ts', 'schema/worker.ts', 'runtime.ts']
  const before = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(join(root, path), 'utf8')])))
  const immutable = ['schema.lock.json', ...(await readdir(join(root, 'migrations'))).map(path => `migrations/${path}`)]
  const physicalBefore = await Promise.all(immutable.map(path => readFile(join(root, path))))
  const proposalId = await propose()
  await accepted(call, 'validate', { proposalId })
  const preview = await accepted(call, 'preview_migration', { proposalId })
  expect(preview.sql).toBe('')
  expect(preview.roleDiff.roles).toEqual({ before: ['admin', 'staff'], after: roles })
  expect(preview.roleDiff.removedRows).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: 'access.ts', path: ['roles', 'admin'], after: null }),
    expect.objectContaining({ file: 'schema/worker.ts', path: ['access', 'staff'], after: null }),
  ]))
  expect(preview.roleDiff.removedRows).toHaveLength(2 * (1 + accessEntities.length + 1))
  await accepted(call, 'apply_to_disposable', { proposalId })
  await accepted(call, 'promote', { proposalId, expectedRevision: 1 })
  // Exercise the existing submission file allowlist without configuring or
  // contacting GitHub; the promoted role graph must reach the provider boundary.
  expect(await call('submit_change', { instance, proposalId, expectedBaseSha: 'a'.repeat(40) })).toMatchObject({ ok: false, error: { code: 'github_not_configured' } })
  expect(await Promise.all(immutable.map(path => readFile(join(root, path))))).toEqual(physicalBefore)
  expect((await readdir(join(root, 'migrations'))).filter(path => path.endsWith('.sql'))).toEqual(['0001_r1.sql'])
  expect(await readFile(targetPath)).toEqual(targetBefore)
  const loaded = await loadConfig(join(root, 'config.ts'))
  expect(loaded.config.roles).toEqual(roles)
  expect(loaded.config.entities.users.fields.role.values).toEqual(roles)
  expect(parseRuntimeSource(await readFile(join(root, 'runtime.ts'), 'utf8')).plugins.find(plugin => plugin.plugin === 'permissions')?.options)
    .toEqual({ roles, ownerRole: 'owner' })
  const policy = loaded.config.effectiveAccess!
  expect(effectiveSystemGrant(policy, ['owner'], 'members.update')).toBe(true)
  for (const role of ['dispatcher', 'viewer', 'member']) {
    expect(effectiveSystemGrant(policy, [role], 'members.update')).toBe(false)
    expect(effectiveEntityGrants(policy, [role], 'worker', 'update')).toEqual([])
  }
  expect(effectiveEntityGrants(policy, ['dispatcher'], 'worker', 'read')).toEqual([
    expect.objectContaining({ where: { user: { eq: '$actor.id' } }, fields: ['id', 'name'] }),
  ])
  // Restore only the intended literal spans; every other authored byte matches.
  let restoredConfig = await readFile(join(root, 'config.ts'), 'utf8')
  restoredConfig = replaceLiteral(restoredConfig, ['roles'], ['admin', 'staff'], 'config.ts', { config: true })
  restoredConfig = replaceLiteral(restoredConfig, ['organizationOwnerRole'], 'admin', 'config.ts', { config: true })
  const canonicalBefore = replaceLiteral(replaceLiteral(before['config.ts'], ['roles'], ['admin', 'staff'], 'config.ts', { config: true }), ['organizationOwnerRole'], 'admin', 'config.ts', { config: true })
  expect(restoredConfig).toBe(canonicalBefore)
  for (const [path, spans] of [
    ['access.ts', [['roles'], ['entities'], ['accountLinks']]],
    ['schema/worker.ts', [['access']]],
  ] as const) {
    const mask = (source: string) => spans.reduce((text, span) => replaceLiteral(text, span, 'intended edit', path), source)
    expect(mask(await readFile(join(root, path), 'utf8'))).toBe(mask(before[path]))
  }
  expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(before['runtime.ts'].replace("roles: ['admin', 'staff'], ownerRole: 'admin'", "roles: ['owner', 'dispatcher', 'viewer', 'member'], ownerRole: 'owner'"))
  for (const script of ['check:access', 'check:schema', 'check:openapi']) {
    const result = spawnSync('bun', ['run', script], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }
  // Check the authored graph's types without requiring generated SST/UI setup.
  const typecheck = spawnSync('bun', ['x', '--no-install', 'tsc', '--ignoreConfig', '--noEmit', '--allowImportingTsExtensions', '--jsx', 'react-jsx', '--lib', 'es2023,dom,dom.iterable', '--types', 'node,@cloudflare/workers-types', '--strict', '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop', '--moduleResolution', 'bundler', '--module', 'esnext', '--target', 'es2023', 'config.ts', 'runtime.ts'], { cwd: root, encoding: 'utf8' })
  expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0)
  expect(errors).toEqual([])
  await close()
  const restarted = await session(root, runtime)
  const inspected = await accepted(restarted.call, 'inspect_schema', { instance })
  expect(inspected).toMatchObject({ roles, organizationOwnerRole: 'owner', revision: 1, validation: { ok: true } })
  expect(inspected.entities.users.fields.role.values).toEqual(roles)
  expect(restarted.errors).toEqual([])
  if (runtime === 'bun') await runtimeContract(root)
})


// Exercise the exact promoted runtime on a separate local D1. This database is
// populated only after promotion and never supplies role-change safety evidence.
async function runtimeContract(root: string) {
  const store = new Store(root); await store.init()
  const bundle = await store.load(instance, { canonicalRuntime: true })
  const proxy = await getPlatformProxy({ configPath: join(root, 'wrangler.jsonc'), remoteBindings: false, persist: { path: join(root, 'runtime-state') } })
  try {
    const db = proxy.env.DB as unknown as D1Database
    const kernel = new KernelRegistry(bundle.runtime!)
    await migrateInstance(sql => db.batch(splitStatements(sql).map(statement => db.prepare(statement))), await readMigrationFiles(join(root, 'migrations')), kernel)
    await db.prepare("INSERT INTO organizations VALUES ('org','Synthetic')").run()
    for (const role of ['owner', 'dispatcher']) {
      await db.prepare('INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(role, 'org', `${role}@example.test`, role, role, 'now', 'now').run()
      await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, 'now', 'now').run()
      await db.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org', role).run()
      await db.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${role}`), role, '2099-01-01T00:00:00.000Z').run()
      await db.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(role, role).run()
    }
    for (const [id, actor] of [['linked', 'dispatcher'], ['unlinked', 'owner']]) {
      await db.prepare('INSERT INTO worker (id,organization_id,name,user,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, 'org', id, actor, 'now', 'now').run()
    }
    const app = createApp(bundle.runtime!, { DB: db, AUDIT_KV: proxy.env.AUDIT_KV as unknown as KVNamespace,
      IDENTITY: { baseURL: 'http://localhost', secret: randomUUID() + randomUUID(), localPassword: true } })
    const request = (path: string, role = 'owner', method = 'GET', body?: unknown) => app.request(`http://localhost${path}`, { method,
      headers: { Authorization: `Bearer synthetic-${role}`, 'X-Organization-Id': 'org', 'Content-Type': 'application/json', Origin: 'http://localhost' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const members = await request('/orgs/org/members?include=pending')
    expect(members.status, await members.clone().text()).toBe(200)
    const view = await members.json() as any
    expect(view.role_options).toEqual(roles.map(id => ({ id, administrator: id === 'owner' })))
    expect(view.data.find((member: any) => member.role === 'owner').last_administrator).toBe(true)
    const list = await request('/api/worker', 'dispatcher')
    expect(list.status, await list.clone().text()).toBe(200)
    const rows = (await list.json() as any).data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'linked', name: 'linked' })
    expect(rows[0]).not.toHaveProperty('user')
    expect((await request('/api/worker/unlinked', 'dispatcher')).status).toBe(404)
    expect((await request('/api/worker/linked', 'dispatcher', 'PATCH', { name: 'Denied' })).status).toBe(403)
    const owned = await request('/api/worker/linked', 'owner', 'PATCH', { name: 'Explicit owner grant', version: 1 })
    expect(owned.status, await owned.clone().text()).toBe(200)
  } finally { await proxy.dispose() }
}

it('new roles, including owner, receive no role-name inheritance or implicit member', async () => {
  const { call, propose } = await fixture()
  const proposalId = await propose([setRoles, link, { kind: 'set_interactive', interactive: false }, { kind: 'set_entity_access', entity: 'worker', role: 'dispatcher', access: restricted }])
  await accepted(call, 'validate', { proposalId })
  const preview = await accepted(call, 'preview_migration', { proposalId })
  expect(preview.composition.plugins.find((plugin: any) => plugin.plugin === 'permissions').options).toEqual({ roles, ownerRole: 'owner' })
  const lock = JSON.parse(preview.files.find((file: any) => file.path === 'access.lock.json').data)
  expect(lock.effectiveAccess.system.every((grant: any) => grant.decision === 'deny')).toBe(true)
  expect(lock.effectiveAccess.entities.filter((grant: any) => grant.role === 'owner').every((grant: any) => grant.decision === 'deny')).toBe(true)
  const exact = await propose([{ ...setRoles, roles: ['admin', 'staff', 'viewer'], organizationOwnerRole: 'admin' }])
  await accepted(call, 'validate', { proposalId: exact })
  const next = await accepted(call, 'preview_migration', { proposalId: exact })
  expect(next.composition.plugins.find((plugin: any) => plugin.plugin === 'permissions').options.roles).toEqual(['admin', 'staff', 'viewer'])
})

it('rejects invalid role declarations, unknown grant roles, incomplete matrices and unresolved account links', async () => {
  const { call } = await fixture()
  const bad = [
    { ...setRoles, roles: [] }, { ...setRoles, roles: ['owner', 'owner'] },
    { ...setRoles, roles: [''] }, { ...setRoles, roles: ['Owner'] },
    { ...setRoles, organizationOwnerRole: 'missing' },
  ]
  for (const change of bad) expect(await call('propose_change', { instance, baseRevision: 1, changes: [change] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  for (const [operations, code, message] of [
    [[setRoles], 'role_reference_unresolved', /set_account_link/],
    [[setRoles, link, { kind: 'set_entity_access', entity: 'worker', role: 'ghost', access: 'deny' }], 'invalid_access', /Unknown access role: ghost/],
    [[...changes, { kind: 'set_system_access', role: 'owner', grants: { 'audit.read': 'allow' } }], 'invalid_access', /Missing explicit system action/],
    [[setRoles, setRoles], 'invalid_input', /only one set_roles/],
  ] as const) {
    expect(await call('propose_change', { instance, baseRevision: 1, changes: operations })).toMatchObject({ ok: false, error: { code, message: expect.stringMatching(message) } })
  }
})

it('refuses unresolved navigation roles with the owning declaration and remedy', async () => {
  const { root, call } = await fixture()
  const path = join(root, 'config.ts')
  await writeFile(path, replaceLiteral(await readFile(path, 'utf8'), ['ui'], { entities: {}, navigation: { groups: [], items: [{ id: 'worker', entity: 'worker', roles: ['staff'] }] } }, path, { config: true }))
  expect(await call('propose_change', { instance, baseRevision: 1, changes })).toMatchObject({ ok: false, error: { code: 'role_reference_unresolved', message: expect.stringContaining('ui.navigation.items.worker.roles') } })
})

it('refuses role authoring over a stale physical schema lock', async () => {
  const { root, call } = await fixture()
  const path = join(root, 'schema/worker.ts')
  await writeFile(path, (await readFile(path, 'utf8')).replace('fields: { name:', "fields: { extra: { type: 'text' }, name:"))
  expect(await call('propose_change', { instance, baseRevision: 1, changes })).toMatchObject({ ok: false, error: { code: 'schema_lock_mismatch' } })
})

it.each(['memberships', 'invitations', 'access_tokens'])('checks removed-role references in historical %s at verification and promotion', async table => {
  const { call, propose, targetPath } = await fixture()
  const proposalId = await propose([{ ...setRoles, roles: ['admin', 'viewer'], organizationOwnerRole: 'admin' },
    { ...link, invitationRole: 'viewer' }, { kind: 'set_entity_access', entity: 'worker', role: 'viewer', access: restricted }])
  await accepted(call, 'validate', { proposalId })
  await accepted(call, 'apply_to_disposable', { proposalId })
  const db = new DatabaseSync(targetPath)
  try {
    db.exec("INSERT INTO organizations VALUES ('org','Org'); INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES ('actor','org','actor@example.test','Actor','admin','now','now');")
    if (table === 'memberships') db.exec("INSERT INTO memberships VALUES ('actor','org','staff')")
    if (table === 'invitations') db.exec("INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,revoked_at) VALUES ('i','org','recipient@example.test','staff','digest','2000','actor','2000')")
    if (table === 'access_tokens') db.exec("INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,revoked_at,created_at) VALUES ('t','org','actor','Synthetic','digest','prefix','staff','2000','2000','now')")
  } finally { db.close() }
  for (const tool of ['promote', 'apply_to_disposable']) {
    expect(await call(tool, { proposalId, ...(tool === 'promote' ? { expectedRevision: 1 } : {}) })).toMatchObject({ ok: false, error: { code: 'role_in_use', message: expect.stringContaining(table) } })
  }
})

it('checks owner-only transitions on the independent target again at promotion', async () => {
  const { call, propose, targetPath } = await fixture()
  const proposalId = await propose([{ kind: 'set_roles', roles: ['admin', 'staff'], organizationOwnerRole: 'staff' }, { ...link, invitationRole: 'admin' }])
  await accepted(call, 'validate', { proposalId })
  await accepted(call, 'apply_to_disposable', { proposalId })
  vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', '{}')
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
  vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', JSON.stringify({ [instance]: targetPath }))
  const db = new DatabaseSync(targetPath)
  try { db.exec("INSERT INTO organizations VALUES ('org','Org')") } finally { db.close() }
  for (const tool of ['promote', 'apply_to_disposable']) expect(await call(tool, { proposalId, ...(tool === 'promote' ? { expectedRevision: 1 } : {}) }))
    .toMatchObject({ ok: false, error: { code: 'owner_change_requires_fresh_target' } })
})

it('fails closed on missing, unreadable or incomplete target evidence even with a caller fresh flag', async () => {
  const { root, call, propose } = await fixture()
  const proposalId = await propose()
  await accepted(call, 'validate', { proposalId })
  for (const path of ['', 'relative.sqlite', join(root, 'missing.sqlite'), join(root, 'empty.sqlite')]) {
    if (path.endsWith('empty.sqlite')) new DatabaseSync(path).close()
    vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', JSON.stringify({ [instance]: path }))
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
  }
  expect(await call('apply_to_disposable', { proposalId, fresh: true })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})

it('fingerprints every role source and artifact and retains journal recovery for the complete publication', async () => {
  const { root, store, call, propose } = await fixture()
  const proposalId = await propose()
  await accepted(call, 'validate', { proposalId })
  const preview = await accepted(call, 'preview_migration', { proposalId })
  await accepted(call, 'apply_to_disposable', { proposalId })
  for (const path of ['config.ts', 'runtime.ts', 'access.ts', 'schema/worker.ts', 'access.lock.json', 'access.lock.md', 'openapi.json', 'schema.lock.json', 'migrations/0001_r1.sql', 'package.json']) {
    const before = await readFile(join(root, path))
    await writeFile(join(root, path), Buffer.concat([before, Buffer.from('\n')]))
    expect(await call('promote', { proposalId, expectedRevision: 1 }), path).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    await writeFile(join(root, path), before)
  }
  const files = [...preview.files, { path: `proposals/${proposalId}.json`, data: 'injected fault\n' }]
  const before = await Promise.all(files.map((file: any) => readFile(join(root, file.path))))
  const bundle = await store.load(instance, { canonicalRuntime: true })
  await expect(store.commit(instance, files, bundle.guards, async () => { throw new Error('publication interrupted') })).rejects.toThrow('publication interrupted')
  await store.recover(root)
  expect(await Promise.all(files.map((file: any) => readFile(join(root, file.path))))).toEqual(before)
  await accepted(call, 'promote', { proposalId, expectedRevision: 1 })
  expect(await accepted(call, 'inspect_schema', { instance })).toMatchObject({ roles, organizationOwnerRole: 'owner' })
})
