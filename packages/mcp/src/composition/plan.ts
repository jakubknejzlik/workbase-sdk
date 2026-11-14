import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { serializeAccessLock } from '@workbasehq/core/access/lock'
import { configSources } from '@workbasehq/core/schema/load'
import { expectedPluginMigrations, type PluginMigrationRow } from '@workbasehq/core/kernel/migrations'
import type { Bundle } from '../storage.ts'
import { noLink } from '../storage.ts'
import { fail } from '../schemas.ts'
import { replayBundle, replayEngine, snapshot } from '../offline.ts'
import { replayInstance } from '../migration-replay.ts'
import { compare, stateRoot } from '../disposable.ts'

export const pluginLedger = (db: DatabaseSync) => db.prepare('SELECT namespace,name,position,checksum FROM _plugin_migrations ORDER BY namespace,position').all().map(row => ({ namespace: String(row.namespace), name: String(row.name), position: Number(row.position), checksum: String(row.checksum) }))

/** Record the upgrade that deploy will execute, and independently replay fresh. */
export async function compositionPlan(base: Bundle, target: Bundle, source: string, root: string) {
  root = await realpath(root)
  const engine = replayEngine(target.config, target.runtime)
  const ledger = await expectedPluginMigrations(engine.kernel.plugins, engine.kernel.config)
  const expected = await replayBundle(target, db => ({ schema: snapshot(db, true), ledger: pluginLedger(db) }))
  const statements: { sql: string; name: string }[] = []
  const db = new DatabaseSync(':memory:')
  let applied: PluginMigrationRow[]
  let upgradeStart: number
  try {
    const record = (sql: string, context?: { migration: string }) => statements.push({ sql, name: (context?.migration ?? 'ledger').replace(/[^a-z0-9_]/gi, '_') })
    // Interactive routing has no migration effect. A proposal may repair an
    // interactive instance that currently has no login provider.
    await replayInstance(db, base.migrations, replayEngine(base.config, { ...base.runtime!, interactive: false }), { record })
    applied = pluginLedger(db)
    const before = snapshot(db, true)
    upgradeStart = statements.length
    await replayInstance(db, target.migrations, engine, { record })
    const after = snapshot(db, true)
    const domain = (rows: typeof before) => rows.filter(row => Object.hasOwn(base.config.entities, String(row.table)))
    if (compare(domain(before), domain(after)).length) fail('composition_touches_domain_table', 'Composition migrations must preserve domain tables', 422)
    if (compare(expected.schema, after).length || JSON.stringify(pluginLedger(db)) !== JSON.stringify(expected.ledger)
      || JSON.stringify(expected.ledger) !== JSON.stringify(ledger)) fail('composition_migration_divergence', 'Upgrade and fresh composition migrations differ', 422)
  } finally { db.close() }

  // Source metadata must describe the exact bytes being promoted. No consumer
  // module is evaluated; configSources reads this canonical object export.
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const scratch = await realpath(await mkdtemp(join(stateRoot, 'composition-')))
  let lock: string
  try {
    await writeFile(join(scratch, 'runtime.ts'), source)
    const sources = Object.fromEntries(Object.entries(configSources(join(scratch, 'runtime.ts')))
      .map(([key, location]) => [key, { ...location, file: join(root, relative(scratch, location.file)) }]))
    lock = serializeAccessLock(engine.kernel, { root, sources }).json
  } finally { await rm(scratch, { recursive: true, force: true }) }
  return {
    files: [{ path: 'runtime.ts', data: source }, { path: 'access.lock.json', data: lock }],
    expected: expected.schema, statements, ledger,
    pluginMigrations: ledger.map(row => ({ ...row, status: applied.some(previous => previous.namespace === row.namespace && previous.name === row.name) ? 'applied' : 'new' })),
    pluginSql: statements.slice(upgradeStart).map(statement => statement.sql).join('\n'),
  }
}
