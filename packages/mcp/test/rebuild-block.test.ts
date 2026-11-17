import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyDisposable } from '../src/disposable'
import { expectedSnapshot, replayBundle } from '../src/offline'
import { rebuildBlock, rebuildBlockMessage, prepare } from '../src/planning'
import { Store, configSource } from '../src/storage'
import { Workflow, errorResult } from '../src/workflow'
import { sdkWorkflowError } from '../src/sdk-upgrade'
import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { rebuildFixture, referenceChange, columnsBlock, genericBlock } from './fixtures/rebuild-block'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanupTempDir(root) })
it.each([false, true].flatMap(v3 => ['validate', 'preview_migration', 'apply_to_disposable'].map(tool => ({ v3, tool }))))('verify2: real rebuild refusal survives $tool (V3=$v3)', async ({ v3, tool }) => {
  const bundle = rebuildFixture(v3)
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'rebuild-block-'))); roots.push(root)
  const dir = join(root, 'examples/probe')
  await mkdir(join(dir, 'migrations'), { recursive: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(dir, 'config.ts'), configSource(bundle.config))
  await writeFile(join(dir, 'migrations', bundle.migrations[0].name), bundle.migrations[0].sql)
  const store = new Store(root, new Set(['probe'])); await store.init()
  const workflow = new Workflow(store)
  const proposal = await workflow.call('propose_change', { instance: 'probe', baseRevision: 1, changes: referenceChange })
  expect(proposal.ok).toBe(true)
  {
    const result = await workflow.call(tool, { proposalId: proposal.proposalId })
    expect(result, tool).toMatchObject(tool === 'validate'
      ? { ok: false, errors: [{ code: 'migration_blocked', message: columnsBlock }] }
      : { ok: false, error: { code: 'migration_blocked', status: 400, message: columnsBlock } })
  }
  expect((await store.load('probe')).config.revision).toBe(1)
})
it.each([false, true])('verify2: direct disposable preserves genuine rebuild refusal in diffs (V3=%s)', async v3 => {
  const bundle = rebuildFixture(v3), prepared = prepare(bundle.config, [], referenceChange)
  // Legacy executes the generated SQL through real Wrangler; V3 catches the
  // same guard while recording deployment SQL before spawning Wrangler.
  expect(await applyDisposable(bundle, prepared, [], false)).toEqual({ verified: false, diffs: [{ code: 'migration_blocked', message: columnsBlock }] })
})
it.each([false, true])('verify2: offline snapshot preserves rebuild refusal (V3=%s)', async v3 => {
  const bundle = rebuildFixture(v3), prepared = prepare(bundle.config, [], referenceChange)
  await expect(expectedSnapshot(bundle, prepared)).rejects.toMatchObject({ code: 'migration_blocked', status: 400, message: columnsBlock })
})
it.each(['rowid', 'columns', 'indexes', 'foreign_keys', 'inline_constraints', 'triggers', 'incoming_actions'])('classifies the complete allow-listed %s constraint token', part => {
  const block = rebuildBlock(`CHECK constraint failed: rebuild_requires_review_records_${part}`, ['records', 'records_foreign', 'records_inline', 'records_incoming'])
  expect(block).toEqual({ entity: 'records', part })
  expect(rebuildBlockMessage(block!)).toBe(`Rebuild blocked for records: physical ${part.replaceAll('_', ' ')} differs from the fresh configured schema; a manually reviewed migration is required`)
})
it('uses exact entity membership and complete constraint tokens', () => {
  for (const token of ['rebuild_requires_review', 'rebuild_requires_review_secret_customer_columns', 'rebuild_requires_review_records_columns_INJECTED', 'rebuild_requires_review_records_columns extra private text', 'rebuild_requires_review_records_unknown']) {
    const block = rebuildBlock(`CHECK constraint failed: ${token}`, ['records'])
    expect(block).toEqual({})
    expect(rebuildBlockMessage(block!)).toBe(genericBlock)
  }
  expect(rebuildBlock('prefix rebuild_requires_review_records_columns suffix', ['records'])).toBeUndefined()
  expect(rebuildBlock('CHECK constraint failed: other_rebuild_requires_review_records_columns', ['records'])).toBeUndefined()
})
it.each([false, true])('guard-like SQL names and RAISE text produce only the generic literal (V3=%s)', async v3 => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bundle = rebuildFixture(v3)
  for (const sql of [
    'CREATE TABLE input (id CONSTRAINT rebuild_requires_review_secret_customer_columns CHECK(id>0)); INSERT INTO input VALUES(0);',
    "CREATE TABLE input(id); CREATE TRIGGER failure BEFORE INSERT ON input BEGIN SELECT RAISE(FAIL,'rebuild_requires_review_records_columns INJECTED_PRIVATE_TEXT'); END; INSERT INTO input VALUES(1);",
    "CREATE TABLE input(id); CREATE TRIGGER failure BEFORE INSERT ON input BEGIN SELECT RAISE(FAIL,'CHECK constraint failed: rebuild_requires_review_records_columns INJECTED_PRIVATE_TEXT'); END; INSERT INTO input VALUES(1);",
    'CREATE TABLE input (id CONSTRAINT rebuild_requires_review CHECK(id>0)); INSERT INTO input VALUES(0);',
  ]) {
    let caught: unknown
    try { await replayBundle({ ...bundle, migrations: [{ name: bundle.migrations[0].name, sql }] }, () => {}) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'migration_blocked', message: genericBlock })
    const sdk = sdkWorkflowError(caught)
    expect(errorResult(caught)).toEqual({ ok: false, error: { code: 'migration_blocked', status: 400, message: genericBlock } })
    expect(sdk).toMatchObject({ code: 'migration_blocked', details: undefined })
    expect(sdk.message).not.toContain('INJECTED_PRIVATE_TEXT')
    expect(sdk.message).not.toContain('secret_customer')
    expect(JSON.stringify(caught)).not.toContain('INJECTED_PRIVATE_TEXT')
    expect(JSON.stringify(caught)).not.toContain('secret_customer')
  }
})

it.each([false, true])('allow-lists both current and target configuration entities (V3=%s)', async v3 => {
  const bundle = rebuildFixture(v3)
  const currentConfig = { ...rebuildFixture(false).config, entities: { old_records: bundle.config.entities.records } }
  const migrations = [{ name: bundle.migrations[0].name, sql: 'CREATE TABLE input (id CONSTRAINT rebuild_requires_review_old_records_columns CHECK(id>0)); INSERT INTO input VALUES(0);' }]
  await expect(replayBundle({ config: bundle.config, currentConfig, migrations }, () => {})).rejects.toMatchObject({ code: 'migration_blocked', message: columnsBlock.replace('for records:', 'for old_records:') })
  await expect(replayBundle({ config: bundle.config, migrations }, () => {})).rejects.toMatchObject({ code: 'migration_blocked', message: genericBlock })
})
