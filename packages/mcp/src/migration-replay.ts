// Also copied into the installed upgrade consumer. Runtime SDK dependencies are
// supplied by that consumer, so replay never resolves a producer SDK by accident.
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { KernelRegistry } from '@workbasehq/core/kernel/registry'
import type * as infra from '@workbasehq/core/infra'
import type * as schema from '@workbasehq/core/migrations/schema'
import type * as pluginMigrations from '@workbasehq/core/kernel/migrations'

// Bound and redact engine-owned source identifiers before crossing a boundary.
export function publicText(text: string, limit: number) {
  for (const [name, value] of Object.entries(process.env)) if (value && /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL/i.test(name)) {
    text = text.replaceAll(value, '[redacted]').replaceAll(JSON.stringify(value).slice(1, -1), '[redacted]')
  }
  return text.slice(0, limit)
}
const sqliteFailures = new WeakSet<object>()
// Public diagnostics are values owned here, never fragments of SQLite/callback
// text. In particular SQLITE_CONSTRAINT_TRIGGER (1811) carries arbitrary RAISE
// text, and SQLITE_ERROR (1) includes arbitrary identifiers and syntax tokens.
export const replayMessages = {
  sqlite: 'SQLite migration failed',
  sql: 'SQLite SQL logic error',
  unique: 'UNIQUE constraint failed',
  notNull: 'NOT NULL constraint failed',
  check: 'CHECK constraint failed',
  foreignKey: 'FOREIGN KEY constraint failed',
  trigger: 'SQLite trigger rejected the migration',
  generation: 'Migration statement generation failed',
} as const
export type ReplayErrorKind = keyof typeof replayMessages
export function sqliteKind(error: unknown): ReplayErrorKind {
  const code = typeof error === 'object' && error !== null && 'errcode' in error ? error.errcode : undefined
  switch (code) {
    case 1: return 'sql'
    case 1555: case 2067: return 'unique'
    case 1299: return 'notNull'
    case 275: return 'check'
    case 787: return 'foreignKey'
    case 1811: return 'trigger'
    default: return 'sqlite'
  }
}

export type ReplayMigration = { name: string; sql: string; syntheticRevision?: number }
export type ReplayEngine = Pick<typeof infra, 'migrateD1' | 'migrateInstance' | 'instanceMigrationReceipt' | 'queryDatabase'> & Pick<typeof schema, 'revisionSQL'> & Partial<Pick<typeof pluginMigrations, 'PluginMigrationError'>> & { kernel: KernelRegistry }
type ReplayContext = { file: string; migration: string }
export type ReplayDiagnostic = ReplayContext & { kind: ReplayErrorKind; sqlError: string }
// Underlying text never becomes an Error property or public diagnostic. This
// module is also copied to the isolated SDK consumer, so keep storage local.
const privateReplayCauses = new WeakMap<object, unknown>()
export function privateReplayMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && privateReplayCauses.has(error)) return privateReplayMessage(privateReplayCauses.get(error))
  return error instanceof Error ? error.message : String(error)
}
export class MigrationReplayError extends Error {
  readonly code = 'migration_replay_failed'
  readonly diagnostic: ReplayDiagnostic
  constructor(diagnostic: ReplayContext & { kind: ReplayErrorKind }, cause?: unknown) {
    const kind = Object.hasOwn(replayMessages, diagnostic.kind) ? diagnostic.kind : 'sqlite'
    const bounded = { file: publicText(diagnostic.file, 512), migration: publicText(diagnostic.migration, 256), kind, sqlError: replayMessages[kind] }
    super(`Migration ${bounded.migration} failed in ${bounded.file}: ${bounded.sqlError}`)
    this.diagnostic = bounded
    if (cause !== undefined) privateReplayCauses.set(this, cause)
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
    console.error('Private plugin migration failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
    return new MigrationReplayError({ migration: `${error.namespace}/${error.migration}`, file: baselineSource(error.namespace),
      kind: typeof error.cause === 'object' && error.cause !== null && sqliteFailures.has(error.cause) ? sqliteKind(error.cause) : 'generation' }, error.cause)
  }
  if (typeof error === 'object' && error !== null && sqliteFailures.has(error)) {
    return new MigrationReplayError({ file: '@workbasehq/core/infra', migration: 'verification', kind: sqliteKind(error) }, error)
  }
  return error
}
function diagnostic(sql: string, migrations: readonly ReplayMigration[]): ReplayContext | undefined {
  // Match the engine-owned receipt at the end of the batch, including its
  // checksum. A SQL prefix can belong to more than one migration.
  const domain = migrations.find(m => {
    if (sql === m.sql) return true
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
    const checksum = createHash('sha256').update(m.sql).digest('hex')
    return sql.endsWith(`INSERT INTO _migrations (filename,applied_at,checksum) VALUES (${literal(m.name)},strftime('%Y-%m-%dT%H:%M:%fZ','now'),${literal(checksum)});`)
  })
  if (domain) return { file: `migrations/${domain.name}`, migration: domain.name }
  // Plugin attribution comes from PluginMigrationError, which the engine wraps
  // around its own registry entry. Never parse source identifiers from callback SQL.
}
type ReplayRecorder = (sql: string, context?: ReplayContext) => void
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
      if (context) throw new MigrationReplayError({ ...context, kind: sqliteKind(error) }, error)
      throw error
    }
  }
}

/** Real deploy order: SDK + ordered plugins, then domain files and rN receipts.
 * Retained inline instances replay their exact SQL without adding any baseline.
 * The upgrade bridge additionally requests the real domain ledger for legacy.
 */
export async function replayInstance(db: DatabaseSync, migrations: readonly ReplayMigration[], engine: ReplayEngine,
  options: { mode?: 'synthetic' | 'schema'; legacyLedger?: boolean; record?: ReplayRecorder } = {}) {
  const sdk = usesBaseline(engine.kernel.config)
  // Synthetic inputs still deploy through the real kernel. Only their filenames
  // are constructed here so deployment owns every revision receipt and check.
  if (sdk && options.mode) migrations = migrations.map((migration, index) => migration.syntheticRevision === undefined
    ? migration : { ...migration, name: `${String(index + 1).padStart(4, '0')}_r${migration.syntheticRevision}.sql` })
  const query = replayQuery(db, migrations, options.record)
  const files = migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') }))
  if (sdk && options.mode !== 'schema') {
    try { await engine.migrateInstance(query, files, engine.kernel) }
    catch (error) { throw replayError(error, engine) }
  } else if (sdk || options.legacyLedger) {
    // Only fresh desired-schema construction skips deployment verification:
    // it has no committed data on which a target checkSchema may depend.
    if (sdk) {
      try { await engine.kernel.applyMigrations(engine.queryDatabase(query)) }
      catch (error) { throw replayError(error, engine) }
    }
    await engine.migrateD1(query, files, migration => sdk ? engine.instanceMigrationReceipt(true, migration) : '')
  } else {
    for (const migration of migrations) {
      try { db.exec(migration.sql); options.record?.(migration.sql) }
      catch (error) {
        console.error('Private SQLite replay failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
        throw new MigrationReplayError({ file: `migrations/${migration.name}`, migration: migration.name, kind: sqliteKind(error) }, error)
      }
    }
  }
}
