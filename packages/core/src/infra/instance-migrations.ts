import { assertSchemaLockBound } from '../schema/revision'
import { assertResetEra, usesSdkBaseline } from '../migrations/reset-era'
import { MigrationDiagnostic } from './diagnostics'
import { CORE_VERSION } from '../config'
import { hashMigrationRows } from '../schema-compatibility'
import { coreVersionSQL, revisionSQL, literal } from '../migrations/schema'
import { pluginMigrationStatus } from '../kernel/migrations'
import type { KernelRegistry } from '../kernel/registry'
import { migrateD1, type D1Query, type Migration } from './d1-migrations'

/** D1 HTTP batches execute the migration SQL and its receipt in one transaction.
 * Only ledger statements carry bindings; migration SQL is never interpolated. */
export function queryDatabase(query: D1Query): D1Database {
  const execute = async (sql: string) => {
    const result = await query(sql)
    if (!result.length || result.some(row => !row.success)) throw new MigrationDiagnostic({ code: 'd1_query_failed' })
    return result
  }
  const prepare = (sql: string) => {
    let values: unknown[] = []
    const statement = {
      bind(...bindings: unknown[]) { values = bindings; return statement },
      sql() {
        if (!values.length) return sql
        // Core's ledger queries contain only positional placeholders and no SQL
        // literals. Refuse any other form instead of treating SQL as a template.
        if (/[\x27\x22`]|--|\/\*/.test(sql)) throw new MigrationDiagnostic({ code: 'invalid_ledger_statement' })
        let index = 0
        const result = sql.replace(/\?/g, () => literal(values[index++]))
        if (index !== values.length) throw new MigrationDiagnostic({ code: 'invalid_ledger_bindings' })
        return result
      },
      async run() { return (await execute(statement.sql()))[0] },
      async all() { return { results: (await execute(statement.sql()))[0].results ?? [] } },
      async first(column?: string) { const row = (await statement.all()).results[0]; return column ? row?.[column] ?? null : row ?? null },
    }
    return statement
  }
  return { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    return execute(statements.map(statement => statement.sql()).join(';\n') + ';')
  } } as unknown as D1Database
}

// Match MCP's supported baseline: numeric release versions in the same major,
// no newer than this SDK. Compare components numerically (0.2.10 > 0.2.8).
function supportedCoreVersion(value: unknown) {
  const version = typeof value === 'string' && value.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
  const current = CORE_VERSION.split('.').map(Number)
  return version && version.every(Number.isSafeInteger) && version.join('.') === value && version[0] === current[0] &&
    (version[1] < current[1] || (version[1] === current[1] && version[2] <= current[2]))
}

export async function migrateInstance(query: D1Query, files: readonly Migration[], kernel: KernelRegistry) {
  assertSchemaLockBound(kernel.config)
  const db = queryDatabase(query)
  const sdk = usesSdkBaseline(kernel.config)
  if (sdk) await assertResetEra(db)
  const metaSQL = 'SELECT revision,core_version FROM instance_meta ORDER BY revision DESC LIMIT 1'
  // Check an existing database before even creating a ledger or applying SQL:
  // a pending SQL file could otherwise overwrite an unsupported SDK stamp.
  const existing = await db.prepare("SELECT name FROM sqlite_master WHERE name='instance_meta'").first()
  if (existing) {
    const stored = await db.prepare(metaSQL).first<{ core_version: string }>()
    if ((stored || !sdk) && !supportedCoreVersion(stored?.core_version)) throw new MigrationDiagnostic({ code: 'migration_instance_revision_mismatch' })
  }
  if (sdk) await kernel.applyMigrations(db)
  const domain = await migrateD1(query, files, migration => {
    if (!sdk) return ''
    const match = /^\d+_r([1-9]\d*)\.sql$/.exec(migration.filename)
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new MigrationDiagnostic({ code: 'migration_instance_revision_mismatch' })
    return revisionSQL(Number(match[1])) + '\n'
  })
  const rows = await db.prepare('SELECT filename,checksum FROM _migrations ORDER BY filename').all<{ filename: string; checksum: string }>()
  const expectedRows = [...files].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
  if (await hashMigrationRows(rows.results) !== await hashMigrationRows(expectedRows)) throw new MigrationDiagnostic({ code: 'migration_instance_verification_failed' })
  const meta = await db.prepare(metaSQL).first<{ revision: number; core_version: string }>()
  if (meta?.revision !== kernel.config.revision || !supportedCoreVersion(meta.core_version)) throw new MigrationDiagnostic({ code: 'migration_instance_revision_mismatch' })
  if (!sdk) await kernel.applyMigrations(db)
  const status = await pluginMigrationStatus(db, kernel.plugins, kernel.config)
  if (status.expected !== status.applied) throw new MigrationDiagnostic({ code: 'migration_plugin_verification_failed' })
  // A release can change CORE_VERSION without adding SQL or a config revision.
  // Stamp it only after both ledgers and plugin schema checks have succeeded.
  if (meta.core_version !== CORE_VERSION) await db.prepare(coreVersionSQL(kernel.config.revision)).run()
  const applied = await db.prepare(metaSQL).first<{ revision: number; core_version: string }>()
  if (applied?.revision !== kernel.config.revision || applied.core_version !== CORE_VERSION) throw new MigrationDiagnostic({ code: 'migration_instance_revision_mismatch' })
  return { ...domain, pluginMigrations: status.applied }
}
