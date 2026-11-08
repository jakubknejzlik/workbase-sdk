import { DatabaseSync } from 'node:sqlite'
import type { Bundle, Migration } from './storage.ts'
import { CORE_VERSION } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { fail } from './schemas.ts'
import { indexSQL, migrationBlockReason } from './planning.ts'

// Only server-generated SQL and checked-in instance migrations enter this offline database.
export function replay<T>(migrations: Migration[], fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(':memory:')
  try { for (const m of migrations) db.exec(m.sql); return fn(db) }
  catch (error) {
    const reason = migrationBlockReason(error)
    if (reason) fail('migration_blocked', reason)
    throw error
  } finally { db.close() }
}
const q = (name: string) => `"${name.replaceAll('"', '""')}"`
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/('(?:''|[^'])*')|"(?:""|[^"])*"|\s+/g, match => /^\s/.test(match) ? ' ' : match)
export function snapshot(db: DatabaseSync) {
  const master = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations' AND tbl_name != 'd1_migrations' ORDER BY type,name").all()
  return master.map(row => ({
    type: row.type, name: row.name, table: row.tbl_name, sql: normalize(String(row.sql)),
    // Column/FK/index metadata is stable across SQLite's ALTER formatting changes.
    ...(row.type === 'table' ? {
      columns: db.prepare(`PRAGMA table_info(${q(String(row.name))})`).all().map(({ cid: _cid, ...c }) => c),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${q(String(row.name))})`).all(),
    } : { columns: db.prepare(`PRAGMA index_info(${q(String(row.name))})`).all().map(({ cid: _cid, ...c }) => c) }),
  }))
}
export function instanceMeta(bundle: Bundle) {
  return replay(bundle.migrations, db => {
    const meta = db.prepare('SELECT revision, core_version FROM instance_meta ORDER BY revision DESC LIMIT 1').get()
    const version = String(meta?.core_version ?? '').match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
    const current = CORE_VERSION.split('.').map(Number)
    // Allow an older SDK baseline so a normal planned revision can upgrade it.
    // Future/foreign versions and revision drift still fail closed.
    const supported = version && version[0] === current[0] &&
      (version[1] < current[1] || (version[1] === current[1] && version[2] <= current[2]))
    if (!meta || meta.revision !== bundle.config.revision || !supported) fail('revision_mismatch', 'Config and committed migrations disagree', 409)
    return { revision: Number(meta.revision), core_version: String(meta.core_version), source: 'offline replay of committed migrations; no live database read' }
  })
}
export function expectedSnapshot(bundle: Bundle, prepared: { target: Bundle['config']; indexes: Bundle['indexes']; sql: string }) {
  const planned = replay([...bundle.migrations, { name: 'proposal.sql', sql: prepared.sql }], snapshot)
  const desired = replay([{ name: 'desired.sql', sql: initialSchema(prepared.target) + prepared.indexes.map(indexSQL).join('\n') }], snapshot)
  // Compare logical config semantics without column ordinals or SQLite-assigned FK IDs.
  const logical = (rows: ReturnType<typeof snapshot>) => rows.map(({ sql, ...r }) => ({ ...r,
    ...(r.type === 'index' ? { sql: sql.replaceAll('"', '').replace(/\s+/g, '') } : {}),
    columns: [...r.columns].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    ...('foreignKeys' in r ? { foreignKeys: r.foreignKeys!.map(({ id: _id, ...fk }) => fk)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
  }))
  const canonical = (rows: ReturnType<typeof snapshot>) => JSON.stringify(logical(rows))
  if (canonical(planned) !== canonical(desired)) fail('config_schema_mismatch', 'Planned schema differs from resulting config')
  return planned
}
