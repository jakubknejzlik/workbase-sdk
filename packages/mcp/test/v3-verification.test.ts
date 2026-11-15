import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { defineConfig, defineEntity, accountLink, bindSchemaLock, defineAccess, accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { schemaLock } from '@workbasehq/core/migrations/schema-lock'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { PluginMigrationError } from '@workbasehq/core/kernel/migrations'
import { expectedSnapshot, instanceMeta, replayBundle, replayEngine, snapshot } from '../src/offline'
import { replayInstance, replayError } from '../src/migration-replay'
import { errorResult } from '../src/workflow'
import { sdkWorkflowError } from '../src/sdk-upgrade'
import { applyDisposable } from '../src/disposable'
import { prepare } from '../src/planning'

const plugin: WorkbasePlugin = { name: 'verification_plugin', version: '1.0.0',
  migrations: [{ name: '001_refs', sql: 'CREATE TABLE plugin_refs (user_id TEXT REFERENCES users(id));' }],
  checkSchema: async db => { await db.prepare('SELECT user_id FROM plugin_refs').all() },
}
const config = (plugins = [plugin]) => {
  const current = defineConfig({ id: 'verification_fixture', interactive: false, languages: ['en'], roles: ['owner'], organizationOwnerRole: 'owner', plugins,
    entities: { worker: defineEntity({ fields: { name: { type: 'text', required: true }, active: { type: 'bool' }, state: { type: 'enum', values: ['open', 'closed'] }, user: accountLink() }, access: { owner: 'deny' } }) },
    access: defineAccess({ predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: 'deny' }])),
      roles: { owner: { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) } } }),
  })
  return bindSchemaLock(current, schemaLock(current))
}
const bundle = (current = config()) => ({ config: current, runtime: current, migrations: [{ name: '0001_r1.sql', sql: initialSchema(current) }], indexes: [], fingerprint: '', guards: {} })
const caught = async (run: () => unknown) => { try { await run() } catch (error) { return error }; throw new Error('Expected failure') }
afterEach(() => vi.restoreAllMocks())

it('keeps receipts stable on retry and reports domain and plugin checksum drift separately from physical schema', async () => {
  const current = bundle(), db = new DatabaseSync(':memory:')
  const engine = replayEngine(current.config, current.runtime)
  const receipts = () => ({ domain: db.prepare('SELECT * FROM _migrations').all(), plugins: db.prepare('SELECT * FROM _plugin_migrations').all(), meta: db.prepare('SELECT * FROM instance_meta').all() })
  try {
    await replayInstance(db, current.migrations, engine)
    const before = receipts(), physical = snapshot(db, true)
    await replayInstance(db, current.migrations, engine)
    expect(receipts()).toEqual(before)
    db.exec("UPDATE _migrations SET checksum='changed'")
    const domain = await caught(() => replayInstance(db, current.migrations, engine))
    expect(domain).toMatchObject({ code: 'migration_history_mismatch', diagnostic: { phase: 'verification', file: 'migrations/0001_r1.sql', migration: '0001_r1.sql', hint: expect.any(String) } })
    expect(snapshot(db, true)).toEqual(physical)
    db.prepare('UPDATE _migrations SET checksum=?').run(before.domain[0].checksum)
    db.exec("UPDATE _plugin_migrations SET checksum='changed' WHERE namespace='verification_plugin'")
    expect(await caught(() => replayInstance(db, current.migrations, engine))).toMatchObject({ code: 'migration_plugin_history_mismatch', diagnostic: { phase: 'verification', namespace: 'verification_plugin', hint: expect.any(String) } })
    expect(snapshot(db, true)).toEqual(physical)
  } finally { db.close() }
})

it('preserves typed revision diagnostics at replay, workflow and SDK boundaries', async () => {
  const current = bundle()
  current.migrations[0].name = '0001_r2.sql'
  const error = await caught(() => replayBundle(current, () => {}))
  expect(error).toMatchObject({ code: 'migration_instance_revision_mismatch', diagnostic: { phase: 'verification', hint: expect.any(String) } })
  expect(errorResult(error)).toMatchObject({ error: { code: 'migration_instance_revision_mismatch', details: { phase: 'verification' } } })
  expect(sdkWorkflowError(error)).toMatchObject({ code: 'migration_instance_revision_mismatch', details: { phase: 'verification' } })
})

it('reports an unbound V3 schema lock before constructing a kernel or replaying SQL', async () => {
  const current = bundle({ ...config(), revision: 0 })
  const error = await caught(() => replayBundle(current, () => { throw new Error('Must not reach inspection') }))
  expect(errorResult(error)).toMatchObject({ error: { code: 'schema_lock_not_bound', details: { phase: 'verification', hint: expect.any(String) } } })
})

it('retains a plugin schema failure code and safe source context without exposing callback text', async () => {
  const secret = 'PRIVATE_CALLBACK_MESSAGE'
  const current = bundle(config([{ ...plugin, checkSchema: () => { throw new Error(secret) } }]))
  const error = await caught(() => replayBundle(current, () => {}))
  expect(error).toMatchObject({ code: 'migration_plugin_verification_failed', diagnostic: { phase: 'verification', namespace: 'verification_plugin', migration: 'verification_plugin/checkSchema', sqlError: 'Plugin schema verification failed', hint: expect.any(String) } })
  for (const value of [errorResult(error), sdkWorkflowError(error)]) expect(JSON.stringify(value)).not.toContain(secret)
  const planned = prepare(current.config, [], [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }])
  expect(await applyDisposable(current, planned, [], false)).toMatchObject({ verified: false, diffs: [{ code: 'migration_plugin_verification_failed', details: { namespace: 'verification_plugin' } }] })
})

it('returns typed statement-generation diagnostics with bounded identifiers', async () => {
  const current = bundle(config([{ name: 'callback', version: '1.0.0', migrations: [{ name: '001_callback', sql: '', statements: () => { throw new Error('PRIVATE_CALLBACK_MESSAGE') } }] }]))
  const error = await caught(() => replayBundle(current, () => {}))
  expect(errorResult(error)).toMatchObject({ error: { code: 'migration_replay_failed', status: 422, details: { phase: 'plugin', hint: expect.any(String) } } })
  expect(JSON.stringify(errorResult(error))).not.toMatch(/PRIVATE_/)
  const malformed = replayError(new PluginMigrationError('../../PRIVATE_NAMESPACE\n', '../../PRIVATE_FILE\n', new Error('PRIVATE_CALLBACK_MESSAGE')), replayEngine(current.config))
  expect(JSON.stringify(errorResult(malformed))).not.toMatch(/PRIVATE_|\.\.\//)
})

it('builds replayed and fresh desired V3 schemas with the same SDK and plugin prerequisites', async () => {
  const current = bundle(), planned = prepare(current.config, [], [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }])
  const expected = await expectedSnapshot(current, planned)
  expect(expected.map(row => row.name)).toEqual(expect.arrayContaining(['users', 'plugin_refs', 'worker', '_plugin_migrations', 'instance_meta']))
  expect(await applyDisposable(current, planned, expected, false)).toMatchObject({ verified: true, diffs: [] })
})

it('rejects committed physical drift during V3 inspection as well as proposal verification', async () => {
  const current = bundle()
  current.migrations[0].sql += '\nCREATE TABLE unconfigured_table (id TEXT);'
  await expect(instanceMeta(current)).rejects.toMatchObject({ code: 'config_schema_mismatch' })
  const planned = prepare(current.config, [], [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }])
  await expect(expectedSnapshot(current, planned)).rejects.toMatchObject({ code: 'config_schema_mismatch' })
})

const schemaDrifts = [
  ['boolean CHECK', (sql: string) => sql.replace(' CHECK ("active" IN (0,1))', '')],
  ['changed boolean CHECK', (sql: string) => sql.replace('CHECK ("active" IN (0,1))', 'CHECK ("active" IN (0,2))')],
  ['enum CHECK', (sql: string) => sql.replace(/ CHECK \("state" IN \([^)]*\)\)/, '')],
  ['unexpected trigger', (sql: string) => sql + "\nCREATE TRIGGER reject_worker BEFORE INSERT ON worker BEGIN SELECT RAISE(ABORT, 'reject inserts'); END;"],
  ['trigger sharing a table name', (sql: string) => sql + "\nCREATE TRIGGER worker BEFORE INSERT ON worker BEGIN SELECT RAISE(ABORT, 'reject inserts'); END;"],
] as const
it.each(schemaDrifts)('rejects %s drift during inspection, planning and disposable verification', async (_name, drift) => {
  const current = bundle(), planned = prepare(current.config, [], [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }])
  const expected = await expectedSnapshot(current, planned)
  const original = current.migrations[0].sql
  current.migrations[0].sql = drift(original)
  expect(current.migrations[0].sql).not.toBe(original)
  const inspection = await caught(() => instanceMeta(current)).catch(error => error)
  const planning = await caught(() => expectedSnapshot(current, planned)).catch(error => error)
  // Use an independently generated desired schema, never the drifted replay.
  const disposable = await applyDisposable(current, planned, expected, false)
  expect.soft(inspection).toMatchObject({ code: 'config_schema_mismatch' })
  expect.soft(planning).toMatchObject({ code: 'config_schema_mismatch' })
  expect.soft(disposable.verified).toBe(false)
})

it('accepts harmless CHECK formatting, quoting and constraint order', async () => {
  const current = bundle()
  const original = current.migrations[0].sql
  current.migrations[0].sql = original
    .replace(' CHECK ("active" IN (0,1))', '')
    .replace(/ CHECK \("state" IN \([^)]*\)\)/, '')
    .replace(/(CREATE TABLE "worker" \([\s\S]*?)(\n\);)/, "$1,\n  CHECK ((state in ('closed', 'open'))),\n  check ( [active] in ( 1 , 0 ) )$2")
  expect(current.migrations[0].sql).not.toBe(original)
  await expect(instanceMeta(current)).resolves.toMatchObject({ revision: 1 })
  await expect(expectedSnapshot(current, prepare(current.config, [], [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }]))).resolves.toEqual(expect.any(Array))
})

it('compares trigger behavior while ignoring harmless SQL formatting', async () => {
  const current = bundle(config([{ ...plugin, migrations: [...plugin.migrations!, {
    name: '002_trigger', sql: "CREATE TRIGGER plugin_trigger BEFORE INSERT ON plugin_refs BEGIN -- retain the newline ending this comment\n SELECT RAISE(ABORT, 'blocked'); END;",
  }] }]))
  current.migrations[0].sql += "\nDROP TRIGGER plugin_trigger; create trigger [plugin_trigger] before insert on plugin_refs begin select raise ( ABORT , 'blocked' ) ; end;"
  await expect(instanceMeta(current)).resolves.toMatchObject({ revision: 1 })
  current.migrations[0].sql = current.migrations[0].sql.replace("'blocked'", "'different behavior'")
  await expect(instanceMeta(current)).rejects.toMatchObject({ code: 'config_schema_mismatch' })
})
