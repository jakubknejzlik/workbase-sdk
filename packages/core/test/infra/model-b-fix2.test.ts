import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { applyPluginMigrations, pluginMigrationStatus } from '../../src/kernel/migrations'
import { queryDatabase, type D1Query } from '../../src/infra'
import { withoutRoleChecks } from '../../src/migrations/model-b'
import { systemSchema } from '../../src/migrations/system-schema'
import { opsSchema } from '../../src/ops-schema'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function database() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const query: D1Query = async sql => {
    if (/^\s*(SELECT|PRAGMA)\b/i.test(sql) && !sql.trim().replace(/;$/, '').includes(';')) return [{ success: true, results: db.prepare(sql).all() }]
    db.exec('BEGIN')
    try { db.exec(sql); db.exec('COMMIT'); return [{ success: true }] }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { db, query }
}

// l–n use the reviewer's exact accepted live schemas.
const cases = [
  ['l: anonymous conflict FAIL', "CREATE TABLE memberships(role TEXT,CHECK(role IN ('a')) ON CONFLICT FAIL)", 'CREATE TABLE memberships(role TEXT)'],
  ['m: named conflict REPLACE', "CREATE TABLE memberships(role TEXT,CONSTRAINT x CHECK(role IN ('a')) ON CONFLICT REPLACE)", 'CREATE TABLE memberships(role TEXT)'],
  ['n: preceding UNIQUE keeps rejecting duplicates', "CREATE TABLE memberships(role TEXT, external_id TEXT UNIQUE,CHECK(role IN ('a')) ON CONFLICT IGNORE)", 'CREATE TABLE memberships(role TEXT, external_id TEXT UNIQUE)'],
  ['o: conflict CHECK before adjacent role CHECK', "CREATE TABLE memberships(role TEXT,CHECK(role IN ('a')) ON CONFLICT FAIL,CHECK(role IN ('a')))", 'CREATE TABLE memberships(role TEXT)'],
  ['o: conflict CHECK after adjacent role CHECK', "CREATE TABLE memberships(role TEXT,CHECK(role IN ('a')),CHECK(role IN ('a')) ON CONFLICT REPLACE)", 'CREATE TABLE memberships(role TEXT)'],
  ['p: conflict clause after line comment', "CREATE TABLE memberships(role TEXT,CHECK(role IN ('a')) -- note\n ON CONFLICT ABORT)", 'CREATE TABLE memberships(role TEXT-- note\n)'],
  ['q pin: other CHECK conflict clause before role CHECK', "CREATE TABLE memberships(role TEXT,CHECK(length(role)>0) ON CONFLICT FAIL,CHECK(role IN ('a')))", 'CREATE TABLE memberships(role TEXT,CHECK(length(role)>0) ON CONFLICT FAIL)'],
  ['q pin: other CHECK conflict clause after role CHECK', "CREATE TABLE memberships(role TEXT,CHECK(role IN ('a')),CHECK(length(role)>0) ON CONFLICT FAIL)", 'CREATE TABLE memberships(role TEXT,CHECK(length(role)>0) ON CONFLICT FAIL)'],
  ['r pin: unrelated REFERENCES ON DELETE after column CHECK', "CREATE TABLE memberships(role TEXT CHECK(role IN ('a')) REFERENCES t(id) ON DELETE CASCADE)", 'CREATE TABLE memberships(role TEXT REFERENCES t(id) ON DELETE CASCADE)'],
]
it.each(cases)('%s preserves unrelated bytes, executes and keeps rows', async (_name, sql, expected) => {
  const { db, query } = database()
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE t(id TEXT PRIMARY KEY); INSERT INTO t VALUES('a'),('nonsense')")
  db.exec(sql)
  const unique = sql.includes('external_id')
  db.exec(unique ? "INSERT INTO memberships VALUES('a','external-1')" : "INSERT INTO memberships VALUES('a')")
  const duplicate = () => db.exec("INSERT INTO memberships VALUES('a','external-1')")
  if (unique) expect(duplicate).toThrow(/UNIQUE/)
  const before = db.prepare('SELECT * FROM memberships').all()
  const shape = () => ['table_info', 'index_list', 'foreign_key_list'].map(pragma => db.prepare(`PRAGMA ${pragma}(memberships)`).all())
  const beforeShape = shape()
  const output = withoutRoleChecks(sql)
  expect(output).toBe(expected)
  // Execute the output independently as well as through the migration batch.
  database().db.exec(`CREATE TABLE t(id TEXT PRIMARY KEY); ${output}`)
  await applyPluginMigrations(queryDatabase(query), [])
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='memberships'").get()?.sql).toBe(expected)
  expect(db.prepare('SELECT * FROM memberships').all()).toEqual(before)
  expect(shape()).toEqual(beforeShape)
  if (unique) expect(duplicate).toThrow(/UNIQUE/)
  expect(() => db.exec(unique ? "INSERT INTO memberships VALUES('nonsense','external-2')" : "INSERT INTO memberships VALUES('nonsense')")).not.toThrow()
  if (sql.includes('length(role)')) expect(() => db.exec("INSERT INTO memberships VALUES('')")).toThrow(/CHECK/)
  expect(withoutRoleChecks(output)).toBe(output)
})

it.each(['ROLLBACK', 'ABORT', 'FAIL', 'IGNORE', 'REPLACE'])('table conflict action %s matches case-insensitive word tokens across comments', action => {
  const sql = `CREATE TABLE memberships(role TEXT,CHECK(role IN ('a')) /* keep */ oN cOnFlIcT ${action.toLowerCase()})`
  database().db.exec(sql)
  const output = withoutRoleChecks(sql)
  expect(output).toBe('CREATE TABLE memberships(role TEXT/* keep */)')
  database().db.exec(output)
})

it.each([
  [false, false], [true, false], [false, true], [true, true],
])('Model B evidence handles webhook=%s relay=%s and retains a verifiable receipt on retry', async (webhook, relay) => {
  const { db, query } = database()
  if (webhook) db.exec(systemSchema)
  if (relay) db.exec(opsSchema)
  const adapter = queryDatabase(query)
  await applyPluginMigrations(adapter, [])
  const receipt = db.prepare("SELECT name,position FROM _plugin_migrations WHERE namespace='workbase-core' ORDER BY position").all()
  expect(receipt).toEqual([{ name: '001_model_b', position: 0 }, { name: '002_operational_evidence', position: 1 }])
  const status = await pluginMigrationStatus(adapter, [], { entities: {} })
  expect(status.applied).toBe(status.expected)
  if (webhook) {
    db.exec("INSERT INTO webhook_deliveries (event_id,organization_id,payload,next_attempt_at) VALUES ('event','org','{}','now')")
    db.exec("UPDATE webhook_deliveries SET last_error='delivery_failed',state='failed',attempts=1 WHERE event_id='event'")
    const row = db.prepare("SELECT created_at,operational_history FROM webhook_deliveries WHERE event_id='event'").get()!
    expect(row.created_at).toEqual(expect.any(String))
    expect(JSON.parse(row.operational_history as string)).toMatchObject([
      { state: 'pending', error_code: 'backlog_pending', attempts: 0 },
      { state: 'failed', error_code: 'delivery_failed', attempts: 1 },
    ])
  } else expect(db.prepare("SELECT name FROM sqlite_master WHERE name='webhook_deliveries'").get()).toBeUndefined()
  if (relay) {
    db.exec("INSERT INTO _ops_relay_run VALUES (1,'first',2,3,4,5,6,7,'[]')")
    db.exec("UPDATE _ops_relay_run SET ts='second',backlog=0 WHERE id=1")
    expect(JSON.parse(db.prepare('SELECT operational_history FROM _ops_relay_run').get()!.operational_history as string)).toMatchObject([
      { occurred_at: 'first', backlog: 2 }, { occurred_at: 'second', backlog: 0 },
    ])
  } else expect(db.prepare("SELECT name FROM sqlite_master WHERE name='_ops_relay_run'").get()).toBeUndefined()
  const schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
  await applyPluginMigrations(adapter, [])
  expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema)
  expect(db.prepare("SELECT name,position FROM _plugin_migrations WHERE namespace='workbase-core' ORDER BY position").all()).toEqual(receipt)
})

it('Model B evidence rolls back both table alterations and its receipt when the batch fails', async () => {
  const { db, query } = database()
  db.exec(systemSchema + opsSchema)
  // A conflicting final trigger fails after both table alterations were staged.
  db.exec('CREATE TRIGGER ops_relay_evidence_update AFTER UPDATE OF ts ON _ops_relay_run BEGIN SELECT 1; END;')
  await expect(applyPluginMigrations(queryDatabase(query), [])).rejects.toThrow('002_operational_evidence')
  for (const table of ['webhook_deliveries', '_ops_relay_run']) {
    expect(db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === 'operational_history')).toBe(false)
  }
  expect(db.prepare("SELECT name FROM _plugin_migrations WHERE name='002_operational_evidence'").get()).toBeUndefined()
  db.exec('DROP TRIGGER ops_relay_evidence_update')
  await expect(applyPluginMigrations(queryDatabase(query), [])).resolves.toBeUndefined()
  expect(db.prepare("SELECT name FROM _plugin_migrations WHERE name='002_operational_evidence'").get()).toBeDefined()
})
