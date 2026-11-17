import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../src/server'
import { prepare } from '../src/planning'
import { changeSchema } from '../src/schemas'
import { CORE_VERSION, defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { instanceMeta, replay } from '../src/offline'
import { configSource } from '../src/storage'
import { checkMcpUpgrade } from '../../../scripts/lib/mcp-upgrade-check'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => cleanupTempDir(root))) })
async function fixture() {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'workbase-upgrade-')))
  roots.push(root)
  await cp(resolve('scripts/test/fixtures/sdk-0.2.1-revision-3'), root, { recursive: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  return root
}

it('W42 starts MCP on the real invalid revision-3 config and exposes diagnostics without edits', async () => {
  const root = await fixture()
  const before = await readFile(join(root, 'config.ts'), 'utf8')
  const application = await createServer({ root })
  const client = new Client({ name: 'upgrade-inspect', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await application.server.connect(b)
    await client.connect(a)
    const result = await client.callTool({ name: 'inspect_schema', arguments: { instance: 'workbase-test' } })
    expect(result.structuredContent).toMatchObject({ ok: true, revision: 3, validation: { ok: false, errors: expect.any(Array) } })
    expect((result.structuredContent as any).validation.errors).toHaveLength(7)
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(before)
  } finally { await client.close(); await application.server.close() }
})

it('W42 set_display_field changes existing entity metadata without rebuilding tables', () => {
  const change = { kind: 'set_display_field', entity: 'notes', displayField: 'summary' }
  expect(changeSchema.safeParse(change).success).toBe(true)
  const config = defineInstance({ id: 'metadata', revision: 1, roles: ['owner'], permissions: { owner: { notes: ['read'] } },
    entities: { notes: { fields: { title: { type: 'string' }, summary: { type: 'string' } } } } })
  const result = prepare(config, [], [changeSchema.parse(change)])
  expect(result.target.entities.notes.displayField).toBe('summary')
  expect(result.target.entities.notes.fields).toEqual(config.entities.notes.fields)
  expect(config.entities.notes.displayField).toBe('title')
  expect(result.sql).not.toMatch(/CREATE|ALTER|DROP|DELETE/i)
  expect(result.patch).toContainEqual({ op: 'replace', path: '/config/entities/notes/displayField', value: 'summary' })
})

it.each(['parent_id', 'secret', 'missing'])('W42 set_display_field rejects a ref, unreadable or unknown field: %s', displayField => {
  const config = defineInstance({ id: 'invalid_title', revision: 1, roles: ['viewer'], permissions: { viewer: { notes: ['read'] } },
    policies: { notes: { viewer: { where: {}, fields: ['id', 'title'] } } },
    entities: { notes: { fields: { title: { type: 'string', required: true }, secret: { type: 'string', sensitive: true }, parent_id: { type: 'ref', entity: 'notes' } } } } })
  expect(() => prepare(config, [], [{ kind: 'set_display_field', entity: 'notes', displayField }])).toThrow(expect.objectContaining({ code: 'invalid_input', details: [expect.objectContaining({ code: 'invalid_display_field', suggestedChange: { kind: 'set_display_field', entity: 'notes', displayField: 'title' } })] }))
  expect(config.entities.notes.displayField).toBe('title')
})

async function exemptEntityFixture() {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'workbase-exempt-display-')))
  roots.push(root)
  const config = defineInstance({ id: 'exempt', revision: 1, roles: ['owner'], permissions: {}, entities: {
    notes: { fields: { message: { type: 'text' }, secret: { type: 'string', sensitive: true }, parent_id: { type: 'ref', entity: 'parents' } } },
    parents: { displayField: 'id', fields: {} },
  } })
  expect(config.entities.notes.displayField).toBeUndefined()
  await mkdir(join(root, 'migrations'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'config.ts'), configSource(config))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(config))
  return { root, config, application: await createServer({ root }) }
}

it.each(['missing', 'secret', 'parent_id'])('W42 exempt entity rejects set_display_field at propose: %s', async displayField => {
  const { application, config } = await exemptEntityFixture()
  const change = { kind: 'set_display_field' as const, entity: 'notes', displayField }
  try {
    expect(await application.workflow.call('propose_change', { instance: 'exempt', baseRevision: 1, changes: [change] }))
      .toMatchObject({ ok: false, error: { code: 'invalid_input', details: [expect.objectContaining({ code: 'invalid_display_field', entity: 'notes' })] } })
    expect(() => prepare(config, [], [change])).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect((await application.workflow.call('inspect_schema', { instance: 'exempt' })).pendingProposals).toEqual([])
    expect((await application.store.load('exempt')).config.entities.notes.displayField).toBeUndefined()
  } finally { await application.server.close() }
})

it.each(['message', 'id'])('W42 exempt entity accepts readable scalar set_display_field at propose: %s', async displayField => {
  const { application } = await exemptEntityFixture()
  try {
    const proposal = await application.workflow.call('propose_change', { instance: 'exempt', baseRevision: 1,
      changes: [{ kind: 'set_display_field', entity: 'notes', displayField }] })
    expect(proposal).toMatchObject({ ok: true, status: 'proposed' })
    expect(await application.workflow.call('validate', { proposalId: proposal.proposalId })).toMatchObject({ ok: true, revision: 2 })
  } finally { await application.server.close() }
})

it('W42 display field proposal checks fields added and renamed earlier in the batch', async () => {
  const { application } = await exemptEntityFixture()
  try {
    const proposal = await application.workflow.call('propose_change', { instance: 'exempt', baseRevision: 1, changes: [
      { kind: 'add_field', entity: 'notes', field: 'label', definition: { type: 'string' } },
      { kind: 'set_display_field', entity: 'notes', displayField: 'label' },
      { kind: 'rename_field', entity: 'notes', from: 'message', to: 'caption' },
      { kind: 'set_display_field', entity: 'notes', displayField: 'caption' },
    ] })
    expect(proposal).toMatchObject({ ok: true, status: 'proposed' })
    expect(await application.workflow.call('validate', { proposalId: proposal.proposalId })).toMatchObject({ ok: true, revision: 2 })
  } finally { await application.server.close() }
})

it('W42 explicit display fields respect policy exclusions for id and reject sensitive scalars for privileged readers', () => {
  const config = defineInstance({ id: 'readable', revision: 1, roles: ['owner'], permissions: { owner: { notes: ['read'] } },
    policies: { notes: { owner: { where: {}, fields: ['title', 'secret'] } } },
    entities: { notes: { fields: { title: { type: 'string' }, secret: { type: 'string', sensitive: true } } } } })
  for (const displayField of ['id', 'secret']) expect(() => prepare(config, [], [{ kind: 'set_display_field', entity: 'notes', displayField }]))
    .toThrow(expect.objectContaining({ code: 'invalid_input', details: [expect.objectContaining({ code: 'invalid_display_field' })] }))
})

it('W42 accepts a partial display field repair proposal while other legacy entities still need repairs', async () => {
  const application = await createServer({ root: await fixture() })
  try {
    const inspected = await application.workflow.call('inspect_schema', { instance: 'workbase-test' })
    const [issue] = (inspected.validation as { errors: { suggestedChange: unknown }[] }).errors
    expect(await application.workflow.call('propose_change', { instance: 'workbase-test', baseRevision: 3, changes: [issue.suggestedChange] }))
      .toMatchObject({ ok: true, status: 'proposed' })
  } finally { await application.server.close() }
})

it.each([CORE_VERSION.replace(/\d+$/, patch => String(Number(patch) + 1)), '0.3.0', '1.0.0', 'broken'])('W42 upgrade baseline still rejects future or malformed SDK metadata: %s', async version => {
  const config = defineInstance({ id: 'version_gate', revision: 1, roles: ['owner'], entities: {}, permissions: {} })
  const sql = initialSchema(config) + `UPDATE instance_meta SET core_version = '${version}';\n`
  await expect(instanceMeta({ config, migrations: [{ name: '0001_initial.sql', sql }], indexes: [], fingerprint: '', guards: {} }))
    .rejects.toThrow(expect.objectContaining({ code: 'revision_mismatch' }))
})

it('W42 imports a legacy config that explicitly uses a ref as displayField and suggests a scalar repair', async () => {
  const root = await fixture()
  const source = (await readFile(join(root, 'config.ts'), 'utf8')).replace('"rezervace": {\n      "fields":', '"rezervace": {\n      "displayField": "zakaznik",\n      "fields":')
  await writeFile(join(root, 'config.ts'), source)
  const application = await createServer({ root })
  try {
    const result = await application.workflow.call('validate', { instance: 'workbase-test' })
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({
      entity: 'rezervace', suggestedChange: { kind: 'set_display_field', entity: 'rezervace', displayField: 'termin' },
    })]) })
    expect((await application.store.load('workbase-test')).config.entities.rezervace.displayField).toBe('zakaznik')
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(source)
  } finally { await application.server.close() }
})

it('W42 real 0.2.1 fixture upgrades through stdio MCP: validate → repair → preview → verify → promote, preserving data and history', async () => {
  const root = await fixture()
  const client = new Client({ name: 'upgrade-stdio', version: '1' })
  const transport = new StdioClientTransport({ command: 'node', args: ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'), resolve('packages/mcp/src/stdio.ts'), '--root', root], stderr: 'pipe',
    env: { ...process.env, WORKBASE_MCP_DEV_MODULE: '', WORKBASE_MCP_STATE_ROOT: join(root, 'state') } as Record<string, string> })
  transport.stderr?.on('data', () => {})
  try {
    await client.connect(transport)
    await checkMcpUpgrade(client, root)
  } finally { await client.close(); await transport.close() }
})

it('adds an optional user relation to populated domain rows through MCP validation, D1 verification and promotion', async () => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'workbase-nullable-ref-'))); roots.push(root)
  const config = defineInstance({ id: 'nullable_user_link', revision: 1, roles: ['owner'], account: { entity: 'users' },
    permissions: { owner: { users: ['read'], people: ['read', 'create', 'update'] } },
    policies: { users: { owner: 'all' }, people: { owner: 'all' } },
    entities: {
      users: { fields: { name: { type: 'string', required: true } } },
      people: { fields: { name: { type: 'string', required: true } } },
    },
  })
  const initial = initialSchema(config)
  const seed = `INSERT INTO organizations VALUES ('org-a','A');
INSERT INTO users (id,organization_id,name,created_at,updated_at) VALUES ('account-a','org-a','Account','now','now');
INSERT INTO people (id,organization_id,name,created_at,updated_at,version) VALUES ('person-a','org-a','Existing person','created','updated',3);
CREATE INDEX people_name_idx ON people (organization_id, name);\n`
  await mkdir(join(root, 'migrations'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'config.ts'), configSource(config))
  await writeFile(join(root, 'config.indexes.json'), JSON.stringify([{ entity: 'people', name: 'people_name_idx', fields: ['name'] }]))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initial)
  await writeFile(join(root, 'migrations/0002_seed.sql'), seed)
  const application = await createServer({ root })
  const client = new Client({ name: 'nullable-ref-upgrade', version: '1' })
  const instance = config.id.replaceAll('_', '-')
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await application.server.connect(b); await client.connect(a)
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as any
    const inspected = await call('inspect_schema', { instance })
    expect(inspected, JSON.stringify(inspected)).toMatchObject({ ok: true, revision: 1 })
    const proposal = await call('propose_change', { instance, baseRevision: 1,
      changes: [{ kind: 'add_relation', entity: 'people', name: 'user_account', field: 'user', target: 'users' }] })
    expect(proposal).toMatchObject({ ok: true, status: 'proposed' })
    const args = { proposalId: proposal.proposalId }
    expect(await call('validate', args)).toMatchObject({ ok: true, errors: [], revision: 2 })
    const preview = await call('preview_migration', args)
    expect(preview).toMatchObject({ ok: true, revision: 2 })
    expect(preview.sql).toContain('FOREIGN KEY (organization_id, "user") REFERENCES "users"(organization_id, id)')
    const verified = await call('apply_to_disposable', { ...args, keep: true })
    if (verified.directory) roots.push(verified.directory)
    expect(verified).toMatchObject({ ok: true, verified: true, diffs: [] })
    // Inspect the actual Wrangler/Miniflare database, including its pre-upgrade
    // records, rather than relying on the schema-only verification result.
    const persistence = join(verified.directory, 'persist/v3/d1')
    const databases = (await readdir(persistence, { recursive: true })).filter(path => /[a-f0-9]{64}\.sqlite$/.test(path))
    expect(databases).toHaveLength(1)
    const db = new DatabaseSync(join(persistence, databases[0]), { readOnly: true })
    try {
      expect(db.prepare('SELECT count(*) n FROM people').get()).toEqual({ n: 1 })
      expect(db.prepare('SELECT * FROM people').get()).toEqual({ id: 'person-a', organization_id: 'org-a', name: 'Existing person', user: null, created_at: 'created', updated_at: 'updated', version: 3 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA index_info(people_name_idx)').all().map(row => row.name)).toEqual(['organization_id', 'name'])
    } finally { db.close() }
    const promoted = await call('promote', { ...args, expectedRevision: 1 })
    expect(promoted).toMatchObject({ ok: true, revision: 2, appliesToDatabase: false })
    expect(await readFile(join(root, 'migrations', promoted.migration), 'utf8')).toBe(preview.sql)
    expect(await readFile(join(root, 'migrations/0001_initial.sql'), 'utf8')).toBe(initial)
    expect(await readFile(join(root, 'migrations/0002_seed.sql'), 'utf8')).toBe(seed)
    const upgraded = await application.store.load(instance)
    expect(upgraded.config.entities.people.fields.user).toMatchObject({ type: 'ref', entity: 'users', required: false })
    expect(upgraded.config.entities.people.relations.user_account).toEqual({ field: 'user', entity: 'users' })
    expect((await instanceMeta(upgraded)).revision).toBe(2)
  } finally { await client.close(); await application.server.close() }
})

it('metadata-only MCP preview upgrades a 0.1.0 marker through the shared revision writer', async () => {
  const config = defineInstance({ id: 'version_marker', revision: 3, interactive: false, roles: ['owner'], entities: {} })
  const migrations = [{ name: '0001_initial.sql', sql: initialSchema(config).replace(`'${CORE_VERSION}'`, "'0.1.0'") }]
  const bundle = { config, migrations, indexes: [], fingerprint: '', guards: {} }
  expect(await instanceMeta(bundle)).toMatchObject({ revision: 3, core_version: '0.1.0' })
  const preview = prepare(config, [], [{ kind: 'set_locale', locale: 'cs' }])
  expect(preview.sql).toMatch(/INSERT INTO instance_meta VALUES \(4,/)
  expect(preview.sql).not.toMatch(/\b(?:CREATE|ALTER|DROP|DELETE|UPDATE)\b/i)
  replay([...migrations, { name: 'preview.sql', sql: preview.sql }], db => {
    expect(db.prepare('SELECT revision,core_version FROM instance_meta ORDER BY revision').all()).toEqual([
      { revision: 3, core_version: '0.1.0' }, { revision: 4, core_version: CORE_VERSION },
    ])
  })
})
