import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { snapshot, expectedSnapshot } from '../src/offline'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { prepare } from '../src/planning'
import { applyDisposable } from '../src/disposable'
import { sdkWorkflowError } from '../src/sdk-upgrade'

const fingerprint = (sql: string, enableDoubleQuotedStringLiterals = false) => {
  const db = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals })
  try { db.exec(sql); return snapshot(db) } finally { db.close() }
}
const table = 'CREATE TABLE t ("null" INTEGER, "true" INTEGER, "false" INTEGER, "x" TEXT, "a""b" INTEGER, n INTEGER'
it.each([
  ['"null"', 'null'], ['[null]', 'NULL'], ['`null`', 'null'],
  ['"true"', 'true'], ['"false"', 'false'], ['"x"', "'x'"],
  ['"a""b"', "'a\"b'"],
])('distinguishes CHECK identifier %s from literal %s', (identifier, literal) => {
  expect(fingerprint(`${table}, CHECK (${identifier} IN (0,1)))`))
    .not.toEqual(fingerprint(`${table}, CHECK (${literal} IN (0,1)))`))
})
it.each(['check', 'unique', 'constraint', 'primary', 'foreign'])('accepts quoted column %s', name => {
  expect(() => fingerprint(`CREATE TABLE t ("${name}" TEXT)`)).not.toThrow()
})
it('preserves harmless CHECK equivalences', () => {
  expect(fingerprint(`${table}, CHECK (([null] in (1,0))), CHECK (n IN (1,0)))`))
    .toEqual(fingerprint(`${table}, check ( /* comment */ "null" IN (0,1)), CHECK ((n in (0, 1))))`))
})

it.each([
  ['bare DEFAULT string case', 'CREATE TABLE t(a TEXT DEFAULT Foo)', 'CREATE TABLE t(a TEXT DEFAULT foo)'],
  ['DEFAULT keyword', 'CREATE TABLE t(a TEXT DEFAULT "CURRENT_TIME")', 'CREATE TABLE t(a TEXT DEFAULT CURRENT_TIME)'],
  ['DEFAULT quoted case', 'CREATE TABLE t(a TEXT DEFAULT "ABC")', 'CREATE TABLE t(a TEXT DEFAULT "abc")'],
  ['DEFAULT string vs identifier', `CREATE TABLE t(a TEXT DEFAULT 'x')`, 'CREATE TABLE t(a TEXT DEFAULT "x")'],
  ['generated', `${table}, g AS ("null" IN (0,1)))`, `${table}, g AS (null IN (0,1)))`],
  ['partial index', `${table}); CREATE INDEX i ON t(n) WHERE "null" IN (0,1)`, `${table}); CREATE INDEX i ON t(n) WHERE null IN (0,1)`],
  ['trigger', `${table}); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT "null" FROM t; END`, `${table}); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT null FROM t; END`],
  ['trigger DQS versus unresolved identifier', 'CREATE TABLE t(n); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT "unknown"; END', 'CREATE TABLE t(n); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT [unknown]; END'],
  ['trigger name as DQS text', 'CREATE TABLE t(n); CREATE TRIGGER abc AFTER INSERT ON t BEGIN SELECT "ABC"; END', 'CREATE TABLE t(n); CREATE TRIGGER abc AFTER INSERT ON t BEGIN SELECT "abc"; END'],
])('retains token distinctions in %s', (_label, before, after) => {
  expect(fingerprint(before)).not.toEqual(fingerprint(after))
})
it('normalizes generated expressions and defaults with typed tokens', () => {
  expect(fingerprint('CREATE TABLE t(n, g AS (n IS NULL), a DEFAULT CURRENT_TIME, b DEFAULT X\'ABCD\')'))
    .toEqual(fingerprint('CREATE TABLE t(n, g AS ( /* ignored */ [n] is null), a DEFAULT current_time, b DEFAULT x\'abcd\')'))
})
it('does not treat quoted punctuation or CHECK text as grammar', () => {
  expect(() => fingerprint('CREATE TABLE t("(" TEXT, ")" TEXT, "check" TEXT, n TEXT DEFAULT \'check(\')')).not.toThrow()
})
it('matches escaped column names across SQLite quoting forms', () => {
  expect(fingerprint('CREATE TABLE t("a""b" INTEGER, CHECK ("a""b" IN (0,1)))'))
    .toEqual(fingerprint('CREATE TABLE t(`a"b` INTEGER, CHECK ([a"b] in (0,1)))'))
})

it('retains unresolved DQS text case when SQLite enables that compatibility mode', () => {
  expect(fingerprint(`CREATE TABLE t(n, CHECK ("ABC" = 'ABC'))`, true))
    .not.toEqual(fingerprint(`CREATE TABLE t(n, CHECK ("abc" = 'ABC'))`, true))
})

it.each([' /* unterminated', ' !'])('surfaces unsupported persisted tokens as a typed workflow failure: %j', suffix => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE t(n)')
    db.enableDefensive(false)
    db.exec('PRAGMA writable_schema=ON')
    db.prepare("UPDATE sqlite_master SET sql=sql||? WHERE name='t'").run(suffix)
    expect(() => snapshot(db)).toThrow(expect.objectContaining({ code: 'sql_tokenization_unsupported', message: 'SQL contains an unsupported or incomplete token', details: { phase: 'verification', offset: expect.any(Number) } }))
  } finally { db.close() }
})
it('fails closed on SQLite keyword-as-string DEFAULT fallback rather than folding its value', () => {
  expect(() => fingerprint('CREATE TABLE t(n DEFAULT ABORT)')).toThrow(expect.objectContaining({ code: 'config_schema_mismatch' }))
})

it('demonstrates the NULL CHECK drift against SQLite enforcement', () => {
  for (const [expression, rejected] of [['"null"', true], ['null', false]] as const) {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE t ("null" INTEGER CHECK (${expression} IN (0,1)))`)
      const insert = () => db.exec('INSERT INTO t VALUES (2)')
      if (rejected) expect(insert).toThrow(/CHECK constraint failed/)
      else expect(insert).not.toThrow()
    } finally { db.close() }
  }
})

const quoteForms = (name: string) => [name, `"${name}"`, `[${name}]`, '`' + name + '`']
it.each(quoteForms('n'))('binds the index ON table and column %s across all identifier quotes', column => {
  const expected = fingerprint('CREATE TABLE t(n); CREATE INDEX i ON t(n)')
  for (const table of quoteForms('T')) for (const index of quoteForms('i')) {
    expect(fingerprint(`CREATE TABLE t(n); CREATE INDEX ${index} ON ${table}(${column})`)).toEqual(expected)
  }
})
it.each(['null', 'true', 'check', 'unique', 'constraint', 'primary', 'foreign', 'a"b', 'ä'])('uses one canonical identifier kind for bound index column %s', name => {
  const quoted = `"${name.replaceAll('"', '""')}"`
  const before = `CREATE TABLE t(${quoted}); CREATE INDEX "check" ON t(${quoted})`
  const after = `CREATE TABLE t(${quoted}); CREATE INDEX [check] ON [t]([${name}])`
  expect(fingerprint(before)).toEqual(fingerprint(after))
})
it('binds index expression and predicate columns without binding same-named DQS literals', () => {
  expect(fingerprint('CREATE TABLE t(n); CREATE INDEX i ON t(abs("n")) WHERE "n" > 0'))
    .toEqual(fingerprint('CREATE TABLE t(n); CREATE INDEX [i] ON [t](ABS([n])) WHERE [n] > 0'))
  // Neither the index's name nor the table's name supplies an expression column.
  for (const name of ['i', 't', 'unknown']) {
    expect(fingerprint(`CREATE TABLE t(n); CREATE INDEX i ON t("${name.toUpperCase()}")`, true))
      .not.toEqual(fingerprint(`CREATE TABLE t(n); CREATE INDEX i ON t("${name}")`, true))
  }
})
it.each([
  ['order', 'n,m', 'm,n', '', ''],
  ['direction', 'n ASC', 'n DESC', '', ''],
  ['collation', 'n COLLATE BINARY', 'n COLLATE NOCASE', '', ''],
  ['expression', 'n+1', 'n+2', '', ''],
  ['literal case', "n||'ABC'", "n||'abc'", '', ''],
  ['partial predicate', 'n', 'n', 'WHERE m > 0', 'WHERE m >= 0'],
  ['literal vs identifier', '"null"', 'null', '', ''],
  ['numeric precision', 'n+9007199254740992', 'n+9007199254740993', '', ''],
])('retains index %s', (_label, a, b, predicateA, predicateB) => {
  const base = 'CREATE TABLE t(n,m,"null"); CREATE INDEX i ON t'
  expect(fingerprint(`${base}(${a}) ${predicateA}`)).not.toEqual(fingerprint(`${base}(${b}) ${predicateB}`))
})
it('retains index uniqueness', () => {
  expect(fingerprint('CREATE TABLE t(n); CREATE INDEX i ON t(n)'))
    .not.toEqual(fingerprint('CREATE TABLE t(n); CREATE UNIQUE INDEX i ON t(n)'))
})
it('rejects CHECK drift in offline planning and persisted disposable D1', async () => {
  const config = defineInstance({ id: 'token_fixture', revision: 1, roles: ['owner'], entities: { records: { fields: { null: { type: 'bool' } } } } })
  const sql = initialSchema(config), drift = sql.replace('CHECK ("null" IN (0,1))', 'CHECK (null IN (0,1))')
  expect(drift).not.toBe(sql)
  const bundle = { config, indexes: [], fingerprint: '', guards: {}, migrations: [{ name: '0001_initial.sql', sql }] }
  const planned = prepare(config, [], [{ kind: 'add_field', entity: 'records', field: 'notes', definition: { type: 'text' } }])
  const expected = await expectedSnapshot(bundle, planned)
  const changed = { ...bundle, migrations: [{ name: '0001_initial.sql', sql: drift }] }
  await expect(expectedSnapshot(changed, planned)).rejects.toMatchObject({ code: 'config_schema_mismatch' })
  expect(await applyDisposable(changed, planned, expected, false)).toMatchObject({ verified: false })
})
it('keeps lexical failures safe at the offline and public SDK boundaries', () => {
  const secret = 'private_sql_payload_104'
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE t(n)')
    db.enableDefensive(false)
    db.exec('PRAGMA writable_schema=ON')
    db.prepare("UPDATE sqlite_master SET sql=sql||? WHERE name='t'").run(' /* ' + secret)
    let caught: unknown
    try { snapshot(db) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'sql_tokenization_unsupported', details: { phase: 'verification', offset: expect.any(Number) } })
    const error = sdkWorkflowError(caught)
    expect(error).toMatchObject({ code: 'sql_tokenization_unsupported', message: 'SQL contains an unsupported or incomplete token', details: { phase: 'verification' } })
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(secret)
  } finally { db.close() }
})
