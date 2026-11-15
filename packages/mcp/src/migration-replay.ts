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
  pluginSchema: 'Plugin schema verification failed',
  verification: 'Migration receipts or revision verification failed',
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
export type ReplayEngine = Pick<typeof infra, 'migrateD1' | 'migrateInstance' | 'instanceMigrationReceipt' | 'queryDatabase'> & Pick<typeof schema, 'revisionSQL'> & Partial<Pick<typeof infra, 'migrationErrorMessage'>> & Partial<Pick<typeof pluginMigrations, 'PluginMigrationError' | 'PluginMigrationHistoryError'>> & { kernel: KernelRegistry }
export const replayPhases = ['sdk', 'plugin', 'domain', 'verification'] as const
type ReplayContext = { file: string; migration: string; namespace?: string; phase?: typeof replayPhases[number] }
export type ReplayDiagnostic = ReplayContext & { kind: ReplayErrorKind; sqlError: string; phase: typeof replayPhases[number]; hint: string }
export const engineFailureCodes = [
  'schema_lock_not_bound', 'migration_unsupported_history', 'migration_history_mismatch', 'migration_out_of_order',
  'invalid_migration_filename', 'duplicate_migration_filename', 'migration_sequence_gap_or_duplicate',
  'migration_instance_verification_failed', 'migration_instance_revision_mismatch', 'migration_plugin_verification_failed',
  'migration_plugin_history_mismatch', 'migration_blocked',
] as const
type ReplayCode = 'migration_replay_failed' | typeof engineFailureCodes[number]
const safeIdentifier = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? publicText(value, 128) : '[nonstandard identifier]'
const safeMigration = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,203}$/.test(value) && !value.includes('..') ? publicText(value, 204) : '[nonstandard migration]'
const safeFile = (value: string) => /^(?:migrations\/[a-zA-Z0-9_-]{1,200}\.sql|@workbasehq\/core\/(?:infra|src\/migrations\/(?:sdk-baseline|model-b)\.ts)|@workbasehq\/plugins\/[a-zA-Z0-9_-]{1,128})$/.test(value) ? publicText(value, 512) : '[nonstandard source]'
// Underlying text never becomes an Error property or public diagnostic. This
// module is also copied to the isolated SDK consumer, so keep storage local.
const privateReplayCauses = new WeakMap<object, unknown>()
export function privateReplayMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && privateReplayCauses.has(error)) return privateReplayMessage(privateReplayCauses.get(error))
  return error instanceof Error ? error.message : String(error)
}
export class MigrationReplayError extends Error {
  readonly code: ReplayCode
  readonly diagnostic: ReplayDiagnostic
  constructor(diagnostic: ReplayContext & { kind: ReplayErrorKind }, cause?: unknown, code: ReplayCode = 'migration_replay_failed') {
    const kind = Object.hasOwn(replayMessages, diagnostic.kind) ? diagnostic.kind : 'sqlite'
    const namespace = diagnostic.namespace === undefined ? undefined : safeIdentifier(diagnostic.namespace)
    const migration = (namespace === undefined ? safeMigration(diagnostic.migration) : `${namespace}/${safeMigration(diagnostic.migration.split('/').at(-1)!)}`).slice(0, 256)
    const phase = replayPhases.includes(diagnostic.phase!) ? diagnostic.phase! : diagnostic.file.startsWith('migrations/') ? 'domain' : 'verification'
    const hint = kind === 'verification' ? 'Review the committed migration history, checksums and bound schema revision; do not rewrite applied receipts.'
      : phase === 'verification' ? 'Review the installed plugin schema contract against the replayed database.'
        : 'Review the named migration and its SDK or plugin prerequisites; retry after correcting the source.'
    const bounded = { file: safeFile(diagnostic.file), migration, kind, sqlError: replayMessages[kind], phase, hint, ...(namespace === undefined ? {} : { namespace }) }
    super(`${code === 'migration_replay_failed' ? '' : `${code}: `}Migration ${bounded.migration} failed in ${bounded.file}: ${bounded.sqlError}`)
    this.code = code
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
export function replayError(error: unknown, engine: Pick<ReplayEngine, 'PluginMigrationError' | 'PluginMigrationHistoryError' | 'migrationErrorMessage'>, migrations: readonly ReplayMigration[] = []): unknown {
  if (engine.PluginMigrationHistoryError && error instanceof engine.PluginMigrationHistoryError) {
    return new MigrationReplayError({ migration: `${error.namespace}/${error.migration}`, namespace: error.namespace,
      file: baselineSource(error.namespace), phase: 'verification', kind: 'verification' }, error, 'migration_plugin_history_mismatch')
  }
  if (engine.PluginMigrationError && error instanceof engine.PluginMigrationError) {
    console.error('Private plugin migration failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
    return new MigrationReplayError({ migration: `${error.namespace}/${error.migration}`, namespace: error.namespace, file: baselineSource(error.namespace),
      phase: error.migration === 'checkSchema' ? 'verification' : error.namespace === 'workbase-sdk' ? 'sdk' : 'plugin',
      kind: typeof error.cause === 'object' && error.cause !== null && sqliteFailures.has(error.cause) ? sqliteKind(error.cause)
        : error.migration === 'checkSchema' ? 'pluginSchema' : 'generation' }, error.cause,
      error.migration === 'checkSchema' ? 'migration_plugin_verification_failed' : 'migration_replay_failed')
  }
  const message = engine.migrationErrorMessage?.(error)
  const token = message?.split(':', 1)[0]
  // The lock diagnostic predates code-prefixed core messages. The formatter
  // still supplies this token only for its branded internal error.
  const code = token === 'schema lock not bound' ? 'schema_lock_not_bound' : engineFailureCodes.find(code => code === token)
  // Formatted callback data stays private. A filename is exposed only when it
  // names one of this replay's inputs, never an arbitrary ledger/callback value.
  const source = migrations.find(migration => message === `${code}:${migration.name}`)
  if (code) return new MigrationReplayError({ file: source ? `migrations/${source.name}` : '@workbasehq/core/infra',
    migration: source?.name ?? 'verification', phase: 'verification', kind: 'verification' }, error, code)
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
  options: { mode?: 'synthetic' | 'schema'; legacyLedger?: boolean; record?: ReplayRecorder; verifyExisting?: boolean } = {}) {
  const sdk = usesBaseline(engine.kernel.config)
  if (sdk) db.exec('PRAGMA foreign_keys=ON')
  // Synthetic inputs still deploy through the real kernel. Only their filenames
  // are constructed here so deployment owns every revision receipt and check.
  if (sdk && options.mode) migrations = migrations.map((migration, index) => migration.syntheticRevision === undefined
    ? migration : { ...migration, name: `${String(index + 1).padStart(4, '0')}_r${migration.syntheticRevision}.sql` })
  let wrote = false
  const query = replayQuery(db, migrations, (sql, context) => { wrote = true; options.record?.(sql, context) })
  const files = migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') }))
  if (sdk && options.mode !== 'schema') {
    try { await engine.migrateInstance(query, files, engine.kernel) }
    catch (error) { throw replayError(error, engine, migrations) }
    // A disposable verification must prove the state Wrangler produced. A
    // successful retry that fills missing receipts is not accepted evidence.
    if (options.verifyExisting && wrote) throw new MigrationReplayError({ file: '@workbasehq/core/infra', migration: 'verification', phase: 'verification', kind: 'verification' }, undefined, 'migration_instance_verification_failed')
  } else if (sdk || options.legacyLedger) {
    // Only fresh desired-schema construction skips deployment verification:
    // it has no committed data on which a target checkSchema may depend.
    if (sdk) {
      try { await engine.kernel.applyMigrations(engine.queryDatabase(query)) }
      catch (error) { throw replayError(error, engine, migrations) }
    }
    try { await engine.migrateD1(query, files, migration => sdk ? engine.instanceMigrationReceipt(true, migration) : '') }
    catch (error) { throw replayError(error, engine, migrations) }
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
