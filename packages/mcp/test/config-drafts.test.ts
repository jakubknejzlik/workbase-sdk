import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { versionData } from '@workbasehq/core/migrations/versions'
import { Store, configSource } from '../src/storage'
import { ConfigDrafts } from '../src/config-drafts'
import { configuredProposer, startConfigEditor } from '../src/config-editor'
import { rollback } from '../src/versions'

let root: string; let directory: string; let drafts: ConfigDrafts; let store: Store
const config = defineInstance({ id: 'demo', revision: 1, roles: ['owner'], permissions: { owner: { interviews: ['read'] } }, entities: { interviews: { fields: { title: { type: 'string' }, notes: { type: 'text' }, starts_at: { type: 'datetime' } } } }, ui: { entities: { interviews: { list: { columns: ['title'] } } } } })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'config-drafts-'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  directory = join(root, 'examples/demo'); await mkdir(join(directory, 'migrations'), { recursive: true })
  await writeFile(join(directory, 'config.ts'), configSource(config))
  await writeFile(join(directory, 'migrations/0001_initial.sql'), initialSchema(config))
  store = new Store(root, new Set(['demo'])); await store.init(); drafts = new ConfigDrafts(store)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })
it('SR-85 previews without publication; Apply creates immutable history and local migration, retries once, and supports CLI/MCP rollback', async () => {
  const preview = await drafts.propose('demo', 'add notes column to interviews')
  expect(preview).toMatchObject({ baseRevision: 1, revision: 2, appliesToDatabase: false })
  expect(await readdir(directory)).not.toContain('config.v2.ts')
  const applied = await drafts.apply('demo', preview.proposalId)
  expect(applied).toMatchObject({ revision: 2, appliesToDatabase: false })
  expect(await drafts.apply('demo', preview.proposalId)).toEqual(applied)
  expect((await drafts.history('demo')).versions.map(version => version.revision)).toEqual([1, 2])
  expect((await store.load('demo')).config.ui!.entities.interviews.list!.columns).toEqual(['title', 'notes'])
  const rolledBack = await rollback(store, 'demo', 1, { expectedRevision: 2 })
  expect(rolledBack).toMatchObject({ ok: true, newRevision: 3, written: true, destructive: [], appliesToDatabase: false })
  expect(versionData((await store.load('demo')).config)).toEqual(versionData(config))
  expect((await drafts.history('demo')).versions.map(version => version.revision)).toEqual([1, 2, 3])
})
it('SR-85 added field rollback is conservatively refused, no writes, with explicit CLI override available', async () => {
  const preview = await drafts.propose('demo', 'add status field with filter')
  await drafts.apply('demo', preview.proposalId)
  expect(await rollback(store, 'demo', 1)).toMatchObject({ ok: false, written: false, destructive: ['DROP COLUMN interviews.status'] })
  expect((await store.load('demo')).config.revision).toBe(2)
  expect(await rollback(store, 'demo', 1, { allowDestructive: true })).toMatchObject({ ok: true, newRevision: 3, written: true })
})
it('SR-85 refuses stale or tampered previews and unsupported patches without publication', async () => {
  const preview = await drafts.propose('demo', 'add status field with filter')
  preview.patch[0].entity = 'missing' // Response mutation cannot alter the saved proposal.
  await writeFile(join(directory, 'config.ts'), configSource({ ...config, displayName: 'Edited' }))
  await expect(drafts.apply('demo', preview.proposalId)).rejects.toMatchObject({ code: 'stale_revision' })
  await expect(drafts.apply('demo', crypto.randomUUID())).rejects.toMatchObject({ code: 'proposal_not_found' })
  await expect(drafts.propose('demo', 'delete interviews')).rejects.toThrow('Only additive')
  expect(await readdir(directory)).not.toContain('config.v2.ts')
  expect(await readdir(join(directory, 'migrations'))).toEqual(['0001_initial.sql'])
})
it('SR-85 defaults to rules with zero LLM fetches; incomplete LLM config is disabled', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in proposer tests'))
  expect(await configuredProposer({}).propose('add status field with filter', config)).toHaveLength(1)
  expect(fetch).not.toHaveBeenCalled()
  expect(() => configuredProposer({ CONFIG_PROPOSER: 'llm' })).toThrow('requires')
})
it('SR-85 local companion requires its token, rejects browser origins and applies only opaque IDs', async () => {
  const token = crypto.randomUUID(); const editor = await startConfigEditor({ root, instances: ['demo'], token })
  try {
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(editor.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    expect((await post({ action: 'history', instance: 'demo' }, { Authorization: 'invalid' })).status).toBe(403)
    expect((await post({ action: 'history', instance: 'demo' }, { Origin: 'http://evil.test' })).status).toBe(403)
    const response = await post({ action: 'propose', instance: 'demo', prompt: 'add status field with filter' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const proposal = await response.json() as { proposalId: string }
    expect((await post({ action: 'apply', instance: 'demo', proposalId: proposal.proposalId, patch: [] })).status).toBe(400)
    expect((await post({ action: 'apply', instance: 'demo', proposalId: proposal.proposalId })).status).toBe(200)
    expect((await post({ action: 'history', instance: 'other' })).status).toBe(403)
    expect((await store.load('demo')).config.revision).toBe(2)
    const history = JSON.parse(await readFile(join(directory, 'config.versions.json'), 'utf8'))
    expect(history).toHaveLength(2)
  } finally { await editor.stop() }
})
