import { DatabaseSync } from 'node:sqlite'
import type { Bundle, Migration } from './storage.ts'
import { CORE_VERSION } from '@workbasehq/core/config'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { PluginMigrationError } from '@workbasehq/core/kernel/migrations'
import { migrateD1, migrateInstance, instanceMigrationReceipt, migrationErrorMessage, queryDatabase } from '@workbasehq/core/infra'
import { replayInstance, readInstanceMeta, usesBaseline, MigrationReplayError, privateReplayMessage, sqliteKind, type ReplayMigration } from './migration-replay.ts'
import { initialSchema, revisionSQL } from '@workbasehq/core/migrations/schema'
import { fail, WorkflowError } from './schemas.ts'
import { indexSQL, rebuildBlock, rebuildBlockMessage } from './planning.ts'
import { tokenizeSQL, tokenFingerprint, sqlFingerprint, foldIdentifier, isPunct, SqlTokenizationError } from './sql-tokens.ts'
import { tableSemantics, ddlFingerprint, SqlSchemaError } from './sql-schema.ts'

// Only server-generated SQL and checked-in instance migrations enter this offline database.
export function replay<T>(migrations: Migration[], fn: (db: DatabaseSync) => T, entities: readonly string[] = []): T {
  const db = new DatabaseSync(':memory:')
  try {
    for (const m of migrations) {
      try { db.exec(m.sql) }
      catch (error) {
        console.error('Private SQLite replay failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
        const block = rebuildBlock(privateReplayMessage(error), entities)
        if (block) fail('migration_blocked', rebuildBlockMessage(block))
        throw new MigrationReplayError({ file: `migrations/${m.name}`, migration: m.name, kind: sqliteKind(error) })
      }
    }
    return fn(db)
  } finally { db.close() }
}
export const replayEngine = (config: Bundle['config'], runtime?: Bundle['runtime']) => ({ kernel: new KernelRegistry(runtime
  ? { ...runtime, ...config, plugins: runtime.plugins, interactive: runtime.interactive } : config), migrateD1, migrateInstance, instanceMigrationReceipt, queryDatabase, revisionSQL, PluginMigrationError })
// A plugin can throw a branded engine diagnostic too. Select only a known
// code from its parsed token; formatted diagnostic data is private.
const engineFailureCodes = [
  'migration_unsupported_history', 'migration_history_mismatch', 'migration_out_of_order',
  'migration_sequence_gap_or_duplicate', 'migration_instance_verification_failed',
  'migration_instance_revision_mismatch', 'migration_plugin_verification_failed', 'migration_blocked',
] as const
export async function replayBundle<T>(bundle: Pick<Bundle, 'config' | 'runtime'> & { migrations: ReplayMigration[]; currentConfig?: Bundle['config'] }, fn: (db: DatabaseSync) => T, options: { mode?: 'synthetic' | 'schema' } = {}): Promise<T> {
  const entities = [...Object.keys(bundle.config.entities), ...Object.keys(bundle.currentConfig?.entities ?? {})]
  if (!usesBaseline(bundle.config)) return replay(bundle.migrations, fn, entities)
  const db = new DatabaseSync(':memory:')
  try {
    await replayInstance(db, bundle.migrations, replayEngine(bundle.config, bundle.runtime), options)
    return fn(db)
  } catch (error) {
    const block = rebuildBlock(privateReplayMessage(error), entities)
    if (block) fail('migration_blocked', rebuildBlockMessage(block))
    const token = migrationErrorMessage(error).split(':', 1)[0]
    const code = engineFailureCodes.find(code => code === token)
    if (code) {
      console.error('Private engine replay failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
      fail(code, code, 422)
    }
    throw error
  } finally { db.close() }
}
const q = (name: string) => `"${name.replaceAll('"', '""')}"`
function unsupportedSchema(): never {
  throw new WorkflowError('config_schema_mismatch', 'Schema contains semantics unsupported by offline verification', 400,
    { phase: 'verification', hint: 'Use schema constructs covered by offline verification before retrying.' })
}
const canonicalType = (type: string) => {
  const tokens = tokenizeSQL(type)
  return tokenFingerprint(tokens, new Set(tokens.map(token => foldIdentifier(token.value))))
}
const sorted = <T>(values: T[]) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
export function snapshot(db: DatabaseSync, domainLedger = false) {
  try { return schemaSnapshot(db, domainLedger) }
  catch (error) {
    if (error instanceof SqlTokenizationError) throw new WorkflowError(error.code, error.message, 400, { phase: 'verification', offset: error.offset })
    if (error instanceof SqlSchemaError) unsupportedSchema()
    throw error
  }
}
function schemaSnapshot(db: DatabaseSync, domainLedger: boolean) {
  if (db.prepare('PRAGMA database_list').all().some(row => row.name !== 'main' && row.name !== 'temp')
    || db.prepare('SELECT 1 FROM sqlite_temp_master LIMIT 1').get()) unsupportedSchema()
  // Exclude only known transport/receipt tables and their indexes. A trigger's
  // name (or a reserved-looking prefix) must never hide its behavior.
  const master = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND NOT (type IN ('table','index') AND tbl_name IN ('_cf_KV','_cf_METADATA','d1_migrations'" + (domainLedger ? ",'_migrations'" : '') + ')) ORDER BY type,name').all()
  const tables = db.prepare('PRAGMA table_list').all()
  return master.map(row => {
    const base = { type: row.type, name: row.name, table: row.tbl_name }
    if (row.type === 'trigger' || row.type === 'index') {
      if (typeof row.sql !== 'string') unsupportedSchema()
      const scope = { table: String(row.tbl_name), columns: db.prepare(`PRAGMA table_xinfo(${q(String(row.tbl_name))})`).all().map(column => String(column.name)) }
      return { ...base, sql: ddlFingerprint(row.sql, String(row.type), String(row.name), scope) }
    }
    if (row.type !== 'table' || typeof row.sql !== 'string') unsupportedSchema()
    const table = tables.find(t => t.schema === 'main' && t.name === row.name)
    if (table?.type !== 'table') unsupportedSchema()
    const columns = db.prepare(`PRAGMA table_xinfo(${q(String(row.name))})`).all()
    if (!columns.length || columns.some(c => ![0, 2, 3].includes(Number(c.hidden)))) unsupportedSchema()
    const tokens = tokenizeSQL(row.sql)
    if (isPunct(tokens.at(-1), ';')) tokens.pop()
    const { generated, checks } = tableSemantics(tokens, columns.map(c => ({ name: c.name, type: c.type })))
    const indexes = db.prepare(`PRAGMA index_list(${q(String(row.name))})`).all().map(index => {
      if (!['c', 'u', 'pk'].includes(String(index.origin))) unsupportedSchema()
      return {
        // Autoindex numbers depend on constraint declaration order.
        name: index.origin === 'c' ? index.name : null, origin: index.origin, unique: index.unique, partial: index.partial,
        columns: db.prepare(`PRAGMA index_xinfo(${q(String(index.name))})`).all().map(({ cid, ...c }) => ({ ...c, ...(Number(cid) < 0 ? { cid } : {}) })),
      }
    })
    const foreignKeys = new Map<unknown, Record<string, unknown>[]>()
    for (const { id, ...fk } of db.prepare(`PRAGMA foreign_key_list(${q(String(row.name))})`).all()) {
      const group = foreignKeys.get(id) ?? []
      group.push(fk); foreignKeys.set(id, group)
    }
    return { ...base, checks, generated, withoutRowid: table.wr, strict: table.strict,
      columns: sorted(columns.map(({ cid: _cid, ...c }) => ({ ...c, type: canonicalType(String(c.type)),
        // A quoted DEFAULT is a literal even when it spells CURRENT_TIME.
        dflt_value: c.dflt_value === null ? null : sqlFingerprint(String(c.dflt_value)) }))),
      indexes: sorted(indexes), foreignKeys: sorted([...foreignKeys.values()]),
    }
  })
}
export async function instanceMeta(bundle: Bundle, supportedVersion: string | null = CORE_VERSION) {
  return replayBundle(bundle, db => {
    const meta = readInstanceMeta(db)
    const version = String(meta?.core_version ?? '').match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
    const current = (supportedVersion ?? CORE_VERSION).split('.').map(Number)
    // Normal config operations accept older SDK baselines, never future stamps.
    // SDK execution passes null and checks its own forward, same-major target;
    // publication passes the verified target ceiling and also checks equality.
    const supported = version && version[0] === current[0] &&
      (supportedVersion === null || version[1] < current[1] || (version[1] === current[1] && version[2] <= current[2]))
    if (!meta || meta.revision !== bundle.config.revision || !supported) fail('revision_mismatch', 'Config and committed migrations disagree', 409)
    return { revision: Number(meta.revision), core_version: String(meta.core_version), source: 'offline replay of committed migrations; no live database read' }
  })
}
export async function expectedSnapshot(bundle: Bundle, prepared: { target: Bundle['config']; indexes: Bundle['indexes']; sql: string }) {
  const planned = await replayBundle({ ...bundle, config: prepared.target, currentConfig: bundle.config, migrations: [...bundle.migrations, { name: 'proposal.sql', sql: prepared.sql, syntheticRevision: prepared.target.revision }] }, db => snapshot(db, usesBaseline(bundle.config)), { mode: 'synthetic' })
  const desired = await replayBundle({ config: prepared.target, currentConfig: bundle.config, runtime: bundle.runtime, migrations: [{ name: 'desired.sql', syntheticRevision: prepared.target.revision, sql: initialSchema(prepared.target) + prepared.indexes.map(indexSQL).join('\n') }] }, db => snapshot(db, usesBaseline(prepared.target)), { mode: 'schema' })
  if (JSON.stringify(planned) !== JSON.stringify(desired)) fail('config_schema_mismatch', 'Planned schema differs from resulting config')
  return planned
}
