import { DatabaseSync } from 'node:sqlite'
import type { Bundle, Migration } from './storage.ts'
import { CORE_VERSION } from '@workbasehq/core/config'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { PluginMigrationError, PluginMigrationHistoryError } from '@workbasehq/core/kernel/migrations'
import { migrateD1, migrateInstance, instanceMigrationReceipt, migrationErrorMessage, queryDatabase } from '@workbasehq/core/infra'
import { replayInstance, replayError, readInstanceMeta, usesBaseline, MigrationReplayError, privateReplayMessage, sqliteKind, type ReplayMigration } from './migration-replay.ts'
import { initialSchema, revisionSQL } from '@workbasehq/core/migrations/schema'
import { fail, WorkflowError } from './schemas.ts'
import { indexSQL, rebuildBlock, rebuildBlockMessage } from './planning.ts'

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
const engineDiagnostics = { PluginMigrationError, PluginMigrationHistoryError, migrationErrorMessage }
export function replayEngine(config: Bundle['config'], runtime?: Bundle['runtime']) {
  try {
    return { kernel: new KernelRegistry(runtime ? { ...runtime, ...config, plugins: runtime.plugins, interactive: runtime.interactive } : config),
      migrateD1, migrateInstance, instanceMigrationReceipt, queryDatabase, revisionSQL, ...engineDiagnostics }
  } catch (error) { throw replayError(error, engineDiagnostics) }
}
export async function replayBundle<T>(bundle: Pick<Bundle, 'config' | 'runtime'> & { migrations: ReplayMigration[]; currentConfig?: Bundle['config'] }, fn: (db: DatabaseSync) => T, options: Parameters<typeof replayInstance>[3] = {}): Promise<T> {
  const entities = [...Object.keys(bundle.config.entities), ...Object.keys(bundle.currentConfig?.entities ?? {})]
  if (!usesBaseline(bundle.config)) return replay(bundle.migrations, fn, entities)
  const db = new DatabaseSync(':memory:')
  try {
    await replayInstance(db, bundle.migrations, replayEngine(bundle.config, bundle.runtime), options)
    return fn(db)
  } catch (error) {
    const block = rebuildBlock(privateReplayMessage(error), entities)
    if (block) fail('migration_blocked', rebuildBlockMessage(block))
    throw error
  } finally { db.close() }
}
const q = (name: string) => `"${name.replaceAll('"', '""')}"`
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/('(?:''|[^'])*')|"(?:""|[^"])*"|\s+/g, match => /^\s/.test(match) ? ' ' : match)
// Token boundaries and string literals matter; whitespace, comments, keyword
// case and identifier quoting do not. Do not strip quotes from literal values.
function sqlTokens(sql: string) {
  return (sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\p{L}_][\p{L}\p{N}_$]*|\d+(?:\.\d+)?(?:e[+-]?\d+)?|<>|!=|<=|>=|==|\|\||->>?|[^\s]/giu) ?? [])
    .filter(token => !token.startsWith('--') && !token.startsWith('/*'))
}
function canonicalToken(token: string) {
  if (token.startsWith("'")) return token
  const identifier = token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"')
    : token.startsWith('`') ? token.slice(1, -1).replaceAll('``', '`')
      : token.startsWith('[') ? token.slice(1, -1) : token
  // SQLite folds ASCII identifier case only.
  return identifier.replace(/[A-Z]/g, char => char.toLowerCase())
}
const canonicalSQL = (sql: string) => JSON.stringify(sqlTokens(sql.replace(/;\s*$/, '')).map(canonicalToken))
function canonicalCheck(tokens: string[]) {
  // Parentheses around the entire expression and literal IN-list order are inert.
  while (tokens[0] === '(' && tokens.at(-1) === ')') {
    let depth = 0
    if (tokens.some((token, i) => { depth += token === '(' ? 1 : token === ')' ? -1 : 0; return depth === 0 && i < tokens.length - 1 })) break
    tokens = tokens.slice(1, -1)
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'in' || tokens[i + 1] !== '(') continue
    let end = i + 2
    while (end < tokens.length && tokens[end] !== ')') end++
    const list = tokens.slice(i + 2, end)
    if (list.length % 2 === 1 && list.every((token, j) => j % 2 ? token === ',' : /^(?:'(?:''|[^'])*'|\d+(?:\.\d+)?)$/.test(token))) {
      tokens.splice(i + 2, list.length, ...list.filter((_, j) => j % 2 === 0).sort().flatMap((token, j) => j ? [',', token] : [token]))
    }
  }
  return JSON.stringify(tokens)
}
function checkConstraints(sql: string) {
  const tokens = sqlTokens(sql), checks: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() !== 'check' || tokens[i + 1] !== '(') continue
    const start = i + 2
    let depth = 1
    for (i = start; i < tokens.length; i++) {
      if (tokens[i] === '(') depth++
      if (tokens[i] === ')' && --depth === 0) break
    }
    checks.push(canonicalCheck(tokens.slice(start, i).map(canonicalToken)))
  }
  // CHECKs are a conjunction, independent of column/constraint declaration order.
  return checks.sort()
}
export function snapshot(db: DatabaseSync, domainLedger = false) {
  const master = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations' AND tbl_name != 'd1_migrations'" + (domainLedger ? " AND name != '_migrations' AND tbl_name != '_migrations'" : '') + ' ORDER BY type,name').all()
  return master.map(row => ({
    type: row.type, name: row.name, table: row.tbl_name, sql: row.type === 'trigger' ? canonicalSQL(String(row.sql)) : normalize(String(row.sql)),
    // Column/FK/index metadata is stable across SQLite's ALTER formatting changes.
    ...(row.type === 'table' ? {
      checks: checkConstraints(String(row.sql)),
      columns: db.prepare(`PRAGMA table_info(${q(String(row.name))})`).all().map(({ cid: _cid, ...c }) => c),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${q(String(row.name))})`).all(),
    } : row.type === 'index' ? { columns: db.prepare(`PRAGMA index_info(${q(String(row.name))})`).all().map(({ cid: _cid, ...c }) => c) } : {}),
  }))
}
export async function instanceMeta(bundle: Bundle, supportedVersion: string | null = CORE_VERSION, options: { verifySchema?: boolean } = {}) {
  const { meta, physical } = await replayBundle(bundle, db => {
    const meta = readInstanceMeta(db)
    const version = String(meta?.core_version ?? '').match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
    const current = (supportedVersion ?? CORE_VERSION).split('.').map(Number)
    // Normal config operations accept older SDK baselines, never future stamps.
    // SDK execution passes null and checks its own forward, same-major target;
    // publication passes the verified target ceiling and also checks equality.
    const supported = version && version[0] === current[0] &&
      (supportedVersion === null || version[1] < current[1] || (version[1] === current[1] && version[2] <= current[2]))
    if (!meta || meta.revision !== bundle.config.revision || !supported) fail('revision_mismatch', 'Config and committed migrations disagree', 409)
    return { meta: { revision: Number(meta.revision), core_version: String(meta.core_version), source: 'offline replay of committed migrations; no live database read' },
      physical: usesBaseline(bundle.config) && options.verifySchema !== false ? snapshot(db, true) : null }
  })
  if (physical) assertSnapshot(physical, await desiredSnapshot(bundle, { target: bundle.config, indexes: bundle.indexes }), 'Committed schema differs from configured schema')
  return meta
}
export async function expectedSnapshot(bundle: Bundle, prepared: { target: Bundle['config']; indexes: Bundle['indexes']; sql: string }) {
  const planned = await replayBundle({ ...bundle, config: prepared.target, currentConfig: bundle.config, migrations: [...bundle.migrations, { name: 'proposal.sql', sql: prepared.sql, syntheticRevision: prepared.target.revision }] }, db => snapshot(db, usesBaseline(bundle.config)), { mode: 'synthetic' })
  assertSnapshot(planned, await desiredSnapshot(bundle, prepared))
  return planned
}
function desiredSnapshot(bundle: Pick<Bundle, 'config' | 'runtime'>, prepared: { target: Bundle['config']; indexes: Bundle['indexes'] }) {
  return replayBundle({ config: prepared.target, currentConfig: bundle.config, runtime: bundle.runtime, migrations: [{ name: 'desired.sql', syntheticRevision: prepared.target.revision, sql: initialSchema(prepared.target) + prepared.indexes.map(indexSQL).join('\n') }] }, db => snapshot(db, usesBaseline(prepared.target)), { mode: 'schema' })
}
function assertSnapshot(planned: ReturnType<typeof snapshot>, desired: ReturnType<typeof snapshot>, message = 'Planned schema differs from resulting config') {
  // Compare logical config semantics without column ordinals or SQLite-assigned FK IDs.
  const logical = (rows: ReturnType<typeof snapshot>) => rows.map(({ sql, ...r }) => ({ ...r,
    ...(r.type === 'index' ? { sql: sql.replaceAll('"', '').replace(/\s+/g, '') } : {}),
    ...(r.type === 'trigger' ? { sql } : {}),
    ...('columns' in r ? { columns: [...r.columns!].sort((a, b) => String(a.name).localeCompare(String(b.name))) } : {}),
    ...('foreignKeys' in r ? { foreignKeys: r.foreignKeys!.map(({ id: _id, ...fk }) => fk)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
  }))
  const canonical = (rows: ReturnType<typeof snapshot>) => JSON.stringify(logical(rows))
  if (canonical(planned) !== canonical(desired)) throw new WorkflowError('config_schema_mismatch', message, 400,
    { phase: 'verification', hint: 'Review domain migrations against the bound schema lock and authored configuration.' })
}
