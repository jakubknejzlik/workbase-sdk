import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { defineConfig, bindSchemaLock, defineAccess, accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { schemaLock } from '@workbasehq/core/migrations/schema-lock'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { migrateInstance } from '@workbasehq/core/infra'
import { replayBundle, replayEngine } from '../src/offline'
import { replaySources } from '../src/replay-sources'
import { replayQuery } from '../src/migration-replay'
import { Store, configSource } from '../src/storage'
import { Workflow } from '../src/workflow'
import { errorResult } from '../src/workflow'
import { sdkWorkflowError } from '../src/sdk-upgrade'
import { prepare } from '../src/planning'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { loadVersion, versionFiles, publishConfigVersion } from '../src/versions'
import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanupTempDir(root) })
const scratch = async () => { const root = registerTempDir(await mkdtemp(join(tmpdir(), 'review1-'))); roots.push(root); return root }
const config = (plugins: WorkbasePlugin[] = []) => {
  const current = defineConfig({ id: 'replay_fixture', interactive: false, languages: ['en'], roles: ['admin', 'staff'], organizationOwnerRole: 'admin', entities: {}, plugins,
    access: defineAccess({ predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: 'deny', staff: 'deny' }])),
      roles: Object.fromEntries(['admin', 'staff'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) }])) }),
  })
  return bindSchemaLock(current, schemaLock(current))
}
it.each(['0001_initial.sql', '0001_r9007199254740992.sql', '0002_sdk_upgrade.sql'])('rejects committed %s with the deploy diagnostic', async name => {
  const migrations = [{ name, sql: 'SELECT 1;' }], current = config()
  const db = new DatabaseSync(':memory:')
  try {
    const files = migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') }))
    await expect(migrateInstance(replayQuery(db, migrations), files, replayEngine(current).kernel)).rejects.toThrow('migration_instance_revision_mismatch')
    await expect(replayBundle({ config: current, migrations }, () => {})).rejects.toThrow('migration_instance_revision_mismatch')
  } finally { db.close() }
  const root = await scratch(), dir = join(root, 'examples/probe')
  await mkdir(join(dir, 'migrations'), { recursive: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(dir, 'config.ts'), configSource(current))
  await writeFile(join(dir, 'migrations', name), 'SELECT 1;')
  const store = new Store(root, new Set(['probe'])); await store.init()
  expect(await new Workflow(store).call('validate', { instance: 'probe' })).toMatchObject({ ok: false, errors: [{ code: 'migration_instance_revision_mismatch' }] })
})
it('runs deploy plugin schema checks during committed replay', async () => {
  const current = config([{ name: 'requires_table', version: '1.0.0', checkSchema: async db => { await db.prepare('SELECT * FROM required_plugin_table').all() } }])
  await expect(replayBundle({ config: current, migrations: [{ name: '0001_r1.sql', sql: 'SELECT 1;' }] }, () => {})).rejects.toThrow('required_plugin_table')
})
it.each([
  ['automatic rollback', 'CREATE TABLE conflicts (id INT PRIMARY KEY); INSERT INTO conflicts VALUES (1); INSERT OR ROLLBACK INTO conflicts VALUES (1);', 'UNIQUE constraint failed'],
  ['commit constraint', 'PRAGMA foreign_keys=ON; CREATE TABLE parent (id INT PRIMARY KEY); CREATE TABLE child (id INT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO child VALUES (1);', 'FOREIGN KEY constraint failed'],
])('preserves the original migration failure after %s', async (_kind, sql, message) => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON')
  try {
    const migrations = [{ name: '0001_r1.sql', sql }]
    await expect(replayQuery(db, migrations)(sql)).rejects.toMatchObject({ code: 'migration_replay_failed', diagnostic: { migration: '0001_r1.sql', sqlError: expect.stringContaining(message) } })
    expect(db.isTransaction).toBe(false)
  } finally { db.close() }
})
it('attributes shared-prefix SQL to the receipt filename and checksum', async () => {
  const migrations = [{ name: '0001_r1.sql', sql: 'SELECT 1;' }, { name: '0002_r2.sql', sql: 'SELECT 1;\n;\nSELECT * FROM actual_missing_domain;' }]
  await expect(replayBundle({ config: config(), migrations }, () => {})).rejects.toMatchObject({ diagnostic: { migration: '0002_r2.sql', file: 'migrations/0002_r2.sql', sqlError: 'no such table: actual_missing_domain' } })
})
it('keeps callback messages private at both public boundaries', async () => {
  const marker = 'SYNTHETIC_PRIVATE_PLUGIN_MESSAGE'
  const current = config([{ name: 'callback', version: '1.0.0', migrations: [{ name: 'callback', sql: '', statements: () => { throw new Error(marker) } }] }])
  try { await replayBundle({ config: current, migrations: [] }, () => {}); throw new Error('expected failure') }
  catch (error) {
    expect(JSON.stringify(errorResult(error))).not.toContain(marker)
    expect(JSON.stringify(sdkWorkflowError(error))).not.toContain(marker)
  }
})
it('writes successive V3 history and hydrates exact authored roles', async () => {
  const root = await scratch(), one = config(), two = defineInstance({ ...one, revision: 2 }), three = defineInstance({ ...one, revision: 3 })
  for (const file of await versionFiles(root, one, two)) await writeFile(join(root, file.path), file.data)
  for (const file of await versionFiles(root, two, three)) await writeFile(join(root, file.path), file.data)
  expect((await loadVersion(root, 2)).roles).toEqual(['admin', 'staff'])
})
it.each(['node', 'bun'])('reloads simultaneous config and schema changes twice in %s', async runtime => {
  const root = await scratch()
  await mkdir(join(root, 'examples/probe/schema'), { recursive: true }); await mkdir(join(root, 'examples/probe/migrations'))
  const output = execFileSync(runtime, [...(runtime === 'node' ? ['--import', 'tsx'] : []), resolve('packages/mcp/test/fixtures/review1-cache.ts'), root], { encoding: 'utf8' })
  const results = JSON.parse(output)
  expect(results.map((b: { fields: string[] }) => b.fields)).toEqual([['name', 'third'], ['name', 'third']])
  expect(results.map((b: { runtime: string[] }) => b.runtime)).toEqual([['name', 'third'], ['name', 'third']])
  expect(results[0].fingerprint).toBe(results[1].fingerprint)
})

it('preserves commit-time constraint context even if rollback cleanup fails', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON')
  const sql = 'CREATE TABLE parent (id INT PRIMARY KEY); CREATE TABLE child (id INT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO child VALUES (1);'
  const exec = db.exec.bind(db)
  vi.spyOn(db, 'exec').mockImplementation(statement => { exec(statement); if (statement === 'ROLLBACK') throw new Error('CLEANUP_FAILURE') })
  try {
    await expect(replayQuery(db, [{ name: '0001_r1.sql', sql }])(sql)).rejects.toMatchObject({ code: 'migration_replay_failed', diagnostic: { migration: '0001_r1.sql', sqlError: 'FOREIGN KEY constraint failed' } })
    expect(db.isTransaction).toBe(false)
  } finally { db.close() }
})

it.each(['SELECT 1;', 'PRAGMA user_version=73;'])('executes all statements in bare %s batches', async prefix => {
  const db = new DatabaseSync(':memory:')
  try {
    await replayQuery(db)(prefix + ' CREATE TABLE complete_batch (id INT);')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='complete_batch'").get()).toEqual({ name: 'complete_batch' })
    expect((await replayQuery(db)("SELECT 'a;b' AS value;"))[0].results).toEqual([{ value: 'a;b' }])
  } finally { db.close() }
})
it('leaves a preexisting transaction owned by its caller', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('BEGIN')
  try { await expect(replayQuery(db)('SELECT 1')).rejects.toThrow('within a transaction'); expect(db.isTransaction).toBe(true) }
  finally { db.close() }
})
it('rejects linked replay inputs and nested schema directories', async () => {
  const root = await scratch(); await mkdir(join(root, 'schema')); await mkdir(join(root, 'outside'))
  const paths = ['runtime.ts', 'access.ts', 'schema.lock.json', 'schema/entity.ts']
  await writeFile(join(root, 'outside/target.ts'), '{}')
  for (const path of paths) await writeFile(join(root, path), '{}')
  expect(Object.keys(await replaySources(root)).sort()).toEqual([...paths].sort())
  for (const path of [...paths, 'schema/linked']) {
    await rm(join(root, path), { force: true })
    await symlink(join(root, path === 'schema/linked' ? 'outside' : 'outside/target.ts'), join(root, path))
    await expect(replaySources(root)).rejects.toMatchObject({ code: 'unsafe_path' })
    await rm(join(root, path)); if (path !== 'schema/linked') await writeFile(join(root, path), '{}')
  }
})
it('attributes a shared domain prefix inside a plugin batch to the plugin receipt', async () => {
  const current = config([{ name: 'actual_plugin', version: '1.0.0', migrations: [{ name: 'broken_plugin', sql: 'SELECT 1;\n;\nSELECT * FROM missing_plugin_table;' }] }])
  await expect(replayBundle({ config: current, migrations: [{ name: '0001_r1.sql', sql: 'SELECT 1;' }] }, () => {})).rejects.toMatchObject({ diagnostic: { migration: 'actual_plugin/broken_plugin', sqlError: 'no such table: missing_plugin_table' } })
})

it('redacts configured secrets and bounds vetted SQLite diagnostics', async () => {
  vi.stubEnv('REPLAY_SECRET', 'sqlite_private_marker')
  for (const table of ['sqlite_private_marker', 'a'.repeat(4096)]) {
    try { await replayBundle({ config: config(), migrations: [{ name: '0001_r1.sql', sql: `SELECT * FROM ${table};` }] }, () => {}); throw new Error('expected failure') }
    catch (error) {
      const response = errorResult(error)
      expect(JSON.stringify(response)).not.toContain('sqlite_private_marker')
      expect(response).toMatchObject({ error: { code: 'migration_replay_failed' } })
      const diagnostic = (error as { diagnostic: { sqlError: string } }).diagnostic
      expect(diagnostic.sqlError.length).toBeLessThanOrEqual(2048)
    }
  }
})

it('keeps V3 planned domain SQL free of engine-owned receipts', () => {
  const planned = prepare(config(), [], [{ kind: 'set_locale', locale: 'en' }])
  expect(planned.sql).not.toContain('INSERT INTO instance_meta')
})
it('publishes V3 config versions as domain files accepted by real deploy', async () => {
  const root = await scratch(), dir = join(root, 'examples/probe'), current = config()
  await mkdir(join(dir, 'migrations'), { recursive: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(dir, 'config.ts'), configSource(current))
  await writeFile(join(dir, 'migrations/0001_r1.sql'), initialSchema(current))
  const store = new Store(root, new Set(['probe'])); await store.init()
  const bundle = await store.load('probe'), planned = prepare(bundle.config, [], [{ kind: 'set_locale', locale: 'en' }])
  expect(await publishConfigVersion(store, 'probe', bundle, planned.target, planned.sql, 'set_locale')).toBe('0002_r2.sql')
  const published = await store.load('probe'), db = new DatabaseSync(':memory:')
  try {
    await migrateInstance(replayQuery(db, published.migrations), published.migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') })), replayEngine(published.config).kernel)
    expect(db.prepare('SELECT revision FROM instance_meta ORDER BY revision').all()).toEqual([{ revision: 1 }, { revision: 2 }])
  } finally { db.close() }
})
