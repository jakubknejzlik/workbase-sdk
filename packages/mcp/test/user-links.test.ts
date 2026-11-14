import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../src/server'
import { prepare } from '../src/planning'
import { changeSchema } from '../src/schemas'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { instanceMeta } from '../src/offline'
import { configSource } from '../src/storage'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => cleanupTempDir(root))) })
it('add_user_link protects an optional user relation to populated domain rows through MCP validation, D1 verification and promotion', async () => {
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
      changes: [{ kind: 'add_user_link', entity: 'people' }] })
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
    expect(upgraded.config.entities.people.fields.user).toMatchObject({ type: 'ref', entity: 'users', required: false, userLink: true, readOnly: true })
    expect(upgraded.config.entities.people.relations.user_account).toEqual({ field: 'user', entity: 'users' })
    expect((await instanceMeta(upgraded)).revision).toBe(2)
  } finally { await client.close(); await application.server.close() }
})

const base = () => defineInstance({ id: 'links', revision: 1, roles: ['owner'], account: { entity: 'users' }, permissions: {},
  entities: { users: { fields: { name: { type: 'string' } } }, people: { fields: { name: { type: 'string' } } } } })
it('add_user_link is strict and expands to a nullable protected ref and declared relation', () => {
  const change = changeSchema.parse({ kind: 'add_user_link', entity: 'people' })
  expect(changeSchema.safeParse({ ...change, field: 'other' }).success).toBe(false)
  const result = prepare(base(), [], [change])
  expect(result.target.entities.people.fields.user).toEqual({ type: 'ref', entity: 'users', required: false, userLink: true, readOnly: true })
  expect(result.target.entities.people.relations.user_account).toEqual({ field: 'user', entity: 'users' })
  expect(result.sql).toContain('-- Rebuild people')
  expect(result.sql).not.toContain('CREATE UNIQUE INDEX')
  expect(base().entities.people.fields.user).toBeUndefined()
})
it('add_user_link refuses unknown/self targets, a non-users account, collisions and duplicate links', () => {
  for (const [config, entity, code] of [
    [base(), 'missing', 'unknown_entity'], [base(), 'users', 'invalid_user_link'],
    [{ ...base(), account: undefined }, 'people', 'invalid_user_link'],
    [{ ...base(), entities: { ...base().entities, people: { ...base().entities.people, fields: { name: { type: 'string', required: false }, user: { type: 'string', required: false } } } } }, 'people', 'field_exists'],
  ] as const) expect(() => prepare(config, [], [changeSchema.parse({ kind: 'add_user_link', entity })])).toThrow(expect.objectContaining({ code }))
  const once = prepare(base(), [], [changeSchema.parse({ kind: 'add_user_link', entity: 'people' })]).target
  expect(() => prepare(once, [], [changeSchema.parse({ kind: 'add_user_link', entity: 'people' })])).toThrow(expect.objectContaining({ code: 'user_link_exists' }))
  expect(() => prepare(once, [], [{ kind: 'rename_field', entity: 'people', from: 'user', to: 'account' }])).toThrow(expect.objectContaining({ code: 'protected_field' }))
})
it('add_user_link works for a new entity in the same proposal and refuses relation collisions', () => {
  const changes = [
    changeSchema.parse({ kind: 'add_entity', entity: 'staff', fields: { name: { type: 'string' } } }),
    changeSchema.parse({ kind: 'add_user_link', entity: 'staff' }),
  ]
  const result = prepare(base(), [], changes)
  expect(result.sql).toContain('CREATE TABLE "staff"')
  expect(result.sql).not.toContain('-- Rebuild staff')
  expect(result.target.entities.staff.fields.user).toMatchObject({ userLink: true, readOnly: true })
  const collision = base()
  collision.entities.people.fields.account = { type: 'ref', entity: 'users', required: false }
  collision.entities.people.relations.user_account = { field: 'account', entity: 'users' }
  expect(() => prepare(collision, [], [changeSchema.parse({ kind: 'add_user_link', entity: 'people' })])).toThrow(expect.objectContaining({ code: 'relation_exists' }))
})
