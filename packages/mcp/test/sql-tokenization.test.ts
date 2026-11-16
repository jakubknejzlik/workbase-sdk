import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { snapshot } from '../src/offline'

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
    expect(() => snapshot(db)).toThrow(expect.objectContaining({ code: 'config_schema_mismatch', details: { phase: 'verification', hint: expect.any(String) } }))
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
