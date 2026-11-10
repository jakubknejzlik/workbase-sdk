import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { quaternary } from './fixtures/model'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineInstance } from '@workbasehq/core/config'
import { versionData } from '@workbasehq/core/migrations/versions'
import { Store, configSource } from '../src/storage'
import { Workflow } from '../src/workflow'

let root: string; let directory: string; let workflow: Workflow
const historical = defineInstance({ id: 'demo', revision: 1, roles: ['owner'], entities: { items: { fields: { title: { type: 'string' }, notes: { type: 'text' } } } }, permissions: { owner: { items: ['read'] } } })
const current = defineInstance({ ...historical, revision: 2, entities: { items: { fields: { title: { type: 'string' } } } } })
beforeEach(async () => {
  root = registerTempDir(await mkdtemp(join(tmpdir(), 'config-versions-')))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  directory = join(root, 'examples/demo')
  await mkdir(join(directory, 'migrations'), { recursive: true })
  await writeFile(join(directory, 'config.v1.ts'), configSource(historical))
  await writeFile(join(directory, 'config.ts'), configSource(current))
  await writeFile(join(directory, 'config.versions.json'), JSON.stringify([{ revision: 1, config: versionData(historical) }]) + '\n')
  const store = new Store(root, new Set(['demo'])); await store.init(); workflow = new Workflow(store)
})
afterEach(async () => { cleanupTempDir(root) })
const call = (input: object) => workflow.call('rollback', { instance: 'demo', to: 'v1', expectedRevision: 2, ...input })
it('correlates a persisted rollback outcome only with the call that wrote files', async () => {
  expect(await call({ preview: true })).toMatchObject({ written: false })
  expect(await call({})).toMatchObject({ written: true })
  expect(await call({ expectedRevision: 3 })).toMatchObject({ written: false, unchanged: true })
  expect(await call({ to: 'v2', expectedRevision: 3 })).toMatchObject({ ok: false, written: false })
  expect(await call({})).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
  const log = (await readFile(join(directory, 'proposals/log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(log).toHaveLength(6)
  expect(log.filter(event => event.outcome)).toEqual([{
    timestamp: expect.any(String), callId: log[1].callId, tool: 'rollback',
    outcome: { written: true, fromRevision: 2, newRevision: 3, migration: '0001_rollback_to_v1.sql' },
  }])
  expect(log[1].callId).toMatch(/^[a-f0-9-]{36}$/)
  expect(new Set(log.filter(event => !event.outcome).map(event => event.callId)).size).toBe(5)
})
it('MCP rollback previews without changing files, appends a new version, and retries idempotently', async () => {
  expect(await call({ preview: true })).toMatchObject({ ok: true, written: false, newRevision: 3, appliesToDatabase: false })
  expect(await readdir(join(directory, 'migrations'))).toEqual([])
  expect(await call({})).toMatchObject({ ok: true, written: true, newRevision: 3, migration: '0001_rollback_to_v1.sql' })
  const saved = await workflow.store.load('demo')
  expect(saved.config.revision).toBe(3)
  expect(versionData(saved.config)).toEqual(versionData(historical))
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['config.v1.ts', 'config.v2.ts', 'config.v3.ts', 'config.versions.json']))
  expect(await call({ expectedRevision: 3 })).toMatchObject({ ok: true, written: false, unchanged: true, newRevision: 3 })
  expect(await readdir(join(directory, 'migrations'))).toHaveLength(1)
  const history = await workflow.call('list_versions', { instance: 'demo' }) as any
  expect(history.versions.map((v: any) => v.revision)).toEqual([1, 2, 3])
  expect(history.versions[2].rollbackTo).toBe(1)
})
it('MCP refuses destructive rollback without writing a version/config/migration and keeps stale guards', async () => {
  await writeFile(join(directory, 'config.ts'), configSource({ ...historical, revision: 3 }))
  await writeFile(join(directory, 'config.v2.ts'), configSource(current))
  await writeFile(join(directory, 'config.versions.json'), JSON.stringify([{ revision: 1, config: versionData(historical) }, { revision: 2, config: versionData(current) }]) + '\n')
  const before = await readFile(join(directory, 'config.ts'), 'utf8')
  const refused = await call({ to: 'v2', expectedRevision: 3 })
  expect(refused).toMatchObject({ ok: false, written: false, destructive: ['DROP COLUMN items.notes'] })
  expect(await readFile(join(directory, 'config.ts'), 'utf8')).toBe(before)
  expect(await readdir(join(directory, 'migrations'))).toEqual([])
  expect(await call({})).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
  expect(await call({ to: 'v2', expectedRevision: 3, allowDestructive: true })).toMatchObject({ ok: true, written: true, newRevision: 4 })
})
it('rejects unlisted instances and invalid or future version targets', async () => {
  expect(await call({ instance: '../other' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(await call({ instance: 'other' })).toMatchObject({ ok: false, error: { code: 'instance_not_allowed' } })
  expect(await call({ to: 'v0' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})

it('restores a real plugin-based configuration with expressions, roles and UI from its canonical snapshot', async () => {
  const original = defineInstance({ ...quaternary, id: 'demo', revision: 1 })
  const edited = defineInstance({ ...original, revision: 2, ui: { ...original.ui!, defaultLanguage: 'cs' } })
  await writeFile(join(directory, 'config.ts'), configSource(edited))
  await writeFile(join(directory, 'config.versions.json'), JSON.stringify([{ revision: 1, config: versionData(original) }]) + '\n')
  expect(await call({})).toMatchObject({ ok: true, written: true, newRevision: 3, destructive: [] })
  const restored = (await workflow.store.load('demo')).config
  expect(versionData(restored)).toEqual(versionData(original))
  expect(restored.plugins?.map(p => p.name)).toEqual(original.plugins?.map(p => p.name))
  expect(restored.entities.entries.label?.serialize()).toEqual(original.entities.entries.label?.serialize())
})
it('a recorded revision cannot be overwritten with edited config data', async () => {
  await writeFile(join(directory, 'config.versions.json'), JSON.stringify([{ revision: 1, config: versionData(historical) }, { revision: 2, config: { ...versionData(current), displayName: 'Different' } }]) + '\n')
  const before = await readFile(join(directory, 'config.ts'), 'utf8')
  expect(await call({})).toMatchObject({ ok: false, error: { code: 'version_conflict' } })
  expect(await readFile(join(directory, 'config.ts'), 'utf8')).toBe(before)
  expect(await readdir(join(directory, 'migrations'))).toEqual([])
})

it('refuses a conflicting future version source before publishing any rollback files', async () => {
  await writeFile(join(directory, 'config.v3.ts'), configSource({ ...current, revision: 3 }))
  const before = await readFile(join(directory, 'config.ts'), 'utf8')
  expect(await call({})).toMatchObject({ ok: false, error: { code: 'version_conflict' } })
  expect(await readFile(join(directory, 'config.ts'), 'utf8')).toBe(before)
  expect(await readdir(join(directory, 'migrations'))).toEqual([])
})

it('175 automatic built-in roles do not conflict with unchanged archived revisions or rewrite history', async () => {
  const legacy = { ...versionData(current), roles: current.roles.filter(role => role !== 'member') }
  const history = [{ revision: 1, config: versionData(historical) }, { revision: 2, config: legacy }]
  await writeFile(join(directory, 'config.versions.json'), JSON.stringify(history))
  expect(await call({})).toMatchObject({ ok: true, written: true, newRevision: 3 })
  const saved = JSON.parse(await readFile(join(directory, 'config.versions.json'), 'utf8'))
  expect(saved.slice(0, 2)).toEqual(history)
})
it('175 materialized built-ins cannot hide a same-revision permission change', async () => {
  const legacy = { ...versionData(current), roles: current.roles.filter(role => role !== 'member'), permissions: {} }
  await writeFile(join(directory, 'config.versions.json'), JSON.stringify([{ revision: 1, config: versionData(historical) }, { revision: 2, config: legacy }]))
  expect(await call({})).toMatchObject({ ok: false, error: { code: 'version_conflict' } })
})
