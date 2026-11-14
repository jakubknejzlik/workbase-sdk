import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { CORE_VERSION, defineInstance } from '@workbasehq/core/config'
import { defineConfig, bindSchemaLock, defineAccess, accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { schemaLock } from '@workbasehq/core/migrations/schema-lock'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import * as baseline from '../../core/src/migrations/sdk-baseline'
import { instanceMeta, replay, replayBundle, replayEngine, snapshot } from '../src/offline'
import { MigrationReplayError, readInstanceMeta, replayInstance } from '../src/migration-replay'
import { sdkWorkflowError } from '../src/sdk-upgrade'

afterEach(() => vi.restoreAllMocks())
const config = (plugins: WorkbasePlugin[] = []) => {
  const current = defineConfig({ id: 'replay_fixture', interactive: false, languages: ['en'], roles: ['owner'], organizationOwnerRole: 'owner', entities: {}, plugins,
    access: defineAccess({ predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: 'deny' }])),
      roles: { owner: { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) } } }),
  })
  return bindSchemaLock(current, schemaLock(current))
}

it('replays SDK, ordered plugin baselines and domain receipts in deploy order', async () => {
  const current = config([
    { name: 'first', version: '1.0.0', migrations: [{ name: '001_first', sql: 'PRAGMA defer_foreign_keys = ON; CREATE TABLE first AS SELECT revision FROM instance_meta;' }] },
    { name: 'second', version: '1.0.0', migrations: [{ name: '001_second', sql: 'SELECT 1; CREATE TABLE second AS SELECT revision FROM first;' }] },
  ])
  const migrations = [{ name: '0001_r1.sql', sql: 'SELECT 1; INSERT INTO second VALUES (7);' }]
  const actual = await replayBundle({ config: current, migrations }, db => ({
    meta: readInstanceMeta(db), data: db.prepare('SELECT revision FROM second').all(),
    plugins: db.prepare('SELECT namespace,name FROM _plugin_migrations ORDER BY rowid').all(),
  }))
  expect(actual.meta).toMatchObject({ revision: 1, core_version: CORE_VERSION })
  expect(actual.data).toEqual([{ revision: 7 }])
  expect(actual.plugins.map(row => row.namespace)).toEqual(['workbase-sdk', 'first', 'second'])
})

it('preserves legacy schema, metadata and input SQL bytes without replaying plugin baselines', async () => {
  const current = defineInstance({ id: 'legacy_fixture', revision: 1, interactive: false, roles: ['owner'], entities: {}, permissions: {},
    plugins: [{ name: 'unused', version: '1.0.0', migrations: [{ name: 'must_not_run', sql: 'BROKEN SQL;' }] }] })
  const migrations = [{ name: '0001_initial.sql', sql: initialSchema(current).replaceAll(CORE_VERSION, '0.1.0') }]
  const before = JSON.stringify(migrations)
  const inspect = (db: DatabaseSync) => ({ schema: snapshot(db), meta: readInstanceMeta(db) })
  expect(await replayBundle({ config: current, migrations }, inspect)).toEqual(replay(migrations, inspect))
  expect(await instanceMeta({ config: current, migrations, indexes: [], fingerprint: '', guards: {} })).toMatchObject({ revision: 1, core_version: '0.1.0' })
  expect(JSON.stringify(migrations)).toBe(before)
})

it('reports a broken SDK baseline with its namespace, name, source file and SQLite error', async () => {
  vi.spyOn(baseline, 'sdkMigrations').mockReturnValue([{ name: '001_system', sql: 'BROKEN BASELINE;' }])
  await expect(replayBundle({ config: config(), migrations: [] }, readInstanceMeta)).rejects.toMatchObject({
    code: 'migration_replay_failed', message: expect.stringMatching(/workbase-sdk\/001_system.*sdk-baseline\.ts.*syntax error/),
  })
})
it.each(['BEGIN;', 'CREATE TRIGGER broken AFTER INSERT ON users BEGIN'])('names a plugin baseline rejected before SQL execution: %s', async sql => {
  const current = config([{ name: 'example', version: '1.0.0', migrations: [{ name: '001_example', sql }] }])
  await expect(replayBundle({ config: current, migrations: [] }, readInstanceMeta)).rejects.toMatchObject({
    code: 'migration_replay_failed', diagnostic: { migration: 'example/001_example', file: '@workbasehq/plugins/example',
      sqlError: expect.stringMatching(/transaction control|Unterminated/) },
  })
})

it.each(['plugin', 'instance'] as const)('reports a broken %s migration and retains actionable SDK workflow diagnostics', async kind => {
  const current = config(kind === 'plugin' ? [{ name: 'example', version: '1.0.0', migrations: [{ name: '001_example', sql: 'SELECT * FROM missing_source;' }] }] : [])
  const migrations = [{ name: '0001_r1.sql', sql: kind === 'instance' ? 'SELECT * FROM missing_source;' : 'SELECT 1;' }]
  const db = new DatabaseSync(':memory:')
  try {
    await expect(replayInstance(db, migrations, replayEngine(current))).rejects.toMatchObject({
      code: 'migration_replay_failed', diagnostic: {
        migration: kind === 'plugin' ? 'example/001_example' : '0001_r1.sql',
        file: kind === 'plugin' ? '@workbasehq/plugins/example' : 'migrations/0001_r1.sql',
        sqlError: 'no such table: missing_source',
      },
    })
    try { await replayInstance(db, migrations, replayEngine(current)) }
    catch (error) {
      expect(error).toBeInstanceOf(MigrationReplayError)
      expect(sdkWorkflowError(error)).toMatchObject({ code: 'migration_replay_failed', message: expect.stringContaining('missing_source'), status: 422 })
    }
  } finally { db.close() }
})
