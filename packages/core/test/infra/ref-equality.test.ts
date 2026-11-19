import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { defineInstance } from '../../src/config'
import { defineEntity, defineConfig, bindSchemaLock } from '../../src/schema'
import { initialSchema } from '../../src/migrations/schema'
import { schemaLock, lockBytes, parseLock, diffSpecs } from '../../src/migrations/schema-lock'

const equality = { kind: 'ref_equality' as const, name: 'location_client', field: 'client', through: 'location', targetField: 'client' }
function config(constraints: unknown[] = [equality]) {
  return defineConfig({ id: 'equality', roles: ['owner'], organizationOwnerRole: 'owner', languages: ['en'], entities: {
    client: defineEntity({ fields: { name: { type: 'text' } }, displayField: 'name' }),
    location: defineEntity({ fields: { client: { type: 'ref', entity: 'client' } }, displayField: 'id' }),
    booking: defineEntity({ fields: { client: { type: 'ref', entity: 'client' }, location: { type: 'ref', entity: 'location' } }, displayField: 'id', constraints: constraints as any }),
  } })
}
function fixture(constrained = true) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES (\'a\'),(\'b\');')
  db.exec(initialSchema(config(constrained ? [equality] : [])))
  const insert = (table: string, id: string, values: Record<string, unknown>, org = 'a') => {
    const data = { id, organization_id: org, created_at: 'now', updated_at: 'now', ...values }
    db.prepare(`INSERT INTO "${table}" (${Object.keys(data).map(k => `"${k}"`).join(',')}) VALUES (${Object.keys(data).map(() => '?').join(',')})`).run(...Object.values(data) as any[])
  }
  insert('client', 'c1', { name: 'One' }); insert('client', 'c2', { name: 'Two' }); insert('client', 'foreign', { name: 'Foreign' }, 'b')
  insert('location', 'l1', { client: 'c1' }); insert('location', 'l2', { client: 'c2' }); insert('location', 'ln', { client: null }); insert('location', 'lf', { client: 'foreign' }, 'b')
  return { db, insert }
}
it('enforces inserts, every participating update, tenant isolation, FK and explicit null equality', () => {
  const { db, insert } = fixture()
  try {
    insert('booking', 'ok', { client: 'c1', location: 'l1' })
    expect(() => insert('booking', 'bad', { client: 'c2', location: 'l1' })).toThrow('workbase_ref_equality_')
    for (const set of ["client='c2'", "location='l2'", "client=NULL", "location=NULL"]) expect(() => db.exec(`UPDATE booking SET ${set} WHERE id='ok'`)).toThrow('workbase_ref_equality_')
    expect(() => db.exec("UPDATE booking SET client='c2', location='l1' WHERE id='ok'")).toThrow('workbase_ref_equality_')
    db.exec("UPDATE booking SET client='c2', location='l2' WHERE id='ok'")
    expect(() => db.exec("UPDATE location SET client='c1' WHERE id='l2'")).toThrow('workbase_ref_equality_')
    db.exec("UPDATE location SET client='c2' WHERE id='l2'")
    expect(() => db.exec("INSERT OR REPLACE INTO location (id,organization_id,created_at,updated_at,client) VALUES ('l2','a','now','now','c1')")).toThrow('workbase_ref_equality_')
    for (const values of [{ client: 'c1', location: 'missing' }, { client: 'c1', location: 'lf' }, { client: 'foreign', location: 'l1' }, { client: null, location: 'l1' }, { client: 'c1', location: null }]) expect(() => insert('booking', 'invalid', values)).toThrow()
    insert('booking', 'null-target', { client: null, location: 'ln' }); insert('booking', 'both-null', { client: null, location: null })
    expect(() => db.exec("UPDATE location SET client='c1' WHERE id='ln'")).toThrow('workbase_ref_equality_')
    expect(() => insert('booking', 'missing-null', { client: null, location: 'missing' })).toThrow()
    db.exec("UPDATE location SET client='c2' WHERE id='l1'")
  } finally { db.close() }
})
it('adds only reviewable guards, rejects existing mismatches, and replay equals fresh including trigger bytes', () => {
  const from = schemaLock(config([])), to = schemaLock(config(), from)
  const sql = diffSpecs(from.tables, to.tables)
  expect(sql).toContain('CREATE TRIGGER'); expect(sql).not.toMatch(/ALTER TABLE|UPDATE "booking"|DELETE FROM/)
  const { db, insert } = fixture(false)
  try {
    insert('booking', 'bad', { client: 'c2', location: 'l1' })
    db.exec('BEGIN'); expect(() => db.exec(sql)).toThrow(); db.exec('ROLLBACK')
    expect(db.prepare('SELECT client FROM booking').get()).toEqual({ client: 'c2' })
    db.exec('DELETE FROM booking'); db.exec(sql)
    const shape = (db: DatabaseSync) => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    const fresh = fixture()
    try { expect(shape(db)).toEqual(shape(fresh.db)) } finally { fresh.db.close() }
    expect(lockBytes(parseLock(lockBytes(to)))).toBe(lockBytes(to))
    expect(lockBytes(schemaLock(config(), from))).toBe(lockBytes(to))
    expect(lockBytes(parseLock(lockBytes(from)))).toBe(lockBytes(from))
  } finally { db.close() }
})
it.each([
  { ...equality, field: 'missing' }, { ...equality, through: 'location.client' }, { ...equality, targetField: 'client.name' },
  { ...equality, targetField: 'missing' }, { ...equality, sql: '1=1' }, { ...equality, field: 'client = location.client' },
])('rejects invalid/raw/multi-hop declarations %j', constraint => expect(() => config([constraint])).toThrow())
it('rejects non-ref and incompatible target fields', () => {
  expect(() => defineEntity({ fields: { client: { type: 'text' }, location: { type: 'ref', entity: 'location' } }, constraints: [equality] } as any)).toThrow('ref')
  const source = config(); bindSchemaLock(source, schemaLock(source))
  expect(() => defineInstance({ ...source, entities: { ...source.entities, location: defineEntity({ fields: { client: { type: 'ref', entity: 'location' } }, displayField: 'id' }) } } as any)).toThrow('compatible')
})
it('rejects constrained graph rebuilds and target/source renames explicitly; removes every trigger', async () => {
  const { plan: legacyPlan } = await import('../../src/migrations/planner')
  const { defineInstance } = await import('../../src/config')
  const from = config(), lock = schemaLock(from)
  bindSchemaLock(from, lock)
  const raw = { ...from, revision: 2 }
  const rebuilt = defineInstance({ ...raw, entities: { ...raw.entities, location: { ...raw.entities.location, fields: { ...raw.entities.location.fields, extra: { type: 'ref', entity: 'client' } } } } })
  const migration = legacyPlan(defineInstance({ ...raw, revision: 1 }), rebuilt)
  expect(migration.blocked.join(' ')).toContain('manually reviewed migration'); expect(migration.sql).not.toContain('DROP TABLE')
  const renamed = defineInstance({ ...raw, entities: { ...raw.entities, location: { ...raw.entities.location, fields: { ...raw.entities.location.fields, new_client: { type: 'ref', entity: 'client', renameFrom: 'client' } } } } })
  expect(() => schemaLock(renamed, lock)).toThrow('Renaming a ref equality graph')
  const removed = diffSpecs(lock.tables, schemaLock(config([]), lock).tables)
  expect(removed.match(/DROP TRIGGER/g)).toHaveLength(4)
  const { db } = fixture()
  try { db.exec(removed); expect(db.prepare("SELECT * FROM sqlite_schema WHERE type='trigger'").all()).toEqual([]) } finally { db.close() }
})
it('supports self references using the final row for equality and reverse guards', () => {
  const source = defineConfig({ id: 'self_equality', roles: ['owner'], organizationOwnerRole: 'owner', languages: ['en'], entities: {
    node: defineEntity({ displayField: 'id', fields: { client: { type: 'ref', entity: 'node' }, location: { type: 'ref', entity: 'node' } }, constraints: [{ kind: 'ref_equality', name: 'location_client', field: 'client', through: 'location', targetField: 'client' }] }),
  } })
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('a');")
    db.exec(initialSchema(source))
    db.exec("INSERT INTO node (id,organization_id,created_at,updated_at,client,location) VALUES ('self','a','now','now','self','self')")
    db.exec("UPDATE node SET client=NULL WHERE id='self'")
    db.exec("UPDATE node SET client='self' WHERE id='self'")
  } finally { db.close() }
})
it('keeps generated bundle/lock bytes deterministic across constraint order and verifies parent linkage', async () => {
  const { plan, checkLinkage } = await import('../../src/migrations/schema-plan')
  const { parseBundle } = await import('../../src/migrations/schema-bundle')
  const base = await plan({ config: config([]), baseMigrations: {} })
  const migrations = { [base.bundle!.filename]: base.bundle!.sql }
  const other = { kind: 'unique', name: 'booking_identity', fields: ['client', 'location'] }
  const a = await plan({ config: config([equality, other]), baseLock: base.lock, baseMigrations: migrations })
  const b = await plan({ config: config([other, equality]), baseLock: base.lock, baseMigrations: migrations })
  expect(a).toEqual(b)
  expect(parseBundle(a.bundle!.filename, a.bundle!.sql).generated).toContain('CREATE TRIGGER')
  await expect(checkLinkage(base.lock, migrations, a.lock, { ...migrations, [a.bundle!.filename]: a.bundle!.sql })).resolves.toBeUndefined()
  await expect(checkLinkage(base.lock, migrations, a.lock, { ...migrations, [a.bundle!.filename]: a.bundle!.sql.replace('AFTER INSERT', 'BEFORE INSERT') })).rejects.toThrow('generated region')
  const invalid = JSON.parse(a.lock); invalid.tables.find((t: any) => t.name === 'booking').constraints.find((c: any) => c.kind === 'ref_equality').targetField = 'missing'
  expect(() => parseLock(JSON.stringify(invalid))).toThrow('Invalid schema.lock.json')
})
it('keeps the legacy planner domain-only for SDK-baseline constraint migrations', async () => {
  const { plan } = await import('../../src/migrations/planner')
  const from = config([]), base = schemaLock(from); bindSchemaLock(from, base)
  const to = config(), next = schemaLock(to, base); bindSchemaLock(to, next)
  const migration = plan(from, to)
  expect(migration.blocked).toEqual([])
  expect(migration.sql).toContain('CREATE TRIGGER')
  expect(migration.sql).not.toContain('instance_meta')
})
