import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { defineInstance } from '../../src/config'
import { defineEntity, defineConfig, bindSchemaLock } from '../../src/schema'
import { initialSchema } from '../../src/migrations/schema'
import { schemaLock, lockBytes, parseLock, diffSpecs } from '../../src/migrations/schema-lock'

const immutable = { kind: 'ref_immutable' as const, name: 'location_client_locked', field: 'client', referencedBy: { entity: 'booking', field: 'location' } }
const equality = { kind: 'ref_equality' as const, name: 'booking_location_client', field: 'client', through: 'location', targetField: 'client' }
const TOKEN = 'workbase_ref_immutable_'
function config(location: unknown[] = [immutable], booking: unknown[] = []) {
  return defineConfig({ id: 'immutable', roles: ['owner'], organizationOwnerRole: 'owner', languages: ['en'], entities: {
    client: defineEntity({ fields: { name: { type: 'text' } }, displayField: 'name' }),
    location: defineEntity({ fields: { client: { type: 'ref', entity: 'client' }, label: { type: 'text' } }, displayField: 'id', constraints: location as any }),
    booking: defineEntity({ fields: { client: { type: 'ref', entity: 'client' }, location: { type: 'ref', entity: 'location' }, alt: { type: 'ref', entity: 'location' }, status: { type: 'text' } }, displayField: 'id', constraints: booking as any }),
  } })
}
function fixture(constraints: [unknown[], unknown[]] = [[immutable], []], foreignKeys = true) {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}; CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('a'),('b');`)
  db.exec(initialSchema(config(...constraints)))
  const insert = (table: string, id: string, values: Record<string, unknown>, org = 'a') => {
    const data = { id, organization_id: org, created_at: 'now', updated_at: 'now', ...values }
    db.prepare(`INSERT INTO "${table}" (${Object.keys(data).map(k => `"${k}"`).join(',')}) VALUES (${Object.keys(data).map(() => '?').join(',')})`).run(...Object.values(data) as any[])
  }
  for (const [id, name, org] of [['c1', 'One', 'a'], ['c2', 'Two', 'a'], ['c3', 'Three', 'a'], ['cb', 'Foreign', 'b']]) insert('client', id, { name }, org)
  insert('location', 'free', { client: 'c1', label: 'free' }); insert('location', 'used', { client: 'c1', label: 'used' })
  insert('location', 'cancelled', { client: 'c1' }); insert('location', 'nullable', { client: null }); insert('location', 'solo', { client: 'c1' })
  insert('booking', 'b1', { client: 'c1', location: 'used', status: 'confirmed' }); insert('booking', 'b2', { client: 'c1', location: 'cancelled', status: 'cancelled' })
  insert('booking', 'b3', { client: null, location: 'nullable', status: 'confirmed' })
  return { db, insert }
}
const rejected = (db: DatabaseSync, sql: string) => expect(() => db.exec(sql)).toThrow(TOKEN)

it('rejects a changed referenced field (cancelled references count) and permits unreferenced, same-value and unrelated edits', () => {
  const { db } = fixture()
  try {
    rejected(db, "UPDATE location SET client='c2' WHERE id='used'")
    rejected(db, "UPDATE location SET client='c2' WHERE id='cancelled'")
    rejected(db, "UPDATE location SET client='c2', label='x' WHERE id='used'")
    rejected(db, "UPDATE location SET client='c2' WHERE id IN ('free','used')")
    expect(db.prepare("SELECT client FROM location WHERE id='free'").get()).toEqual({ client: 'c1' })
    db.exec("UPDATE location SET client='c2' WHERE id='free'")
    db.exec("UPDATE location SET client='c1' WHERE id='used'")
    db.exec("UPDATE location SET client=client WHERE id='used'")
    db.exec("UPDATE location SET label='renamed', updated_at='later', version=version+1 WHERE id='used'")
    db.exec("UPDATE booking SET status='confirmed' WHERE id='b2'")
    rejected(db, "UPDATE location SET client='c2' WHERE id='cancelled'")
  } finally { db.close() }
})
it('uses IS NOT null policy: null transitions are rejected while referenced, null-to-null allowed', () => {
  const { db } = fixture()
  try {
    rejected(db, "UPDATE location SET client=NULL WHERE id='used'")
    rejected(db, "UPDATE location SET client='c2' WHERE id='nullable'")
    db.exec("UPDATE location SET client=NULL WHERE id='nullable'")
    db.exec("UPDATE location SET client=NULL WHERE id='free'"); db.exec("UPDATE location SET client='c2' WHERE id='free'")
  } finally { db.close() }
})
it('releases the field once the last reference is deleted or reparented', () => {
  const { db } = fixture()
  try {
    rejected(db, "UPDATE location SET client='c2' WHERE id='used'")
    db.exec("UPDATE booking SET location='free' WHERE id='b1'")
    db.exec("UPDATE location SET client='c2' WHERE id='used'")
    rejected(db, "UPDATE location SET client='c3' WHERE id='free'")
    db.exec("DELETE FROM booking WHERE id='b1'")
    db.exec("UPDATE location SET client='c3' WHERE id='free'")
  } finally { db.close() }
})
it('covers id-change, INSERT OR REPLACE and upsert paths', () => {
  const { db } = fixture()
  try {
    rejected(db, "UPDATE location SET id='moved', client='c2' WHERE id='used'")
    expect(() => db.exec("UPDATE location SET id='moved' WHERE id='used'")).toThrow(/FOREIGN KEY/)
    db.exec("UPDATE location SET id='moved', client='c2' WHERE id='free'")
    rejected(db, "INSERT OR REPLACE INTO location (id,organization_id,created_at,updated_at,client) VALUES ('used','a','now','now','c2')")
    rejected(db, "INSERT OR REPLACE INTO location (id,organization_id,created_at,updated_at,client) VALUES ('used','a','now','now',NULL)")
    rejected(db, "INSERT INTO location (id,organization_id,created_at,updated_at,client) VALUES ('used','a','now','now','c2') ON CONFLICT(id) DO UPDATE SET client=excluded.client")
    expect(db.prepare("SELECT client,label FROM location WHERE id='used'").get()).toEqual({ client: 'c1', label: 'used' })
    db.exec("INSERT OR REPLACE INTO location (id,organization_id,created_at,updated_at,client,label) VALUES ('used','a','now','now','c1','replaced')")
    expect(db.prepare("SELECT label FROM location WHERE id='used'").get()).toEqual({ label: 'replaced' })
    db.exec("INSERT OR REPLACE INTO location (id,organization_id,created_at,updated_at,client) VALUES ('moved','a','now','now','c3')")
    db.exec("INSERT INTO location (id,organization_id,created_at,updated_at,client) VALUES ('fresh','a','now','now','c2')")
    db.exec("INSERT INTO location (id,organization_id,created_at,updated_at,client) VALUES ('fresh','a','now','now','c2') ON CONFLICT(id) DO UPDATE SET label='upserted'")
    db.exec("INSERT INTO location (id,organization_id,created_at,updated_at,client) VALUES ('solo','a','now','now','c1') ON CONFLICT(id) DO UPDATE SET label='same-client'")
  } finally { db.close() }
})
it('is organization scoped: references from a foreign organization never block', () => {
  const { db, insert } = fixture(undefined, false)
  try {
    insert('location', 'foreign-location', { client: 'cb' }, 'b')
    // Composite FKs make this impossible with enforcement on; the trigger must still ignore it.
    insert('booking', 'cross', { client: 'cb', location: 'free' }, 'b')
    db.exec("UPDATE location SET client='c2' WHERE id='free'")
    insert('booking', 'same', { client: 'c1', location: 'free' }); rejected(db, "UPDATE location SET client='c3' WHERE id='free'")
  } finally { db.close() }
})
it('supports self references', () => {
  const source = defineConfig({ id: 'self_immutable', roles: ['owner'], organizationOwnerRole: 'owner', languages: ['en'], entities: {
    node: defineEntity({ displayField: 'id', fields: { parent: { type: 'ref', entity: 'node' }, owner: { type: 'ref', entity: 'node' } }, constraints: [{ kind: 'ref_immutable', name: 'owner_locked', field: 'owner', referencedBy: { entity: 'node', field: 'parent' } }] }),
  } })
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('a');")
    db.exec(initialSchema(source))
    db.exec("INSERT INTO node (id,organization_id,created_at,updated_at) VALUES ('root','a','now','now'),('leaf','a','now','now')")
    db.exec("INSERT INTO node (id,organization_id,created_at,updated_at,parent) VALUES ('child','a','now','now','root')")
    db.exec("UPDATE node SET owner='leaf' WHERE id='leaf'")
    rejected(db, "UPDATE node SET owner='leaf' WHERE id='root'")
    db.exec("UPDATE node SET owner=NULL WHERE id='child'")
  } finally { db.close() }
})
it('composes with ref_equality: the stricter immutability error wins, unreferenced rows follow equality only', () => {
  const { db, insert } = fixture([[immutable], [equality]])
  try {
    insert('location', 'eq', { client: 'c1' }); insert('booking', 'eq-booking', { client: 'c1', location: 'eq' })
    rejected(db, "UPDATE location SET client='c2' WHERE id='eq'")
    expect(() => db.exec("INSERT OR REPLACE INTO location (id,organization_id,created_at,updated_at,client) VALUES ('eq','a','now','now','c2')")).toThrow(TOKEN)
    expect(() => db.exec("UPDATE location SET client='c2' WHERE id='eq'")).not.toThrow(/workbase_ref_equality_/)
    // Equality still guards its own side: booking updates are unaffected by immutability.
    expect(() => db.exec("UPDATE booking SET client='c2' WHERE id='eq-booking'")).toThrow('workbase_ref_equality_')
    db.exec("DELETE FROM booking WHERE id='eq-booking'"); db.exec("UPDATE location SET client='c2' WHERE id='eq'")
  } finally { db.close() }
})
it('adds reviewable trigger-only SQL, replay equals fresh, removal drops both triggers and bytes are deterministic', () => {
  const from = schemaLock(config([])), to = schemaLock(config(), from)
  const sql = diffSpecs(from.tables, to.tables)
  expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(2); expect(sql).not.toMatch(/ALTER TABLE|UPDATE "|DELETE FROM|CHECK \("valid"/)
  const { db } = fixture([[], []])
  try {
    db.exec(sql)
    const shape = (db: DatabaseSync) => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    const fresh = fixture()
    try { expect(shape(db)).toEqual(shape(fresh.db)) } finally { fresh.db.close() }
    const removed = diffSpecs(to.tables, schemaLock(config([]), to).tables)
    expect(removed.match(/DROP TRIGGER/g)).toHaveLength(2)
    db.exec(removed); expect(db.prepare("SELECT * FROM sqlite_schema WHERE type='trigger'").all()).toEqual([])
  } finally { db.close() }
  expect(lockBytes(parseLock(lockBytes(to)))).toBe(lockBytes(to))
  expect(lockBytes(schemaLock(config(), from))).toBe(lockBytes(to))
  expect(to.lockVersion).toBe(3); expect(to.tables.find(t => t.name === 'location')!.constraints).toEqual([immutable])
})
it('keeps old locks unchanged: v2 and unique-only v3 round trip without ref_immutable material', () => {
  const v2 = schemaLock(config([])); expect(v2.lockVersion).toBe(2)
  expect(lockBytes(parseLock(lockBytes(v2)))).toBe(lockBytes(v2)); expect(lockBytes(v2)).not.toContain('ref_immutable')
  const unique = { kind: 'unique' as const, name: 'label_unique', fields: ['label'] }
  const v3 = schemaLock(config([unique]), v2); expect(v3.lockVersion).toBe(3)
  expect(lockBytes(parseLock(lockBytes(v3)))).toBe(lockBytes(v3)); expect(lockBytes(v3)).not.toContain('ref_immutable')
  expect(diffSpecs(v2.tables, v3.tables)).not.toContain('TRIGGER')
})
it.each([
  { ...immutable, field: 'missing' }, { ...immutable, field: 'label' },
  { ...immutable, referencedBy: { entity: 'missing', field: 'location' } }, { ...immutable, referencedBy: { entity: 'booking', field: 'missing' } },
  { ...immutable, referencedBy: { entity: 'booking', field: 'status' } }, { ...immutable, referencedBy: { entity: 'booking', field: 'client' } },
  { ...immutable, referencedBy: { entity: 'booking', field: 'location.client' } }, { ...immutable, referencedBy: { entity: 'booking.location', field: 'client' } },
  { ...immutable, field: 'client.name' }, { ...immutable, sql: '1=1' }, { ...immutable, referencedBy: { entity: 'booking', field: 'location', where: "status='x'" } },
  { ...immutable, referencedBy: 'booking.location' }, { ...immutable, field: 'client != OLD.client' },
])('rejects invalid/raw/multi-hop declarations %j', constraint => expect(() => config([constraint])).toThrow())
it('rejects constrained rebuilds, renames and in-place constraint changes explicitly', async () => {
  const { plan: legacyPlan } = await import('../../src/migrations/planner')
  const from = config(), lock = schemaLock(from)
  bindSchemaLock(from, lock)
  const raw = { ...from, revision: 2 }
  const rebuilt = defineInstance({ ...raw, entities: { ...raw.entities, location: { ...raw.entities.location, fields: { ...raw.entities.location.fields, extra: { type: 'ref', entity: 'client' } } } } })
  const migration = legacyPlan(defineInstance({ ...raw, revision: 1 }), rebuilt)
  expect(migration.blocked.join(' ')).toContain('manually reviewed migration'); expect(migration.sql).not.toContain('DROP TABLE')
  const renamed = defineInstance({ ...raw, entities: { ...raw.entities, booking: { ...raw.entities.booking, fields: { ...raw.entities.booking.fields, place: { type: 'ref', entity: 'location', renameFrom: 'location' } } } } })
  expect(() => schemaLock(renamed, lock)).toThrow('manually reviewed migration')
  const changed = config([{ ...immutable, referencedBy: { entity: 'booking', field: 'alt' } }])
  expect(() => schemaLock(changed, lock)).toThrow('changing constraint')
})
it('keeps the legacy planner domain-only and trigger-only for SDK-baseline constraint migrations', async () => {
  const { plan } = await import('../../src/migrations/planner')
  const from = config([]), base = schemaLock(from); bindSchemaLock(from, base)
  const to = config(), next = schemaLock(to, base); bindSchemaLock(to, next)
  const migration = plan(from, to)
  expect(migration.blocked).toEqual([]); expect(migration.sql.match(/CREATE TRIGGER/g)).toHaveLength(2)
  expect(migration.sql).not.toContain('instance_meta')
})
it('keeps generated bundle/lock bytes deterministic across constraint order and verifies parent linkage', async () => {
  const { plan, checkLinkage } = await import('../../src/migrations/schema-plan')
  const { parseBundle } = await import('../../src/migrations/schema-bundle')
  const base = await plan({ config: config([], []), baseMigrations: {} })
  const migrations = { [base.bundle!.filename]: base.bundle!.sql }
  const other = { kind: 'unique', name: 'location_label', fields: ['label'] }
  const a = await plan({ config: config([immutable, other]), baseLock: base.lock, baseMigrations: migrations })
  const b = await plan({ config: config([other, immutable]), baseLock: base.lock, baseMigrations: migrations })
  expect(a).toEqual(b)
  expect(parseBundle(a.bundle!.filename, a.bundle!.sql).generated).toContain('CREATE TRIGGER')
  await expect(checkLinkage(base.lock, migrations, a.lock, { ...migrations, [a.bundle!.filename]: a.bundle!.sql })).resolves.toBeUndefined()
  await expect(checkLinkage(base.lock, migrations, a.lock, { ...migrations, [a.bundle!.filename]: a.bundle!.sql.replace('BEFORE INSERT', 'AFTER INSERT') })).rejects.toThrow('generated region')
  const invalid = JSON.parse(a.lock); invalid.tables.find((t: any) => t.name === 'location').constraints.find((c: any) => c.kind === 'ref_immutable').referencedBy.field = 'missing'
  expect(() => parseLock(JSON.stringify(invalid))).toThrow('Invalid schema.lock.json')
  invalid.tables.find((t: any) => t.name === 'location').constraints.find((c: any) => c.kind === 'ref_immutable').referencedBy = { entity: 'booking', field: 'client' }
  expect(() => parseLock(JSON.stringify(invalid))).toThrow('Invalid schema.lock.json')
})
