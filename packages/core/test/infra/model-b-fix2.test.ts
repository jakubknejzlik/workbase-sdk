import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { applyPluginMigrations } from '../../src/kernel/migrations'
import { queryDatabase, type D1Query } from '../../src/infra'
import { withoutRoleChecks } from '../../src/migrations/model-b'

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
