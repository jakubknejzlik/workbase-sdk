import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { ddlFingerprint } from '../src/sql-schema'
import { expectedSnapshot, snapshot } from '../src/offline'
import { prepare } from '../src/planning'

it.each(['key', 'desc', 'true', 'false'])('resolves bare %s in an indexed column position exactly like SQLite', keyword => {
  const inspect = (column: string) => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE t("${keyword}" TEXT); CREATE INDEX i ON t(${column})`)
      return { metadata: db.prepare('PRAGMA index_xinfo(i)').all(), schema: snapshot(db) }
    } finally { db.close() }
  }
  const quoted = inspect(`"${keyword}"`), bare = inspect(keyword)
  expect(bare.metadata).toEqual(quoted.metadata)
  expect(bare.schema).toEqual(quoted.schema)
})

it.each(['key', 'desc', 'true', 'false'])('accepts an add_field proposal with a committed bare %s index', keyword => {
  const config = defineInstance({ id: 'keywords', revision: 1, roles: ['owner'], entities: {
    records: { displayField: keyword, fields: { [keyword]: { type: 'string' } } },
  } })
  const indexes = [{ entity: 'records', name: 'records_keyword_idx', fields: [keyword] }]
  const bundle = { config, indexes, migrations: [{ name: '0001_initial.sql',
    sql: initialSchema(config) + `CREATE INDEX records_keyword_idx ON records(organization_id, ${keyword});` }], fingerprint: '', guards: {} }
  return expect(expectedSnapshot(bundle, prepare(config, indexes, [
    { kind: 'add_field', entity: 'records', field: 'extra', definition: { type: 'string' } },
  ]))).resolves.toBeDefined()
})

const scope = { table: 't', columns: ['n', 'null', 'desc', 'true', 'false', 'key'] }
const fingerprint = (expression: string, prefix = '') => ddlFingerprint(`CREATE ${prefix}INDEX i ON t(${expression})`, 'index', 'i', scope)
it('keeps SQL literals, operators and ordering distinct from column references', () => {
  for (const [left, right] of [['NULL', '"null"'], ['n DESC', 'n'], ['n + true', 'n + "true"'],
    ['n IS NULL', 'n IS "null"'], ['n COLLATE nocase', 'n'], ['n, key', 'key, n'], ['n + 1', 'n - 1']]) {
    expect(fingerprint(left)).not.toBe(fingerprint(right))
  }
  expect(fingerprint('n')).not.toBe(fingerprint('n', 'UNIQUE '))
})
it('canonicalizes all ordinary index name/table/column quote combinations', () => {
  const quotes = [(name: string) => name, (name: string) => `"${name}"`, (name: string) => `[${name}]`, (name: string) => '`' + name + '`']
  const expected = fingerprint('n')
  for (const index of quotes) for (const table of quotes) for (const column of quotes) {
    expect(ddlFingerprint(`CREATE INDEX ${index('i')} ON ${table('t')}(${column('n')})`, 'index', 'i', scope)).toBe(expected)
  }
})

it('uses index expression roles without binding ordering or partial predicates', () => {
  const inspect = (expression: string, where = '') => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE t(n INTEGER, "null" INTEGER, "desc" INTEGER, "true" INTEGER, "false" INTEGER); CREATE INDEX i ON t(${expression}) ${where}`)
      return snapshot(db)
    } finally { db.close() }
  }
  expect(inspect('desc DESC')).toEqual(inspect('"desc" DESC'))
  expect(inspect('n, desc DESC')).toEqual(inspect('n, "desc" DESC'))
  expect(inspect('((true))')).toEqual(inspect('(("true"))'))
  for (const [left, right] of [['NULL', '"null"'], ['desc DESC', 'desc'], ['n + 1', 'n - 1'],
    ['n COLLATE nocase', 'n'], ['n, "desc"', '"desc", n'], ['9007199254740992', '9007199254740993'], ['1.0', '1']]) {
    expect(inspect(left)).not.toEqual(inspect(right))
  }
  expect(inspect('"null"', 'WHERE (NULL)')).not.toEqual(inspect('"null"', 'WHERE ("null")'))
  expect(inspect('n')).not.toEqual(inspect('n', 'WHERE n > 0'))
  expect(inspect('n', 'WHERE n > 0')).not.toEqual(inspect('n', 'WHERE n >= 0'))
  expect(fingerprint('"Unknown"')).not.toBe(fingerprint('"unknown"'))
})
