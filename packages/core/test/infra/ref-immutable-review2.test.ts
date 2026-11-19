import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { initialSchema } from '../../src/migrations/schema'
import { diffSpecs, schemaLock } from '../../src/migrations/schema-lock'
import { constraintError } from '../../src/constraint-errors'
import { reviewConfig, uniqueTransitions, organizationsSQL, seedSQL, multiReplaceSQL, forwardReplaceSQL, schemaObjectsSQL, immutableConflict } from '../fixtures/ref-immutable-review2'

// Derived from s4-review2 probe-results.json and forward-precedence.json.
it.each(uniqueTransitions)('refreshes immutable triggers after %s: replay equals fresh', (_name, oldKeys, newKeys) => {
  const before = reviewConfig(oldKeys), after = reviewConfig(newKeys)
  const base = schemaLock(before), next = schemaLock(after, base)
  const replay = new DatabaseSync(':memory:'), fresh = new DatabaseSync(':memory:')
  try {
    replay.exec(organizationsSQL + initialSchema(before) + seedSQL)
    replay.exec(diffSpecs(base.tables, next.tables))
    fresh.exec(organizationsSQL + initialSchema(after))
    expect(replay.prepare(schemaObjectsSQL).all()).toEqual(fresh.prepare(schemaObjectsSQL).all())
  } finally { replay.close(); fresh.close() }
})
it('rejects multi-row unique-key REPLACE after adding unique to an immutable entity with FKs enabled', () => {
  const before = reviewConfig(), after = reviewConfig(uniqueTransitions[0][2])
  const base = schemaLock(before), next = schemaLock(after, base)
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(organizationsSQL + initialSchema(before) + seedSQL + diffSpecs(base.tables, next.tables))
    const rows = db.prepare('SELECT * FROM location').all()
    const error = (() => { try { db.exec(multiReplaceSQL) } catch (error) { return error } })()
    expect(constraintError(error, after)).toMatchObject(immutableConflict)
    expect(db.prepare('SELECT * FROM location').all()).toEqual(rows)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { db.close() }
})
it.each([false, true])('prioritizes immutability over forward equality with reversed trigger installation=%s', reverse => {
  const config = reviewConfig([], true), db = new DatabaseSync(':memory:')
  try {
    db.exec(organizationsSQL + initialSchema(config) + seedSQL)
    if (reverse) {
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid").all() as { name: string; sql: string }[]
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`)
      for (const trigger of triggers.reverse()) db.exec(trigger.sql)
    }
    const error = (() => { try { db.exec(forwardReplaceSQL) } catch (error) { return error } })()
    expect(constraintError(error, config)).toMatchObject(immutableConflict)
    expect(db.prepare("SELECT client FROM location WHERE id='used'").get()).toEqual({ client: 'c1' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.exec('DELETE FROM booking')
    expect(() => db.exec(forwardReplaceSQL)).toThrow('workbase_ref_equality_')
  } finally { db.close() }
})
