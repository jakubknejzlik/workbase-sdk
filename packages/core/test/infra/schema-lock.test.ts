import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { loadConfig } from '../../src/schema/load'
import { diffSpecs, schemaLock, lockBytes, checkSchema } from '../../src/migrations/schema-lock'
import { runSchemaCli } from '../../src/migrations/schema-cli'
import { physicalTable, renderTable } from '../../src/migrations/schema'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { instanceConfigSchema, fieldSchema, defineInstance, type InstanceConfig } from '../../src/config'
import { sdkDependencies } from '../../src/migrations/schema-lock'
import { initialSchema } from '../../src/migrations/schema'
import { vi } from 'vitest'
import { defineConfig, declarationSchema } from '../../src/schema'
import fixture from '../fixtures/config-era/config'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'schema-lock-')); roots.push(root)
  cpSync(resolve('packages/core/test/fixtures/config-era'), root, { recursive: true })
  rmSync(join(root, 'schema.lock.json'), { force: true })
  rmSync(join(root, 'migrations'), { force: true, recursive: true })
  return root
}
it('initializes final bundle and r1 lock; unchanged rerun preserves bytes; init refuses existing state', async () => {
  const root = fresh(), args = ['--root', root]
  await expect(runSchemaCli('plan', args)).rejects.toThrow('--init')
  expect(await runSchemaCli('plan', [...args, '--init'])).toBe(0)
  const lock = readFileSync(join(root, 'schema.lock.json'), 'utf8')
  const sql = readFileSync(join(root, 'migrations/0001_r1.sql'), 'utf8')
  expect(JSON.parse(lock)).toMatchObject({ lockVersion: 1, revision: 1, parent: null })
  expect(sql).toMatch(/^-- workbase:migration r1 parent=none manual=none\n-- workbase:begin pre-data\n-- workbase:end pre-data\n-- workbase:begin generated\nCREATE TABLE/)
  expect(sql).toMatch(/-- workbase:end generated\n-- workbase:begin post-data\n-- workbase:end post-data\n$/)
  expect(sql).not.toMatch(/instance_meta|CREATE TABLE "users"|core_version/)
  expect(await runSchemaCli('plan', args)).toBe(0)
  await expect(runSchemaCli('plan', [...args, '--init'])).rejects.toThrow('already exists')
  expect(readFileSync(join(root, 'schema.lock.json'), 'utf8')).toBe(lock)
  expect(readFileSync(join(root, 'migrations/0001_r1.sql'), 'utf8')).toBe(sql)
})
it('diff creates tables including refs and appends safe columns with revision binding', () => {
  const base = schemaLock(fixture)
  const next = structuredClone(fixture)
  next.entities.worker.fields.z = { type: 'text', required: false }
  next.entities.worker.fields.a = { type: 'int', required: true, default: 0 }
  next.entities.other = next.entities.worker
  const lock = schemaLock(next, base)
  expect(lock.revision).toBe(2)
  expect(lock.tables.map(t => t.name)).toEqual(['other', 'worker'])
  expect(lock.tables[1].columns.map(c => c.name)).toEqual([...base.tables[0].columns.map(c => c.name), 'a', 'z'])
  expect(diffSpecs(base.tables, lock.tables)).toContain('ADD COLUMN "a" INTEGER NOT NULL DEFAULT 0')
  expect(diffSpecs(base.tables, lock.tables)).toContain('REFERENCES "users"')
  expect(schemaLock(next, lock).revision).toBe(2)
})
it('rejects caller revision in defineConfig, while the loader binds the lock revision', async () => {
  expect(() => defineConfig({ revision: 9 } as never)).toThrow('revision')
  expect(defineInstance({ id: 'legacy', revision: 9, entities: {} }).revision).toBe(9)
  const root = fresh(), lock = schemaLock(fixture)
  writeFileSync(join(root, 'schema.lock.json'), lockBytes({ ...lock, revision: 7 }))
  expect((await loadConfig(join(root, 'config.ts'))).config.revision).toBe(7)
})
it('check:schema identifies lock and config drift without writing', async () => {
  const root = fresh(), args = ['--root', root]
  await runSchemaCli('plan', [...args, '--init'])
  const path = join(root, 'schema.lock.json'), original = readFileSync(path, 'utf8')
  const lock = JSON.parse(original); lock.tables[0].columns.find((c: { name: string }) => c.name === 'name').sqlType = 'REAL'
  writeFileSync(path, lockBytes(lock))
  expect(() => checkSchema((fixture), lock)).toThrow('worker.name')
  expect(await runSchemaCli('check', args)).toBe(1)
  expect(readFileSync(path, 'utf8')).toBe(lockBytes(lock))
  writeFileSync(path, original)
  const entity = join(root, 'schema/worker.ts')
  writeFileSync(entity, readFileSync(entity, 'utf8').replace("type: 'text'", "type: 'int'"))
  expect(await runSchemaCli('check', args)).toBe(1)
  rmSync(path); rmSync(join(root, 'migrations'), { recursive: true })
  await runSchemaCli('plan', [...args, '--init'])
  expect(await runSchemaCli('check', args)).toBe(0)
})
it('renderTable takes only TableSpec', () => {
  expect(renderTable(physicalTable('worker', fixture.entities.worker))).toContain('CREATE TABLE "worker"')
  // @ts-expect-error Config entities cannot enter the SQL renderer.
  if (false) renderTable(fixture.entities.worker)
})

it('rejects init over domain migrations even with no lock', async () => {
  const root = fresh()
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(root, 'migrations')); writeFileSync(join(root, 'migrations/0001_old.sql'), '-- old')
  await expect(runSchemaCli('plan', ['--root', root, '--init'])).rejects.toThrow('no domain migrations')
})
it('field reordering preserves initial and base-ordered lock and SQL; SDK dependencies are derived', () => {
  const next = structuredClone(fixture)
  next.entities.worker.fields = Object.fromEntries(Object.entries(next.entities.worker.fields).reverse())
  const base = schemaLock(fixture)
  expect(lockBytes(schemaLock(next))).toBe(lockBytes(base))
  expect(lockBytes(schemaLock(next, base))).toBe(lockBytes(base))
  expect(initialSchema(next)).toBe(initialSchema(fixture))
  expect(sdkDependencies(base.tables)).toEqual(['organizations', 'users'])
})
const rejected: [string, (config: InstanceConfig) => void, string][] = [
  ['drop table', c => { delete c.entities.worker }, 'worker'],
  ['rename table', c => { c.entities.renamed = c.entities.worker; delete c.entities.worker }, 'worker'],
  ['nullability', c => { c.entities.worker.fields.name.required = false }, 'worker.name'],
  ['FK target', c => { c.entities.worker.fields.user.entity = 'other' }, 'worker.user'],
  ['drop column', c => { delete c.entities.worker.fields.name }, 'worker.name'],
  ['type', c => { c.entities.worker.fields.name.type = 'int' }, 'worker.name'],
  ['default', c => { c.entities.worker.fields.name.default = 'x' }, 'worker.name'],
  ['column check', c => { c.entities.worker.fields.name.min = 1 }, 'worker.name'],
  ['table check', c => { c.entities.worker.checks = [{ left: 'name', op: '<=', right: 'name' }] }, 'worker'],
  ['rename', c => { c.entities.worker.fields.renamed = c.entities.worker.fields.name; delete c.entities.worker.fields.name }, 'worker.name'],
  ['renameFrom', c => { c.entities.worker.fields.name.renameFrom = 'old' }, 'worker.name'],
  ['backfillFrom', c => { c.entities.worker.fields.name.backfillFrom = { refField: 'user', valueField: 'name' } }, 'worker.name'],
  ['added ref', c => { c.entities.worker.fields.extra = { type: 'ref', entity: 'users', required: false } }, 'worker.extra'],
  ['required no default', c => { c.entities.worker.fields.extra = { type: 'text', required: true } }, 'worker.extra'],
  ['required null default', c => { c.entities.worker.fields.extra = { type: 'text', required: true, default: null } }, 'worker.extra'],
]
it.each(rejected)('rejects %s with file:line', (_name, mutate, target) => {
  const base = schemaLock(fixture), next = structuredClone(fixture); mutate(next)
  const sources = { '': { file: 'schema/worker.ts', line: 3, column: 1 } }
  expect(() => schemaLock(next, base, sources)).toThrow(`schema/worker.ts:3: ${target}:`)
})
it('domain SQL bytes survive a CORE_VERSION change', async () => {
  const before = initialSchema(fixture)
  vi.doMock('../../src/config', async original => ({ ...await original<object>(), CORE_VERSION: '99.99.99' }))
  vi.resetModules()
  try { expect((await import('../../src/migrations/schema')).initialSchema(fixture)).toBe(before) }
  finally { vi.doUnmock('../../src/config'); vi.resetModules() }
})
it('legacy fixture DDL byte snapshot captured before the projection refactor', async () => {
  const hashes: Record<string, string> = {}
  for (const name of ['sample', 'accounts', 'policy-graph']) {
    const { default: config } = await import(`../fixtures/${name}/config.ts`)
    hashes[name] = createHash('sha256').update(initialSchema(config)).digest('hex')
  }
  expect(hashes).toMatchInlineSnapshot(`
    {
      "accounts": "b78368c6c1db157a24e4d4a6cac0066f9ea513ddc70e8836a052919d71546616",
      "policy-graph": "506f3445478d473ea080af2c859dc9895d0de7abc1b7592c255d8ebd52e3e3c1",
      "sample": "40ce36752c5f0441e6ffc6f70a1db22dd71f5d45a6768f989f5f50a9374c84c7",
    }
  `)
})
// Enumerate from zod, with the SQL projection's physical keys as the exclusion set.
// New nonphysical keys automatically become probes, including absent optional keys.
it('zod-enumerated nonphysical config keys cannot leak into lock or SQL', () => {
  const physical = new Set(['entities', 'account', 'baseline', 'revision'])
  const physicalEntity = new Set(['fields', 'checks'])
  const physicalField = new Set(['type', 'required', 'values', 'entity', 'default', 'min', 'computed', 'renameFrom', 'backfillFrom'])
  const base = schemaLock(fixture), bytes = lockBytes(base), sql = diffSpecs([], base.tables)
  const assert = (config: InstanceConfig, key: string) => {
    const lock = schemaLock(config)
    expect(lockBytes(lock), key).toBe(bytes)
    expect(diffSpecs([], lock.tables), key).toBe(sql)
  }
  const probe = (schema: z.ZodType, current: unknown): unknown => {
    const json = z.toJSONSchema(schema, { unrepresentable: 'any' })
    const candidates = [...(json.enum ?? []), { changed: { changed: 'changed' } }, true, false, 42, 'changed', [], ['changed'], {}, { changed: {} }, { changed: { field: 'name', entity: 'worker' } },
      { entities: {}, navigation: { groups: [{ id: 'changed', label: 'changed' }], items: [{ id: 'changed', entity: 'worker', label: 'changed' }] } },
    ]
    for (const candidate of candidates) {
      const result = schema.safeParse(candidate)
      if (result.success && JSON.stringify(result.data) !== JSON.stringify(current)) return result.data
    }
    throw new Error('No schema-valid mutation generated')
  }
  const visited: string[] = []
  for (const [key, schema] of Object.entries(instanceConfigSchema.shape)) if (!physical.has(key)) {
    const next = structuredClone(fixture)
    Object.assign(next, { [key]: probe(schema, next[key as keyof typeof next]) })
    assert(next, key); visited.push(key)
  }
  for (const [key, schema] of Object.entries({ ...instanceConfigSchema.shape.entities.valueType.shape, ...declarationSchema.shape })) if (!physicalEntity.has(key)) {
    const next = structuredClone(fixture)
    Object.assign(next.entities.worker, { [key]: probe(schema, (next.entities.worker as unknown as Record<string, unknown>)[key]) })
    assert(next, `entity.${key}`); visited.push(`entity.${key}`)
  }
  for (const [key, schema] of Object.entries(fieldSchema.shape)) if (!physicalField.has(key)) {
    const next = structuredClone(fixture)
    Object.assign(next.entities.worker.fields.name, { [key]: probe(schema, undefined) })
    assert(next, `field.${key}`); visited.push(`field.${key}`)
  }
  // A computed declaration has no physical column, regardless of any of its keys.
  for (const [key, schema] of Object.entries(fieldSchema.shape)) {
    if (['renameFrom', 'backfillFrom'].includes(key)) continue // Migration intents always reject.
    const next = structuredClone(fixture)
    next.entities.worker.fields.derived = { type: 'text', required: false, computed: 'name', [key]: probe(schema, undefined) }
    assert(next, `computed.${key}`)
  }
  expect(visited).toEqual(expect.arrayContaining(['languages', 'ui', 'enumLabels', 'entity.access', 'entity.displayField']))
})
it('configHash equals the loader read-set paths and bytes, including access', async () => {
  const root = fresh(), hash = createHash('sha256')
  for (const file of ['access.ts', 'config.ts', 'schema/worker.ts']) hash.update(JSON.stringify([file, readFileSync(join(root, file), 'utf8')]))
  expect((await loadConfig(join(root, 'config.ts'))).configHash).toBe(hash.digest('hex'))
})

it('runner stamps each filename revision with its receipt outside domain SQL', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { KernelRegistry } = await import('../../src/kernel/registry')
  const { migrateInstance } = await import('../../src/infra/instance-migrations')
  const sqlite = new DatabaseSync(':memory:'), calls: string[] = []
  try {
    const query = async (sql: string) => {
      calls.push(sql)
      if (/^\s*SELECT\b/.test(sql)) return [{ success: true, results: sqlite.prepare(sql).all() }]
      sqlite.exec('BEGIN')
      try { sqlite.exec(sql); sqlite.exec('COMMIT'); return [{ success: true }] }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    }
    const base = schemaLock(fixture), next = structuredClone(fixture)
    next.entities.worker.fields.extra = { type: 'text', required: false }
    const lock = schemaLock(next, base); next.revision = lock.revision
    const files = [initialSchema(fixture), diffSpecs(base.tables, lock.tables)].map((sql, i) => ({
      filename: `000${i + 1}_r${i + 1}.sql`, sql, checksum: createHash('sha256').update(sql).digest('hex'),
    }))
    await migrateInstance(query, files, new KernelRegistry(next))
    expect(sqlite.prepare('SELECT revision FROM instance_meta ORDER BY revision').all()).toEqual([{ revision: 1 }, { revision: 2 }])
    expect(files.every(f => !f.sql.includes('instance_meta'))).toBe(true)
    expect(calls.filter(sql => sql.includes('INSERT INTO _migrations')).every(sql => sql.includes('INSERT INTO instance_meta'))).toBe(true)
  } finally { sqlite.close() }
})
