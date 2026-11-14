import { sdkMigrations, SDK_NAMESPACE } from '../migrations/sdk-baseline'
import { assertResetEra, usesSdkBaseline, type MigrationConfig } from '../migrations/reset-era'
import { coreMigrations } from '../migrations/model-b'
import { internalMigrationMessage } from '../migrations/diagnostics'
import { sha256 } from '../crypto'
import type { WorkbasePlugin } from './plugin'
import type { InstanceConfig } from '../config'

/** Preserve the failing step even when statement generation fails before SQL. */
export class PluginMigrationError extends Error {
  constructor(readonly namespace: string, readonly migration: string, cause: unknown) {
    super(`Plugin migration ${namespace}/${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

/** Per-plugin append-only ledgers. Absent namespaces are retained on uninstall. */
export async function applyPluginMigrations(db: D1Database, plugins: readonly WorkbasePlugin[], config?: InstanceConfig) {
  const chain = ledgerPlugins(plugins, config)
  const exists = usesSdkBaseline(config) && await assertResetEra(db)
  if (!exists) await db.prepare('CREATE TABLE IF NOT EXISTS _plugin_migrations (namespace TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(namespace,name), UNIQUE(namespace,position))').run()
  for (const plugin of chain) {
    const migrations = plugin.migrations ?? []
    const { results: applied } = await db.prepare('SELECT name,position,checksum FROM _plugin_migrations WHERE namespace=? ORDER BY position').bind(plugin.name).all<{ name: string; position: number; checksum: string }>()
    const checksums = await Promise.all(migrations.map(m => sha256(m.sql)))
    for (const [position, row] of applied.entries()) {
      if (row.position !== position || migrations[position]?.name !== row.name) throw new Error(`Plugin migrations must be append-only: ${plugin.name}/${row.name}`)
      if (checksums[position] !== row.checksum) throw new Error(`Plugin migration changed: ${plugin.name}/${row.name}`)
    }
    for (let position = applied.length; position < migrations.length; position++) {
      const migration = migrations[position]
      // D1 batch is transactional. SQL is supplied as statements by trusted plugins.
      // exec supports multi-statement SQL but is not transactional with the ledger;
      // prepare/batch keeps DDL, data changes and their ledger entry atomic.
      try {
        const sql = migration.statements ? (await migration.statements(db)).flatMap(splitStatements) : splitStatements(migration.sql)
        const statements = sql.map(statement => db.prepare(statement))
        await db.batch([...statements, db.prepare('INSERT INTO _plugin_migrations (namespace,name,position,checksum) VALUES (?,?,?,?)').bind(plugin.name, migration.name, position, checksums[position])])
      } catch (error) {
        if (internalMigrationMessage(error)) throw error
        throw new PluginMigrationError(plugin.name, migration.name, error)
      }
    }
  }
}

/** Split SQL without treating semicolons in quoted strings/comments as boundaries. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let trigger = false; let bodyStatementStart = false; let words: string[] = []
  let start = 0; let depth = 0; let hasCode = false; let quote = ''; let lineComment = false; let blockComment = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1]
    if (lineComment) { if (c === '\n') lineComment = false; continue }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++ }; continue }
    if (quote) { if (c === quote) { if (next === quote) i++; else quote = '' }; continue }
    if (c === '-' && next === '-') { lineComment = true; i++; continue }
    if (c === '/' && next === '*') { blockComment = true; i++; continue }
    if (!/\s|;/.test(c)) hasCode = true
    if (c === "'" || c === '"' || c === '`' || c === '[') { quote = c === '[' ? ']' : c; continue }
    if (/[a-z_]/i.test(c)) {
      const word = /^[a-z_][a-z_0-9]*/i.exec(sql.slice(i))![0]
      words.push(word.toUpperCase())
      if (/^CREATE (?:TEMP(?:ORARY)? )?TRIGGER$/.test(words.join(' '))) trigger = true
      if (words.length === 1 && /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)$/i.test(word)) throw new Error('Plugin migration transaction control is forbidden')
      // A trigger closes only at the beginning of a body statement. END in
      // new.end, SELECT end or ORDER BY end is an identifier, even before ';'.
      if (/^CASE$/i.test(word)) depth++
      else if (trigger && depth === 0 && /^BEGIN$/i.test(word)) { depth++; bodyStatementStart = true; i += word.length - 1; continue }
      else if (/^END$/i.test(word) && (depth > (trigger ? 1 : 0) || (trigger && bodyStatementStart))) depth = Math.max(0, depth - 1)
      bodyStatementStart = false
      i += word.length - 1; continue
    }
    if (c === ';' && trigger && depth === 1) bodyStatementStart = true
    if (c === ';' && depth === 0) { const statement = sql.slice(start, i).trim(); if (statement && hasCode) statements.push(statement); start = i + 1; hasCode = false; trigger = false; words = [] }
  }
  if (depth !== 0) throw new Error('Unterminated plugin migration block')
  const last = sql.slice(start).trim(); if (last && hasCode) statements.push(last)
  return statements
}

export interface PluginMigrationRow { namespace: string; name: string; position: number; checksum: string }
export async function expectedPluginMigrations(plugins: readonly WorkbasePlugin[], config?: MigrationConfig): Promise<PluginMigrationRow[]> {
  const rows = await Promise.all(ledgerPlugins(plugins, config).flatMap(plugin => (plugin.migrations ?? []).map(async (migration, position) => ({ namespace: plugin.name, name: migration.name, position, checksum: await sha256(migration.sql) }))))
  return rows.sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : a.position - b.position)
}
export async function pluginMigrationStatus(db: D1Database, plugins: readonly WorkbasePlugin[], config: MigrationConfig) {
  for (const plugin of plugins) await plugin.checkSchema?.(db, config)
  const expected = await expectedPluginMigrations(plugins, config)
  const names = new Set(ledgerPlugins(plugins, config).map(plugin => plugin.name))
  const { results } = await db.prepare('SELECT namespace,name,position,checksum FROM _plugin_migrations ORDER BY namespace,position').all<PluginMigrationRow>()
  // Uninstalled namespaces remain on disk but cannot satisfy installed contracts.
  const applied = results.filter(row => names.has(row.namespace))
  const hash = (rows: PluginMigrationRow[]) => sha256(JSON.stringify(rows.map(({ namespace, name, position, checksum }) => ({ namespace, name, position, checksum }))))
  return { expected: await hash(expected), applied: await hash(applied) }
}

/** Reserved core namespace shares the same transaction and verification contract. */
function ledgerPlugins(plugins: readonly WorkbasePlugin[], config?: MigrationConfig): readonly WorkbasePlugin[] {
  for (const name of ['workbase-core', SDK_NAMESPACE]) if (plugins.some(plugin => plugin.name === name)) throw new Error(`Reserved migration namespace: ${name}`)
  const sdk = usesSdkBaseline(config)
    ? { name: SDK_NAMESPACE, version: '1.0.0', migrations: sdkMigrations() }
    : { name: 'workbase-core', version: '1.0.0', migrations: coreMigrations(config as InstanceConfig | undefined) }
  return [sdk, ...plugins]
}
