// Also copied into the installed upgrade consumer. Runtime SDK dependencies are
// supplied by that consumer, so replay never resolves a producer SDK by accident.
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { KernelRegistry } from '@workbasehq/core/kernel/registry'
import type * as infra from '@workbasehq/core/infra'
import type * as schema from '@workbasehq/core/migrations/schema'
import type * as pluginMigrations from '@workbasehq/core/kernel/migrations'

// Bound and redact even trusted SQLite diagnostics before crossing a boundary.
export function publicText(text: string, limit: number) {
  for (const [name, value] of Object.entries(process.env)) if (value && /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL/i.test(name)) {
    text = text.replaceAll(value, '[redacted]').replaceAll(JSON.stringify(value).slice(1, -1), '[redacted]')
  }
  return text.slice(0, limit)
}
const sqliteFailures = new WeakSet<object>()
export function sqliteMessage(error: unknown) {
  if (!(error instanceof Error) || !('code' in error) || !/^ERR_SQLITE/.test(String(error.code))) return 'SQLite migration failed'
  // SQLite may surface user-defined RAISE() text. Only standard diagnostics
  // with identifier/token fields are public; callback exceptions never enter here.
  const safe = /^(?:no such (?:table|column|index): [\w.]+|(?:UNIQUE|NOT NULL|CHECK) constraint failed: [\w., ]+|FOREIGN KEY constraint failed|near "[\w]+": syntax error|incomplete input|table [\w]+ already exists|duplicate column name: [\w]+)$/
  return safe.test(error.message) ? publicText(error.message, 2048) : 'SQLite migration failed'
}

export type ReplayMigration = { name: string; sql: string; syntheticRevision?: number }
export type ReplayEngine = Pick<typeof infra, 'migrateD1' | 'migrateInstance' | 'instanceMigrationReceipt' | 'queryDatabase'> & Pick<typeof schema, 'revisionSQL'> & Partial<Pick<typeof pluginMigrations, 'PluginMigrationError'>> & { kernel: KernelRegistry }
export type ReplayDiagnostic = { file: string; migration: string; sqlError: string }
export class MigrationReplayError extends Error {
  readonly code = 'migration_replay_failed'
  readonly diagnostic: ReplayDiagnostic
  constructor(diagnostic: ReplayDiagnostic) {
    const bounded = { file: publicText(diagnostic.file, 512), migration: publicText(diagnostic.migration, 256), sqlError: publicText(diagnostic.sqlError, 2048) }
    super(`Migration ${bounded.migration} failed in ${bounded.file}: ${bounded.sqlError}`)
    this.diagnostic = bounded
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
    console.error('Private plugin migration failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
    return new MigrationReplayError({ migration: `${error.namespace}/${error.migration}`, file: baselineSource(error.namespace),
      sqlError: error.cause instanceof Error && ['Plugin migration transaction control is forbidden', 'Unterminated plugin migration block'].includes(error.cause.message) ? error.cause.message : typeof error.cause === 'object' && error.cause !== null && sqliteFailures.has(error.cause) ? sqliteMessage(error.cause) : 'Migration statement generation failed' })
  }
  return error
}
function diagnostic(sql: string, migrations: readonly ReplayMigration[]): Omit<ReplayDiagnostic, 'sqlError'> | undefined {
  // Match the engine-owned receipt at the end of the batch, including its
  // checksum. A SQL prefix can belong to more than one migration.
  const domain = migrations.find(m => {
    if (sql === m.sql) return true
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
    const checksum = createHash('sha256').update(m.sql).digest('hex')
    return sql.endsWith(`INSERT INTO _migrations (filename,applied_at,checksum) VALUES (${literal(m.name)},strftime('%Y-%m-%dT%H:%M:%fZ','now'),${literal(checksum)});`)
  })
  if (domain) return { file: `migrations/${domain.name}`, migration: domain.name }
  // The SDK engine appends this receipt to the same atomic batch as its SQL.
  const receipt = /INSERT INTO _plugin_migrations \(namespace,name,position,checksum\) VALUES \('((?:''|[^'])*)','((?:''|[^'])*)',\d+,'[a-f0-9]{64}'\);$/.exec(sql)
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
    const candidateRead = !context && /^\s*(?:SELECT|PRAGMA)\b/i.test(sql)
    let read = false
    db.exec('BEGIN')
    try {
      const statement = candidateRead ? db.prepare(sql) : undefined
      // SQLite exposes the first parsed statement, respecting quoted semicolons.
      // A trailing statement must execute as part of the full atomic batch.
      read = !!statement && !sql.slice(statement.sourceSQL.length).trim()
      const results = read ? statement!.all() : (db.exec(sql), [])
      db.exec('COMMIT')
      if (!read) record?.(sql, context)
      return [{ success: true, results }]
    } catch (error) {
      if (typeof error === 'object' && error !== null) sqliteFailures.add(error)
      if (db.isTransaction) {
        try { db.exec('ROLLBACK') } catch (cleanup) { console.error('Private replay cleanup failure', String(cleanup instanceof Error ? cleanup.stack : cleanup).slice(0, 65536)) }
      }
      console.error('Private SQLite replay failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
      if (context) throw new MigrationReplayError({ ...context, sqlError: sqliteMessage(error) })
      throw error
    }
  }
}

/** Real deploy order: SDK + ordered plugins, then domain files and rN receipts.
 * Retained inline instances replay their exact SQL without adding any baseline.
 * The upgrade bridge additionally requests the real domain ledger for legacy.
 */
export async function replayInstance(db: DatabaseSync, migrations: readonly ReplayMigration[], engine: ReplayEngine,
  options: { mode?: 'synthetic'; legacyLedger?: boolean; record?: ReplayRecorder } = {}) {
  const sdk = usesBaseline(engine.kernel.config)
  const query = replayQuery(db, migrations, options.record)
  const files = migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') }))
  if (sdk && options.mode !== 'synthetic') {
    try { await engine.migrateInstance(query, files, engine.kernel) }
    catch (error) { throw replayError(error, engine) }
  } else if (sdk || options.legacyLedger) {
    if (sdk) {
      try { await engine.kernel.applyMigrations(engine.queryDatabase(query)) }
      catch (error) { throw replayError(error, engine) }
    }
    await engine.migrateD1(query, files, m => {
      const synthetic = options.mode === 'synthetic' && migrations.find(input => input.name === m.filename)?.syntheticRevision
      return synthetic ? engine.revisionSQL(synthetic) + '\n' : sdk ? engine.instanceMigrationReceipt(true, m) : ''
    })
  } else {
    for (const migration of migrations) {
      try { db.exec(migration.sql); options.record?.(migration.sql) }
      catch (error) { throw new MigrationReplayError({ file: `migrations/${migration.name}`, migration: migration.name, sqlError: sqliteMessage(error) }) }
    }
  }
}
