import { DatabaseSync } from 'node:sqlite'
import type { Bundle, Migration } from './storage.ts'
import { CORE_VERSION } from '@workbasehq/core/config'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { PluginMigrationError, PluginMigrationHistoryError } from '@workbasehq/core/kernel/migrations'
import { migrateD1, migrateInstance, instanceMigrationReceipt, migrationErrorMessage, queryDatabase, validateMigrationFilenames } from '@workbasehq/core/infra'
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
      migrateD1, migrateInstance, instanceMigrationReceipt, queryDatabase, validateMigrationFilenames, revisionSQL, ...engineDiagnostics }
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
function unsupportedSchema(): never {
  throw new WorkflowError('config_schema_mismatch', 'Schema contains semantics unsupported by offline verification', 400,
    { phase: 'verification', hint: 'Use schema constructs covered by offline verification before retrying.' })
}
// PRAGMAs omit column collations, conflict policies, generated expressions and
// FK deferral. Retain generated SQL and reject clauses not otherwise covered.
// This is a consumption grammar: an unknown clause fails, even on both sides.
function assertRepresentableTable(sql: string, columns: { name: unknown; type: unknown }[]) {
  const raw = sqlTokens(sql.replace(/;\s*$/, '')), tokens = raw.map(canonicalToken)
  const generated: { name: string; expression: string }[] = []
  let at = 0
  const take = (token: string) => tokens[at] === token ? (++at, true) : false
  const need = (token: string) => { if (!take(token)) unsupportedSchema() }
  const identifier = () => { if (tokens[at] === undefined) unsupportedSchema(); at++ }
  const group = () => {
    const start = at
    need('(')
    let depth = 1
    while (depth && at < tokens.length) {
      const token = tokens[at++]
      depth += token === '(' ? 1 : token === ')' ? -1 : 0
    }
    if (depth) unsupportedSchema()
    return JSON.stringify(raw.slice(start, at))
  }
  const reference = () => {
    identifier()
    if (tokens[at] === '(') group()
    while (take('on')) {
      if (!take('delete') && !take('update')) unsupportedSchema()
      if (take('set')) { if (!take('null') && !take('default')) unsupportedSchema() }
      else if (take('no')) need('action')
      else if (!take('cascade') && !take('restrict')) unsupportedSchema()
    }
  }
  need('create'); need('table'); identifier(); need('(')
  do {
    if (take('constraint')) identifier()
    if (take('primary')) { need('key'); group() }
    else if (take('unique') || take('check')) group()
    else if (take('foreign')) { need('key'); group(); need('references'); reference() }
    else {
      const name = tokens[at++]
      const column = columns.find(c => canonicalToken(String(c.name)) === name)
      if (!column) unsupportedSchema()
      for (const token of sqlTokens(String(column.type)).map(canonicalToken)) need(token)
      while (tokens[at] !== ',' && tokens[at] !== ')' && at < tokens.length) {
        if (take('constraint')) identifier()
        else if (take('not')) need('null')
        else if (take('null') || take('unique')) { /* represented in column/index metadata */ }
        else if (take('primary')) { need('key'); take('asc') || take('desc') }
        else if (take('check')) group()
        else if (take('references')) reference()
        else if (tokens[at] === 'generated' || tokens[at] === 'as') {
          if (take('generated')) take('always')
          need('as')
          generated.push({ name, expression: group() })
          take('virtual') || take('stored')
        }
        else if (take('default')) {
          if (tokens[at] === '(') group()
          else {
            take('+') || take('-')
            if (tokens[at] === 'x' && raw[at + 1]?.startsWith("'")) at++
            identifier()
          }
        } else unsupportedSchema()
      }
    }
  } while (take(','))
  need(')')
  if (at < tokens.length) do {
    if (take('without')) need('rowid')
    else need('strict')
  } while (take(','))
  if (at !== tokens.length) unsupportedSchema()
  return sorted(generated)
}
const sorted = <T>(values: T[]) => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
export function snapshot(db: DatabaseSync, domainLedger = false) {
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
      return { ...base, sql: canonicalSQL(row.sql) }
    }
    if (row.type !== 'table' || typeof row.sql !== 'string') unsupportedSchema()
    const table = tables.find(t => t.schema === 'main' && t.name === row.name)
    if (table?.type !== 'table') unsupportedSchema()
    const columns = db.prepare(`PRAGMA table_xinfo(${q(String(row.name))})`).all()
    if (!columns.length || columns.some(c => ![0, 2, 3].includes(Number(c.hidden)))) unsupportedSchema()
    const generated = assertRepresentableTable(row.sql, columns.map(c => ({ name: c.name, type: c.type })))
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
    return { ...base, checks: checkConstraints(row.sql), generated, withoutRowid: table.wr, strict: table.strict,
      columns: sorted(columns.map(({ cid: _cid, ...c }) => ({ ...c, type: canonicalSQL(String(c.type)),
        // A quoted DEFAULT is a literal even when it spells CURRENT_TIME.
        dflt_value: c.dflt_value === null ? null : JSON.stringify(sqlTokens(String(c.dflt_value))) }))),
      indexes: sorted(indexes), foreignKeys: sorted([...foreignKeys.values()]),
    }
  })
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
  if (JSON.stringify(planned) !== JSON.stringify(desired)) throw new WorkflowError('config_schema_mismatch', message, 400,
    { phase: 'verification', hint: 'Review domain migrations against the bound schema lock and authored configuration.' })
}
