import { expect, it } from 'vitest'
import { defineEntity, defineConfig, bindSchemaLock } from '../../src/schema'
import { defineInstance } from '../../src/config'
import { checkSchema, lockBytes, parseLock, schemaLock } from '../../src/migrations/schema-lock'
import { checkLinkage, plan } from '../../src/migrations/schema-plan'
import { parseBundle } from '../../src/migrations/schema-bundle'
import { plan as legacyPlan } from '../../src/migrations/planner'
import { initialSchema } from '../../src/migrations/schema'
import { DatabaseSync } from 'node:sqlite'

const unique = { kind: 'unique' as const, name: 'assignment_slot_worker_unique', fields: ['slot', 'worker'] }
const fields = { slot: { type: 'text' as const }, worker: { type: 'text' as const } }
const config = (constraints?: unknown) => {
  const authored = defineConfig({ id: 'constraints', roles: ['owner'], organizationOwnerRole: 'owner', languages: ['en'], entities: {
    assignment: defineEntity({ fields, displayField: 'slot', ...(constraints ? { constraints: constraints as any } : {}) }),
  } })
  return bindSchemaLock(authored, schemaLock(authored))
}

it.each([
  [{ ...unique, fields: ['missing'] }, 'Unknown'],
  [{ ...unique, fields: ['slot', 'slot'] }, 'distinct'],
  [{ ...unique, fields: ['organization_id'] }, 'Unknown'],
  [{ ...unique, fields: [] }, ''],
  [{ ...unique, name: 'bad-name' }, ''],
  [{ ...unique, where: '1=1' }, ''],
  [{ ...unique, kind: 'partial_unique' }, ''],
])('rejects invalid authored constraints %j', (constraint, message) => {
  expect(() => defineEntity({ fields, constraints: [constraint] } as any)).toThrow(message || undefined)
  expect(() => config([constraint])).toThrow(message || undefined)
})
it('rejects duplicate names and computed fields at the shared declaration boundary', () => {
  expect(() => defineEntity({ fields, constraints: [unique, unique] } as any)).toThrow('Duplicate constraint name')
  expect(() => defineEntity({ fields: { ...fields, derived: { type: 'text', computed: 'slot' } }, constraints: [{ ...unique, fields: ['derived'] }] } as any)).toThrow('stored')
})
it('keeps released v2 bytes unchanged and opts constrained schemas into v3', () => {
  const old = schemaLock(config()), bytes = lockBytes(old)
  expect(old.lockVersion).toBe(2)
  expect(lockBytes(parseLock(bytes))).toBe(bytes)
  expect(lockBytes(schemaLock(config(), old))).toBe(bytes)
  const constrained = schemaLock(config([unique]), old)
  expect(constrained.lockVersion).toBe(3)
  expect(constrained.tables[0]).toMatchObject({ constraints: [unique] })
  expect(lockBytes(parseLock(lockBytes(constrained)))).toBe(lockBytes(constrained))
  expect(() => parseLock(JSON.stringify({ ...constrained, lockVersion: 2 }))).toThrow()
})
it('normalizes constraint ordering and rejects stale locks/bundles and schema drift', async () => {
  const other = { ...unique, name: 'other_unique', fields: ['worker'] }
  const a = await plan({ config: config([unique, other]), baseMigrations: {} })
  const b = await plan({ config: config([other, unique]), baseMigrations: {} })
  expect(a).toEqual(b)
  expect(() => checkSchema(config(), parseLock(a.lock))).toThrow('schema differs')
  const base = await plan({ config: config(), baseMigrations: {} })
  const migrations = { [base.bundle!.filename]: base.bundle!.sql }
  const next = await plan({ config: config([unique]), baseLock: base.lock, baseMigrations: migrations })
  const current = { ...migrations, [next.bundle!.filename]: next.bundle!.sql }
  await expect(checkLinkage(base.lock, migrations, next.lock, current)).resolves.toBeUndefined()
  const stale = JSON.parse(next.lock); stale.parent = '0'.repeat(64)
  await expect(checkLinkage(base.lock, migrations, lockBytes(stale), current)).rejects.toThrow('stale base')
  await expect(checkLinkage(base.lock, migrations, next.lock, { ...current, [next.bundle!.filename]: next.bundle!.sql.replace('CREATE UNIQUE INDEX', 'CREATE INDEX') })).rejects.toThrow('generated region')
})
it('adds a named unique index without rebuilding; replay and fresh schema agree; bad existing data fails without cleanup', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES (\'a\'),(\'b\');')
    const base = await plan({ config: config(), baseMigrations: {} })
    const next = await plan({ config: config([unique]), baseLock: base.lock, baseMigrations: { [base.bundle!.filename]: base.bundle!.sql } })
    const sql = parseBundle(next.bundle!.filename, next.bundle!.sql).generated
    expect(sql).toMatch(/^CREATE UNIQUE INDEX/)
    expect(sql).not.toMatch(/CREATE TABLE|DROP TABLE|ALTER TABLE/)
    db.exec(initialSchema(config()))
    const insert = db.prepare('INSERT INTO assignment (id,organization_id,created_at,updated_at,slot,worker) VALUES (?,?,\'now\',\'now\',?,?)')
    insert.run('one', 'a', 's', 'w'); insert.run('two', 'a', 's', 'w')
    expect(() => db.exec(sql)).toThrow('UNIQUE constraint failed')
    expect(db.prepare('SELECT count(*) AS n FROM assignment').get()).toEqual({ n: 2 })
    db.exec("DELETE FROM assignment WHERE id='two'")
    db.exec(sql)
    expect(() => insert.run('duplicate', 'a', 's', 'w')).toThrow('UNIQUE constraint failed')
    insert.run('other-worker', 'a', 's', 'w2'); insert.run('other-org', 'b', 's', 'w')
    expect(() => db.exec("UPDATE assignment SET worker='w' WHERE id='other-worker'")).toThrow('UNIQUE constraint failed')
    insert.run('null-one', 'a', 's', null); insert.run('null-two', 'a', 's', null)
    const shape = () => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='assignment' ORDER BY type,name").all()
    const replay = shape()
    db.exec('DROP TABLE assignment'); db.exec(initialSchema(config([unique])))
    expect(shape()).toEqual(replay)
  } finally { db.close() }
})

it('safely rejects constrained rebuilds and rename publication, retaining the original constraint identity', async () => {
  const from = config([unique]), next = defineInstance({ ...from, revision: 2, entities: { ...from.entities, assignment: { ...from.entities.assignment, fields: { ...from.entities.assignment.fields, extra: { type: 'ref', entity: 'assignment' } } } } })
  const rebuild = legacyPlan(from, next)
  expect(rebuild.blocked.join(' ')).toContain('Rebuilding a constrained table requires a manually reviewed migration')
  expect(rebuild.sql).not.toContain('DROP TABLE')
  const base = await plan({ config: from, baseMigrations: {} })
  const renamed = defineInstance({ ...from, entities: { ...from.entities, assignment: { ...from.entities.assignment, displayField: 'new_slot', fields: { worker: { type: 'text' }, new_slot: { type: 'text', renameFrom: 'slot' } }, constraints: [{ ...unique, fields: ['new_slot', 'worker'] }] } } })
  const lock = schemaLock(renamed, parseLock(base.lock))
  expect(lock.tables[0].constraints).toEqual([unique])
  await expect(plan({ config: renamed, baseLock: base.lock, baseMigrations: { [base.bundle!.filename]: base.bundle!.sql } })).rejects.toThrow('expansion SQL is unsupported')
})
it('validates v3 lock constraint fields, duplicate identities and unsupported payloads', () => {
  const lock = schemaLock(config([unique]))
  for (const constraints of [[unique, unique], [{ ...unique, fields: ['missing'] }], [{ ...unique, fields: ['slot', 'slot'] }], [{ ...unique, fields: ['id'] }], [{ ...unique, where: '1=1' }]]) {
    expect(() => parseLock(JSON.stringify({ ...lock, tables: [{ ...lock.tables[0], constraints }] }))).toThrow('Invalid schema.lock.json')
  }
})
it('supports mixed scalar positions and references; typed literals reject unknown field keys', () => {
  const declaration = defineEntity({ fields: { slot: { type: 'ref', entity: 'slot' }, worker: { type: 'ref', entity: 'worker' }, count: { type: 'int' }, flag: { type: 'bool' } }, constraints: [{ kind: 'unique', name: 'mixed_unique', fields: ['slot', 'worker', 'count', 'flag'] }] })
  expect(declaration.constraints[0].fields).toEqual(['slot', 'worker', 'count', 'flag'])
  if (false) {
    // @ts-expect-error Constraint keys are checked against the authored field map.
    defineEntity({ fields: { slot: { type: 'text' } }, constraints: [{ kind: 'unique', name: 'invalid_unique', fields: ['unknown'] }] })
  }
})
it('removes constraints deterministically, retains v3, and rejects changing a stable name', async () => {
  const base = await plan({ config: config([unique]), baseMigrations: {} })
  const input = { baseLock: base.lock, baseMigrations: { [base.bundle!.filename]: base.bundle!.sql } }
  await expect(plan({ ...input, config: config([{ ...unique, fields: ['slot'] }]) })).rejects.toThrow('use a new name')
  const removed = await plan({ ...input, config: config() })
  expect(parseLock(removed.lock)).toMatchObject({ lockVersion: 3, revision: 2 })
  expect(parseBundle(removed.bundle!.filename, removed.bundle!.sql).generated).toMatch(/^DROP INDEX "workbase_unique_/)
})
it('deploys and verifies constrained schemas through the real D1 HTTP migration adapter', async () => {
  const { default: fixture } = await import('../fixtures/config-era/config')
  const { KernelRegistry } = await import('../../src/kernel/registry')
  const { migrateInstance } = await import('../../src/infra/instance-migrations')
  const { createHash } = await import('node:crypto')
  const selected = defineInstance({ ...fixture, entities: { ...fixture.entities, worker: { ...fixture.entities.worker, constraints: [{ kind: 'unique', name: 'worker_name_unique', fields: ['name'] }] } } })
  bindSchemaLock(selected, schemaLock(selected))
  const db = new DatabaseSync(':memory:')
  try {
    const query = async (sql: string) => {
      if (/^\s*SELECT\b/.test(sql)) return [{ success: true, results: db.prepare(sql).all() }]
      db.exec('BEGIN')
      try { db.exec(sql); db.exec('COMMIT'); return [{ success: true }] }
      catch (error) { db.exec('ROLLBACK'); throw error }
    }
    const sql = initialSchema(selected)
    const migrations = [{ filename: '0001_r1.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') }]
    const kernel = new KernelRegistry(selected)
    expect(await migrateInstance(query, migrations, kernel)).toMatchObject({ applied: 1, total: 1 })
    expect(await migrateInstance(query, migrations, kernel)).toMatchObject({ applied: 0, total: 1 })
    db.exec("DROP INDEX workbase_unique_776f726b6572_worker_name_unique")
    await expect(migrateInstance(query, migrations, kernel)).rejects.toThrow('Schema drift')
  } finally { db.close() }
})
