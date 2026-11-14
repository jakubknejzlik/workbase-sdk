import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { defineConfig, bindSchemaLock, defineAccess, accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { schemaLock } from '@workbasehq/core/migrations/schema-lock'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { migrateInstance } from '@workbasehq/core/infra'
import { MigrationDiagnostic } from '../../core/src/infra/diagnostics'
import { applyDisposable } from '../src/disposable'
import { expectedSnapshot, replay, replayBundle, replayEngine } from '../src/offline'
import { MigrationReplayError, replayError, replayInstance, replayQuery } from '../src/migration-replay'
import { prepare } from '../src/planning'
import { Store, configSource } from '../src/storage'
import { Workflow, errorResult } from '../src/workflow'
import { sdkWorkflowError } from '../src/sdk-upgrade'
import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanupTempDir(root) })
const config = (plugins: WorkbasePlugin[] = []) => {
  const current = defineConfig({ id: 'replay_fixture', interactive: false, languages: ['en'], roles: ['owner'], organizationOwnerRole: 'owner', entities: {}, plugins,
    access: defineAccess({ predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: 'deny' }])),
      roles: { owner: { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) } } }),
  })
  return bindSchemaLock(current, schemaLock(current))
}
const rejected = async (run: () => unknown) => {
  try { await run() } catch (error) { return error }
  throw new Error('Expected migration rejection')
}
const boundaries = (error: unknown) => {
  const sdk = sdkWorkflowError(error)
  // Error.message is non-enumerable; include it explicitly in the public proof.
  return [errorResult(error), { code: sdk.code, status: sdk.status, message: sdk.message, details: sdk.details }]
}
// Every longer shared substring contains a shared six-character window.
function assertPrivate(payload: string, results: unknown[]) {
  for (const result of results) {
    const publicValue = JSON.stringify(result)
    for (let i = 0; i <= payload.length - 6; i++) expect(publicValue).not.toContain(payload.slice(i, i + 6))
  }
}

it.each(['validate', 'preview_migration', 'apply_to_disposable', 'promote'])('verify1: %s rejects a target locale rejected by deploy checkSchema', async tool => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'verify1-'))); roots.push(root)
  const dir = join(root, 'examples/probe'), current = config()
  await mkdir(join(dir, 'migrations'), { recursive: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(dir, 'config.ts'), configSource(current))
  await writeFile(join(dir, 'runtime.ts'), `import config from './config.ts'; export default {...config, plugins: [{name: 'target_check', version: '1.0.0', async checkSchema(db, target) {if (target.locale === 'cs') await db.prepare('SELECT * FROM required_after_change').all()}}]};`)
  await writeFile(join(dir, 'migrations/0001_r1.sql'), initialSchema(current))
  const store = new Store(root, new Set(['probe'])); await store.init()
  const workflow = new Workflow(store), bundle = await store.load('probe')
  const planned = prepare(bundle.config, [], [{ kind: 'set_locale', locale: 'cs' }])
  const migrations = [...bundle.migrations, { name: '0002_r2.sql', sql: planned.sql }]
  const engine = replayEngine(planned.target, bundle.runtime), db = new DatabaseSync(':memory:')
  let deployError: unknown
  try { deployError = await rejected(() => migrateInstance(replayQuery(db, migrations), migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') })), engine.kernel)) }
  finally { db.close() }
  const deployCode = (replayError(deployError, engine) as { code: string }).code
  expect(deployCode).toBe('migration_replay_failed')
  const proposal = await workflow.call('propose_change', { instance: 'probe', baseRevision: 1, changes: [{ kind: 'set_locale', locale: 'cs' }] })
  if (tool === 'apply_to_disposable' || tool === 'promote') await workflow.call('validate', { proposalId: proposal.proposalId })
  if (tool === 'promote') await workflow.call('apply_to_disposable', { proposalId: proposal.proposalId })
  const result = await workflow.call(tool, { proposalId: proposal.proposalId, ...(tool === 'promote' ? { expectedRevision: 1 } : {}) })
  expect(result).toMatchObject(tool === 'validate' ? { ok: false, errors: [{ code: deployCode }] } : { ok: false, error: { code: deployCode } })
  expect((await store.load('probe')).config.revision).toBe(1)
})

it('verify1: direct disposable replay runs target checkSchema before spawning Wrangler', async () => {
  const current = config([{ name: 'target_check', version: '1.0.0', checkSchema: async (db, target) => {
    if ((target as { locale?: string }).locale === 'cs') await db.prepare('SELECT * FROM required_after_change').all()
  } }])
  const bundle = { config: current, runtime: current, migrations: [{ name: '0001_r1.sql', sql: initialSchema(current) }], indexes: [], fingerprint: '', guards: {} }
  const planned = prepare(current, [], [{ kind: 'set_locale', locale: 'cs' }])
  const result = await applyDisposable(bundle, planned, [], false)
  expect(result).toMatchObject({ verified: false, diffs: [{ code: 'migration_replay_failed' }] })
  await expect(expectedSnapshot(bundle, planned)).rejects.toMatchObject({ code: 'migration_replay_failed' })
})

it("verify1: callback RAISE(FAIL,'UNIQUE constraint failed: SYNTHETIC_PRIVATE_TEXT') stays private", async () => {
  const marker = 'SYNTHETIC_PRIVATE_TEXT'
  const current = config([{ name: 'callback', version: '1.0.0', migrations: [{ name: 'callback', sql: '', statements: async () => [
    `CREATE TABLE input (id INT); CREATE TRIGGER failure BEFORE INSERT ON input BEGIN SELECT RAISE(FAIL,'UNIQUE constraint failed: ${marker}'); END; INSERT INTO input VALUES(1);`,
  ] }] }])
  const error = await rejected(() => replayBundle({ config: current, migrations: [] }, () => {}))
  assertPrivate(marker, boundaries(error))
})

it('verify1: six-character payload windows stay private across replay error paths', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (let seed = 0; seed < 4; seed++) {
    const payload = 'z' + createHash('sha256').update(`verify1:${seed}`).digest('hex')
    const sqls = [
      `SELECT * FROM ${payload};`, `SELECT ${payload} FROM instance_meta;`, `${payload};`,
      `CREATE TABLE input (id UNIQUE); INSERT INTO input VALUES('${payload}'),('${payload}');`,
      `CREATE TABLE input (id UNIQUE); INSERT INTO input VALUES('${payload}'); INSERT OR ROLLBACK INTO input VALUES('${payload}');`,
      `PRAGMA foreign_keys=ON; CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE input(id CONSTRAINT ${payload} REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO input VALUES(1);`,
      `CREATE TABLE input (id NOT NULL); INSERT INTO input DEFAULT VALUES; -- ${payload}`,
      `CREATE TABLE input (id CONSTRAINT ${payload} CHECK(id>0)); INSERT INTO input VALUES(0);`,
      ...['', 'UNIQUE constraint failed: ', 'no such table: ', 'rebuild_requires_review_'].map(prefix =>
        `CREATE TABLE input(id); CREATE TRIGGER failure BEFORE INSERT ON input BEGIN SELECT RAISE(FAIL,'${prefix}${payload}'); END; INSERT INTO input VALUES(1);`),
    ]
    for (const sql of sqls) {
      const migrations = [{ name: '0001_r1.sql', sql }]
      const domain = await rejected(() => replayBundle({ config: config(), migrations }, () => {}))
      const plugin = await rejected(() => replayBundle({ config: config([{ name: 'callback', version: '1.0.0', migrations: [{ name: 'callback', sql: '', statements: async () => [sql] }] }]), migrations: [] }, () => {}))
      const legacy = await rejected(() => replay(migrations, () => {}))
      const db = new DatabaseSync(':memory:')
      try {
        const inline = await rejected(() => replayInstance(db, migrations, replayEngine(defineInstance({ id: 'inline_fixture', revision: 1, entities: {}, roles: ['owner'], permissions: {} }))))
        assertPrivate(payload, [...boundaries(domain), ...boundaries(plugin), ...boundaries(legacy), ...boundaries(inline)])
      } finally { db.close() }
    }
    for (const phase of ['statements', 'checkSchema'] as const) {
      for (const forged of [false, true, 'diagnostic', 'engineDiagnostic']) {
        const callback = () => {
          if (forged === 'engineDiagnostic') throw new MigrationDiagnostic({ code: 'migration_history_mismatch', filename: `0001_${payload}.sql` })
          if (forged === 'diagnostic') {
            const diagnostic = { file: payload, migration: payload, kind: 'sql' as const, sqlError: payload }
            throw new MigrationReplayError(diagnostic)
          }
          throw Object.assign(new Error(payload), forged ? { code: 'ERR_SQLITE_ERROR', errcode: 2067 } : {})
        }
        const plugin: WorkbasePlugin = { name: 'callback', version: '1.0.0', ...(phase === 'checkSchema' ? { checkSchema: callback } : { migrations: [{ name: 'callback', sql: '', statements: callback }] }) }
        const error = await rejected(() => replayBundle({ config: config([plugin]), migrations: [{ name: '0001_r1.sql', sql: 'SELECT 1;' }] }, () => {}))
        assertPrivate(payload, boundaries(error))
      }
    }
    const schemaError = await rejected(() => replayBundle({ config: config([{ name: 'callback', version: '1.0.0', checkSchema: async db => { await db.prepare(`SELECT * FROM ${payload}`).all() } }]), migrations: [{ name: '0001_r1.sql', sql: 'SELECT 1;' }] }, () => {}))
    assertPrivate(payload, boundaries(schemaError))
  }
})

it('verify1: structured replay kinds ignore injected diagnostic text at both public boundaries', () => {
  const payload = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT'
  const diagnostic = { file: 'migrations/0001_r1.sql', migration: '0001_r1.sql', kind: 'sql' as const, sqlError: payload }
  const error = new MigrationReplayError(diagnostic)
  assertPrivate(payload, boundaries(error))
  expect(error.diagnostic.sqlError).toBe('SQLite SQL logic error')
})

it.each(['instance', 'proposal'])('verify1: native metadata read errors stay private during %s validation', async mode => {
  for (let seed = 0; seed < 4; seed++) {
    const payload = 'z' + createHash('sha256').update(`verify1:metadata:${seed}`).digest('hex')
    const root = registerTempDir(await mkdtemp(join(tmpdir(), 'verify1-metadata-'))); roots.push(root)
    const dir = join(root, 'examples/probe')
    const current = defineInstance({ id: 'replay_fixture', revision: 1, interactive: false, roles: ['owner'], entities: {}, permissions: {} })
    await mkdir(join(dir, 'migrations'), { recursive: true })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(dir, 'config.ts'), configSource(current))
    await writeFile(join(dir, 'migrations/0001_initial.sql'), initialSchema(current) + `\nDROP TABLE instance_meta; CREATE VIEW instance_meta AS SELECT * FROM ${payload};`)
    const store = new Store(root, new Set(['probe'])); await store.init()
    const workflow = new Workflow(store)
    const proposal = mode === 'proposal' ? await workflow.call('propose_change', { instance: 'probe', baseRevision: 1, changes: [{ kind: 'set_locale', locale: 'en' }] }) : undefined
    const result = await workflow.call('validate', proposal ? { proposalId: proposal.proposalId } : { instance: 'probe' })
    expect(result).toMatchObject({ ok: false })
    assertPrivate(payload, [result])
  }
})

it('verify1: callback-authored engine diagnostics cannot publish formatted data', async () => {
  const payload = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT'
  const current = config([{ name: 'callback', version: '1.0.0', migrations: [{ name: 'callback', sql: '', statements: async () => {
    throw new MigrationDiagnostic({ code: 'migration_history_mismatch', filename: `0001_${payload}.sql` })
  } }] }])
  const error = await rejected(() => replayBundle({ config: current, migrations: [] }, () => {}))
  expect(error).toMatchObject({ code: 'migration_history_mismatch' })
  assertPrivate(payload, boundaries(error))
})

it('verify1: checks the proposed deployment once against committed data, keeping desired construction synthetic', async () => {
  const checked: number[] = []
  const current = config([{ name: 'target_check', version: '1.0.0', migrations: [{ name: 'state', sql: 'CREATE TABLE plugin_state (ready INTEGER);' }], checkSchema: async (db, target) => {
    if ((target as { locale?: string }).locale === 'cs') {
      const row = await db.prepare('SELECT ready FROM plugin_state').first<{ ready: number }>()
      if (!row) throw new Error('Expected committed plugin state')
      checked.push(row.ready)
    }
  } }])
  const bundle = { config: current, runtime: current, migrations: [{ name: '0001_r1.sql', sql: initialSchema(current) + '\nINSERT INTO plugin_state VALUES(1);' }], indexes: [], fingerprint: '', guards: {} }
  const planned = prepare(current, [], [{ kind: 'set_locale', locale: 'cs' }])
  await expectedSnapshot(bundle, planned)
  expect(checked).toEqual([1])
})
