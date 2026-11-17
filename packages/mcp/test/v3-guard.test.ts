import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bootstrapInstance } from '../src/bootstrap.ts'
import { runSchemaCli } from '@workbasehq/core/migrations/schema-cli'
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
import { Store } from '../src/storage.ts'
import { Workflow } from '../src/workflow.ts'
import { rollback } from '../src/versions.ts'
import { ConfigDrafts } from '../src/config-drafts.ts'
import { guardV3LegacyWrite } from '../src/v3-guard.ts'
import type { InstanceConfig } from '@workbasehq/core/config'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'v3-guard-')))
  roots.push(root)
  await bootstrapInstance(root, { id: 'demo', target: 'cloudflare-github' })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await runSchemaCli('plan', ['--root', root, '--init'])
  await runOpenApiCli(['--root', root, '--write'])
  await rm(join(root, 'migrations/.gitkeep'))
  const store = new Store(root)
  await store.init()
  return { root, store, workflow: new Workflow(store) }
}
it('rejects V3 legacy authorization proposals and names the replacement', async () => {
  const { root, workflow } = await fixture()
  const before = await readFile(join(root, 'config.ts'))
  expect(await workflow.call('propose_change', { instance: 'demo', baseRevision: 1,
    changes: [{ kind: 'set_permissions', entity: 'worker', role: 'staff', operations: ['read'] }] })).toMatchObject({
    ok: false, error: { code: 'v3_unsupported_change', message: expect.stringContaining('set_entity_access') },
  })
  expect(await readFile(join(root, 'config.ts'))).toEqual(before)
})
it('blocks V3 domain promotion before revision, migration and proof checks without writing config or proposal', async () => {
  const { root, workflow } = await fixture()
  const before = await readFile(join(root, 'config.ts'))
  const proposalId = crypto.randomUUID()
  const path = join(root, 'proposals', `${proposalId}.json`)
  const proposal = JSON.stringify({ proposalId, instance: 'demo', baseRevision: 1, status: 'proposed', createdAt: new Date().toISOString(),
    changes: [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }] })
  await writeFile(path, proposal)
  for (const expectedRevision of [1, 999]) expect(await workflow.call('promote', { proposalId, expectedRevision })).toMatchObject({ ok: false, error: { code: 'v3_promote_unsupported' } })
  expect(await readFile(join(root, 'config.ts'))).toEqual(before)
  expect(await readFile(path, 'utf8')).toBe(proposal)
})
it('blocks rollback and a saved editor draft after the instance becomes V3', async () => {
  const { store, root } = await fixture()
  const before = await readFile(join(root, 'config.ts'))
  await expect(rollback(store, 'demo', 1)).rejects.toMatchObject({ code: 'v3_rollback_unsupported' })
  // Model an editor session created before the application switched to V3.
  const bundle = await store.load('demo')
  const drafts = new ConfigDrafts(store)
  // Isolate the saved draft: proposing V3 drafts already fails in offline replay.
  const saved = (drafts as unknown as { proposals: Map<string, unknown> }).proposals
  saved.set('saved', { instance: 'demo', fingerprint: bundle.fingerprint, proposal: {} })
  await expect(drafts.apply('demo', 'saved')).rejects.toMatchObject({ code: 'v3_apply_unsupported' })
  expect(await readFile(join(root, 'config.ts'))).toEqual(before)
})
it('keeps legacy calls unchanged and rejects each V3 authorization kind', () => {
  const legacy = { baseline: undefined } as InstanceConfig
  const v3 = { baseline: 'workbase-sdk' } as InstanceConfig
  for (const operation of ['propose', 'promote', 'rollback', 'apply'] as const) expect(() => guardV3LegacyWrite(legacy, operation)).not.toThrow()
  for (const [kind, replacement] of Object.entries({ set_permissions: 'set_entity_access', set_policy: 'set_entity_access', set_organization_permissions: 'set_system_access', add_user_link: 'set_account_link', add_role: 'role', remove_role: 'role' })) {
    expect(() => guardV3LegacyWrite(v3, 'propose', [{ kind } as never])).toThrow(expect.objectContaining({ code: 'v3_unsupported_change', message: expect.stringContaining(replacement) }))
  }
  expect(() => guardV3LegacyWrite(v3, 'propose', [{ kind: 'add_field' } as never])).not.toThrow()
})
