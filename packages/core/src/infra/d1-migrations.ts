import { MigrationDiagnostic } from './diagnostics'
// Shared by the HTTP CLI and SQLite contract tests. One API batch per file, including its receipt.
export interface Migration { filename: string; sql: string; checksum: string }
export interface QueryResult { success: boolean; results?: Record<string, unknown>[] }
export type D1Query = (sql: string) => Promise<QueryResult[]>
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
export async function migrateD1(query: D1Query, input: readonly Migration[]) {
  const migrations = [...input].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
  if (new Set(migrations.map(m => m.filename)).size !== migrations.length) throw new MigrationDiagnostic({ code: 'duplicate_migration_filename' })
  const execute: D1Query = async sql => {
    const results = await query(sql)
    if (!results.length || results.some(r => !r.success)) throw new MigrationDiagnostic({ code: 'd1_query_failed' })
    return results
  }
  await execute('CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);')
  const applied = (await execute('SELECT filename, checksum FROM _migrations ORDER BY filename;'))[0].results ?? []
  const known = new Map(migrations.map(m => [m.filename, m]))
  for (const row of applied) {
    if (known.get(String(row.filename))?.checksum !== row.checksum) throw new MigrationDiagnostic({ code: 'migration_history_mismatch', filename: row.filename })
  }
  const done = new Set(applied.map(row => String(row.filename)))
  // Inserting a new migration before an already-applied file would violate the ordered chain.
  const last = [...done].sort().at(-1)
  for (const migration of migrations) {
    if (done.has(migration.filename)) continue
    if (last && migration.filename < last) throw new MigrationDiagnostic({ code: 'migration_out_of_order', filename: migration.filename })
    await execute(`${migration.sql}\n;\nINSERT INTO _migrations (filename,applied_at,checksum) VALUES (${literal(migration.filename)},strftime('%Y-%m-%dT%H:%M:%fZ','now'),${literal(migration.checksum)});`)
  }
  return { applied: migrations.length - done.size, total: migrations.length }
}
