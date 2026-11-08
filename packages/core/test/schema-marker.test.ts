import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { CORE_VERSION, defineInstance } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { migrateD1, type D1Query } from '../src/infra/d1-migrations'
import { migrateInstance } from '../src/infra/instance-migrations'
import { sha256 } from '../src/crypto'
import { pluginMigrationStatus } from '../src/kernel/migrations'
import { hashMigrationRows, schemaStatus } from '../src/schema-compatibility'

beforeEach(reset)
const config = defineInstance({ id: 'schema_marker', revision: 3, interactive: false, roles: ['owner'], entities: {}, plugins: [
  { name: 'records', version: '1.0.0', migrations: [{ name: '001_records', sql: 'CREATE TABLE records (id TEXT PRIMARY KEY);' }] },
] })
const query: D1Query = async sql => {
  if (/^SELECT/.test(sql)) return [{ success: true, results: (await env.DB.prepare(sql).all()).results }]
  await env.DB.exec(sql.replaceAll('\n', ' '))
  return [{ success: true }]
}
async function fixture() {
  const sql = "CREATE TABLE instance_meta (revision INTEGER PRIMARY KEY, core_version TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO instance_meta VALUES (1, '0.1.0', '2000-01-01'), (3, '0.1.0', '2000-01-01');"
  const files = [{ filename: '0001_initial.sql', sql, checksum: await sha256(sql) }]
  const kernel = new KernelRegistry(config)
  await migrateD1(query, files)
  await kernel.applyMigrations(env.DB)
  const expected = { revision: config.revision, coreVersion: CORE_VERSION, migrations: await hashMigrationRows(files), pluginMigrations: (await pluginMigrationStatus(env.DB, kernel.plugins, config)).expected }
  const status = () => schemaStatus({ DB: env.DB, SCHEMA_EXPECTED: JSON.stringify(expected), STAGE: 'staging' }, config)
  const meta = () => env.DB.prepare('SELECT * FROM instance_meta ORDER BY revision').all()
  return { files, kernel, expected, status, meta }
}

it('refreshes a stale core version with matching revision and migration hashes, then writes nothing on retry', async () => {
  const { files, kernel, expected, status, meta } = await fixture()
  expect(await status()).toMatchObject({ compatible: false, applied: { ...expected, coreVersion: '0.1.0' } })
  const legacy = await env.DB.prepare('SELECT * FROM _migrations').all()
  const plugins = await env.DB.prepare('SELECT * FROM _plugin_migrations').all()
  // Count actual marker writes, including a redundant UPDATE on retry.
  await env.DB.exec('CREATE TABLE marker_writes (revision INTEGER); CREATE TRIGGER marker_updated AFTER UPDATE ON instance_meta BEGIN INSERT INTO marker_writes VALUES (NEW.revision); END;')
  expect(await migrateInstance(query, files, kernel)).toMatchObject({ applied: 0, total: 1, pluginMigrations: expected.pluginMigrations })
  expect(await status()).toEqual({ enabled: true, compatible: true, expected, applied: expected })
  const updated = await meta()
  expect(updated.results).toEqual([
    { revision: 1, core_version: '0.1.0', applied_at: '2000-01-01' },
    { revision: 3, core_version: CORE_VERSION, applied_at: expect.any(String) },
  ])
  expect(updated.results[1].applied_at).not.toBe('2000-01-01')
  expect(await migrateInstance(query, files, kernel)).toMatchObject({ applied: 0, total: 1 })
  expect((await meta()).results).toEqual(updated.results)
  expect((await env.DB.prepare('SELECT * FROM marker_writes').all()).results).toEqual([{ revision: 3 }])
  expect((await env.DB.prepare('SELECT * FROM _migrations').all()).results).toEqual(legacy.results)
  expect((await env.DB.prepare('SELECT * FROM _plugin_migrations').all()).results).toEqual(plugins.results)
})

it('does not stamp a version when plugin verification fails', async () => {
  const { files, kernel, meta } = await fixture()
  const before = await meta()
  await env.DB.prepare("UPDATE _plugin_migrations SET checksum='tampered'").run()
  await expect(migrateInstance(query, files, kernel)).rejects.toThrow('Plugin migration changed')
  expect((await meta()).results).toEqual(before.results)
})

it.each(['missing', 'older', 'newer'])('rejects a %s revision without stamping the core version', async kind => {
  const { files, kernel, meta } = await fixture()
  if (kind === 'missing') await env.DB.prepare('DELETE FROM instance_meta').run()
  else await env.DB.prepare('UPDATE instance_meta SET revision=? WHERE revision=3').bind(kind === 'older' ? 2 : 4).run()
  const before = await meta()
  await expect(migrateInstance(query, files, kernel)).rejects.toThrow('migration_instance_revision_mismatch')
  expect((await meta()).results).toEqual(before.results)
})
