// Also copied into the installed upgrade consumer. Runtime SDK dependencies are
// supplied by that consumer, so replay never resolves a producer SDK by accident.
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { KernelRegistry } from '@workbasehq/core/kernel/registry'
import type * as infra from '@workbasehq/core/infra'
import type * as schema from '@workbasehq/core/migrations/schema'
import type * as pluginMigrations from '@workbasehq/core/kernel/migrations'

export type ReplayMigration = { name: string; sql: string }
export type ReplayEngine = Pick<typeof infra, 'migrateD1' | 'queryDatabase'> & Pick<typeof schema, 'revisionSQL'> & Partial<Pick<typeof pluginMigrations, 'PluginMigrationError'>> & { kernel: KernelRegistry }
export type ReplayDiagnostic = { file: string; migration: string; sqlError: string }
export class MigrationReplayError extends Error {
  readonly code = 'migration_replay_failed'
  constructor(readonly diagnostic: ReplayDiagnostic) {
    super(`Migration ${diagnostic.migration} failed in ${diagnostic.file}: ${diagnostic.sqlError}`)
  }
}
export const usesBaseline = (config: Pick<InstanceConfig, 'baseline'>) => config.baseline === 'workbase-sdk'

/** V3's baseline creates instance_meta; rN domain receipts populate it. */
export function readInstanceMeta(db: DatabaseSync) {
  return db.prepare('SELECT revision,core_version FROM instance_meta ORDER BY revision DESC LIMIT 1').get()
}
const baselineSource = (namespace: string) => namespace === 'workbase-sdk'
  ? '@workbasehq/core/src/migrations/sdk-baseline.ts' : namespace === 'workbase-core'
    ? '@workbasehq/core/src/migrations/model-b.ts' : `@workbasehq/plugins/${namespace}`
export function replayError(error: unknown, engine: Pick<ReplayEngine, 'PluginMigrationError'>): unknown {
  if (engine.PluginMigrationError && error instanceof engine.PluginMigrationError) {
    if (error.cause instanceof MigrationReplayError) return error.cause
    return new MigrationReplayError({ migration: `${error.namespace}/${error.migration}`, file: baselineSource(error.namespace),
      sqlError: error.cause instanceof Error ? error.cause.message : String(error.cause) })
  }
  return error
}
function diagnostic(sql: string, migrations: readonly ReplayMigration[]): Omit<ReplayDiagnostic, 'sqlError'> | undefined {
  const domain = migrations.find(m => sql === m.sql || sql.startsWith(m.sql + '\n;\n'))
  if (domain) return { file: `migrations/${domain.name}`, migration: domain.name }
  // The SDK engine appends this receipt to the same atomic batch as its SQL.
  const receipt = /INSERT INTO _plugin_migrations \(namespace,name,position,checksum\) VALUES \('((?:''|[^'])*)','((?:''|[^'])*)',/.exec(sql)
  if (receipt) {
    const namespace = receipt[1].replaceAll("''", "'"), name = receipt[2].replaceAll("''", "'")
    return { migration: `${namespace}/${name}`, file: baselineSource(namespace) }
  }
}
type ReplayRecorder = (sql: string, context?: Omit<ReplayDiagnostic, 'sqlError'>) => void
export function replayQuery(db: DatabaseSync, migrations: readonly ReplayMigration[] = [], record?: ReplayRecorder): infra.D1Query {
  return async sql => {
    const context = diagnostic(sql, migrations)
    // A migration batch may start with SELECT or PRAGMA and still contain DDL
    // and a receipt. Only standalone engine reads use prepare().all().
    const read = !context && /^\s*(?:SELECT|PRAGMA)\b/i.test(sql)
    db.exec('BEGIN')
    try {
      const results = read ? db.prepare(sql).all() : (db.exec(sql), [])
      db.exec('COMMIT')
      if (!read) record?.(sql, context)
      return [{ success: true, results }]
    } catch (error) {
      db.exec('ROLLBACK')
      if (context) throw new MigrationReplayError({ ...context, sqlError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

/** Real deploy order: SDK + ordered plugins, then domain files and rN receipts.
 * Retained inline instances replay their exact SQL without adding any baseline.
 * The upgrade bridge additionally requests the real domain ledger for legacy.
 */
export async function replayInstance(db: DatabaseSync, migrations: readonly ReplayMigration[], engine: ReplayEngine,
  options: { legacyLedger?: boolean; record?: ReplayRecorder } = {}) {
  const sdk = usesBaseline(engine.kernel.config)
  const query = replayQuery(db, migrations, options.record)
  if (sdk) {
    try { await engine.kernel.applyMigrations(engine.queryDatabase(query)) }
    catch (error) { throw replayError(error, engine) }
  }
  if (sdk || options.legacyLedger) {
    const files = migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') }))
    await engine.migrateD1(query, files, m => {
      const revision = sdk && /^\d+_r([1-9]\d*)\.sql$/.exec(m.filename)
      return revision ? engine.revisionSQL(Number(revision[1])) + '\n' : ''
    })
  } else {
    for (const migration of migrations) {
      try { db.exec(migration.sql); options.record?.(migration.sql) }
      catch (error) { throw new MigrationReplayError({ file: `migrations/${migration.name}`, migration: migration.name, sqlError: error instanceof Error ? error.message : String(error) }) }
    }
  }
}
