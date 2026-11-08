import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { CORE_VERSION, defineInstance } from '@workbasehq/core/config'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { migrateD1, migrateInstance, sha256, type D1Query } from '@workbasehq/core/infra'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const query: D1Query = async sql => {
    if (/^(?:SELECT|PRAGMA)/.test(sql)) return [{ success: true, results: db.prepare(sql).all() }]
    db.exec('BEGIN')
    try { db.exec(sql); db.exec('COMMIT'); return [{ success: true }] }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const sql = `CREATE TABLE instance_meta (revision INTEGER PRIMARY KEY, core_version TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO instance_meta VALUES (1,'${CORE_VERSION}','2000-01-01'); CREATE TABLE records (id TEXT PRIMARY KEY);`
  const files = [{ filename: '0001_initial.sql', sql, checksum: sha256(sql) }]
  const kernel = new KernelRegistry(defineInstance({ id: 'neutral', revision: 1, interactive: false, roles: ['owner'], entities: {}, plugins: [
    { name: 'records', version: '1.0.0', migrations: [{ name: '001_index', sql: 'CREATE INDEX records_id ON records(id);' }] },
  ] }))
  return { db, query, files, kernel }
}

it('fresh apply commits SQL and plugin migration receipts', async () => {
  const { db, query, files, kernel } = fixture()
  expect(await migrateInstance(query, files, kernel)).toMatchObject({ applied: 1, total: 1 })
  expect(db.prepare('SELECT filename,checksum FROM _migrations').all()).toEqual(files.map(({ filename, checksum }) => ({ filename, checksum })))
  expect(db.prepare('SELECT namespace,name,position FROM _plugin_migrations').all()).toEqual([{ namespace: 'workbase-core', name: '001_model_b', position: 0 }, { namespace: 'records', name: '001_index', position: 0 }])
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='records_id'").get()).toBeDefined()
})

it('idempotent reapply preserves application data and both ledgers', async () => {
  const { db, query, files, kernel } = fixture()
  const first = await migrateInstance(query, files, kernel)
  db.exec("INSERT INTO records VALUES ('retained')")
  const receipts = db.prepare('SELECT * FROM _migrations').all()
  expect(await migrateInstance(query, files, kernel)).toEqual({ ...first, applied: 0 })
  expect(db.prepare('SELECT * FROM _migrations').all()).toEqual(receipts)
  expect(db.prepare('SELECT * FROM records').all()).toEqual([{ id: 'retained' }])
})

it('changed-history rejection refuses a tampered migration before applying new SQL', async () => {
  const { db, query, files } = fixture()
  await migrateD1(query, files)
  const sql = files[0].sql + "INSERT INTO records VALUES ('tampered');"
  await expect(migrateD1(query, [{ ...files[0], sql, checksum: sha256(sql) }])).rejects.toThrow('migration_history_mismatch:0001_initial.sql')
  expect(db.prepare('SELECT * FROM records').all()).toEqual([])
})

it('plugin migration mismatch check rejects a changed plugin receipt', async () => {
  const { db, query, files, kernel } = fixture()
  await migrateInstance(query, files, kernel)
  db.exec("UPDATE _plugin_migrations SET checksum='tampered' WHERE namespace='records'")
  await expect(migrateInstance(query, files, kernel)).rejects.toThrow('Plugin migration changed: records/001_index')
})

it('rolls back a failed SQL file together with its receipt', async () => {
  const { db, query } = fixture()
  const sql = 'CREATE TABLE partial (id TEXT); INSERT INTO absent VALUES (1);'
  await expect(migrateD1(query, [{ filename: '0001_failed.sql', sql, checksum: sha256(sql) }])).rejects.toThrow()
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get()).toBeUndefined()
  expect(db.prepare('SELECT * FROM _migrations').all()).toEqual([])
})

// Future stamps are derived from CORE_VERSION so a release bump cannot turn them into the current version (#183 broke the literal '0.2.8').
const [major, minor, patch] = CORE_VERSION.split('.').map(Number)
const nextPatch = `${major}.${minor}.${patch + 1}`
const twoDigitPatch = `${major}.${minor}.${(patch + 1) * 10}`
const nextMinor = `${major}.${minor + 1}.0`
const nextMajor = `${major + 1}.0.0`

for (const pendingSQL of [false, true]) {
  it.each([nextPatch, twoDigitPatch, nextMinor, nextMajor, 'broken', '', '0.2', '0.02.6', '0.2.6-beta', '0.2.6+build', '0.2.6\n', '0.0.9007199254740993'])('rejects unsupported SDK stamp %j before any writes or plugin execution (pending SQL: ' + pendingSQL + ')', async version => {
    const { db, query, files, kernel } = fixture()
    await migrateD1(query, files)
    // Identical SQL receipts, but a newer/foreign SDK has stamped the database.
    db.prepare('UPDATE instance_meta SET core_version=?').run(version)
    const before = db.prepare('SELECT * FROM instance_meta').all()
    const receipts = db.prepare('SELECT * FROM _migrations').all()
    const changes = db.prepare('SELECT total_changes() AS n').get()
    const schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
    if (pendingSQL) {
      // A preflight after migrateD1 would let this hide the unsupported stamp.
      const sql = `UPDATE instance_meta SET core_version='${CORE_VERSION}'; INSERT INTO records VALUES ('pending');`
      files.push({ filename: '0002_pending.sql', sql, checksum: sha256(sql) })
    }
    const apply = vi.spyOn(kernel, 'applyMigrations')
    const calls: string[] = []
    await expect(migrateInstance(async sql => { calls.push(sql); return query(sql) }, files, kernel))
      .rejects.toMatchObject({ message: 'migration_instance_revision_mismatch' })
    expect(apply).not.toHaveBeenCalled()
    expect(calls.every(sql => /^SELECT/.test(sql))).toBe(true)
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
    expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema)
    expect(db.prepare('SELECT * FROM instance_meta').all()).toEqual(before)
    expect(db.prepare('SELECT * FROM _migrations').all()).toEqual(receipts)
    expect(db.prepare('SELECT * FROM records').all()).toEqual([])
  })
}

it('rejects an unsupported stamp introduced by SQL before plugin execution', async () => {
  const { db, query, files, kernel } = fixture()
  const sql = `UPDATE instance_meta SET core_version='${nextPatch}';`
  files.push({ filename: '0002_future.sql', sql, checksum: sha256(sql) })
  const apply = vi.spyOn(kernel, 'applyMigrations')
  await expect(migrateInstance(query, files, kernel)).rejects.toThrow('migration_instance_revision_mismatch')
  expect(apply).not.toHaveBeenCalled()
  expect(db.prepare('SELECT core_version FROM instance_meta').get()).toEqual({ core_version: nextPatch })
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='_plugin_migrations'").get()).toBeUndefined()
})
