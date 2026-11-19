import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { initialSchema } from '../src/migrations/schema'
import { diffSpecs, schemaLock } from '../src/migrations/schema-lock'
import { checkEntityConstraints } from '../src/kernel/schema-check'
import { constraintError } from '../src/constraint-errors'
import { reviewConfig, uniqueTransitions, organizationsSQL, seedSQL, multiReplaceSQL, forwardReplaceSQL, schemaObjectsSQL, immutableConflict } from './fixtures/ref-immutable-review2'

const exec = (db: D1Database, sql: string) => db.exec(sql.replaceAll('\n', ' '))
// Derived from s4-review2 d1-results.json: migrated schemas must enforce the fresh schema's guard.
it.each(uniqueTransitions)('refreshes immutable triggers on D1 after %s and passes schema checks', async (_name, oldKeys, newKeys) => {
  await reset()
  const before = reviewConfig(oldKeys), after = reviewConfig(newKeys)
  const base = schemaLock(before), next = schemaLock(after, base)
  await exec(env.DB, organizationsSQL + initialSchema(before) + seedSQL)
  await exec(env.DB, diffSpecs(base.tables, next.tables))
  await exec(env.FRESH_DB, organizationsSQL + initialSchema(after))
  await expect(checkEntityConstraints(env.DB, after)).resolves.toBeUndefined()
  await expect(checkEntityConstraints(env.FRESH_DB, after)).resolves.toBeUndefined()
  expect((await env.DB.prepare(schemaObjectsSQL).all()).results).toEqual((await env.FRESH_DB.prepare(schemaObjectsSQL).all()).results)
})
it('rejects multi-row unique-key REPLACE after adding unique to an immutable entity on D1', async () => {
  await reset()
  const before = reviewConfig(), after = reviewConfig(uniqueTransitions[0][2])
  const base = schemaLock(before), next = schemaLock(after, base)
  await exec(env.DB, organizationsSQL + initialSchema(before) + seedSQL + diffSpecs(base.tables, next.tables))
  const rows = (await env.DB.prepare('SELECT * FROM location').all()).results
  const error = await env.DB.prepare(multiReplaceSQL).run().catch(error => error)
  expect(constraintError(error, after)).toMatchObject(immutableConflict)
  expect((await env.DB.prepare('SELECT * FROM location').all()).results).toEqual(rows)
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
})
it.each([false, true])('prioritizes immutability over forward equality on D1 with reversed trigger installation=%s', async reverse => {
  await reset()
  const config = reviewConfig([], true)
  await exec(env.DB, organizationsSQL + initialSchema(config) + seedSQL)
  if (reverse) {
    const { results: triggers } = await env.DB.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid").all<{ name: string; sql: string }>()
    for (const trigger of triggers) await exec(env.DB, `DROP TRIGGER "${trigger.name}"`)
    for (const trigger of triggers.reverse()) await exec(env.DB, trigger.sql)
  }
  const error = await env.DB.prepare(forwardReplaceSQL).run().catch(error => error)
  expect(constraintError(error, config)).toMatchObject(immutableConflict)
  expect(await env.DB.prepare("SELECT client FROM location WHERE id='used'").first()).toEqual({ client: 'c1' })
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  await env.DB.prepare('DELETE FROM booking').run()
  const unreferenced = await env.DB.prepare(forwardReplaceSQL).run().catch(error => error)
  expect(constraintError(unreferenced, config)).toMatchObject({ status: 422, code: 'ref_equality_mismatch' })
})
