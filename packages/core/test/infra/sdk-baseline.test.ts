import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'
import { baselineContract } from '../fixtures/sdk-baseline/contract'
import { eraContract } from '../fixtures/config-era/contract'
import type { D1Query } from '../../src/infra/d1-migrations'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function database() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite)
  sqlite.exec('PRAGMA foreign_keys=ON')
  const calls: string[] = []
  const query: D1Query = async sql => {
    calls.push(sql)
    if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) return [{ success: true, results: sqlite.prepare(sql).all() }]
    sqlite.exec('BEGIN')
    try { sqlite.exec(sql); sqlite.exec('COMMIT'); return [{ success: true }] }
    catch (error) { sqlite.exec('ROLLBACK'); throw error }
  }
  const prepare = (sql: string) => {
    let values: (string | number | null)[] = []
    const statement = {
      bind(...bindings: typeof values) { values = bindings; return statement },
      async all() { return { results: sqlite.prepare(sql).all(...values) } },
      async first(column?: string) { const row = sqlite.prepare(sql).get(...values); return column ? row?.[column] ?? null : row ?? null },
      async run() { sqlite.prepare(sql).run(...values); return { success: true } },
    }
    return statement
  }
  const db = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sqlite.exec('BEGIN')
    try { const results = await Promise.all(statements.map(statement => statement.run())); sqlite.exec('COMMIT'); return results }
    catch (error) { sqlite.exec('ROLLBACK'); throw error }
  } } as unknown as D1Database
  return { db, query, calls }
}
baselineContract(database)
eraContract(database)
