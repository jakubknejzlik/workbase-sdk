import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { createServer } from '../src/server.ts'
import { parseProposal } from '../src/proposals.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'
import { replayBundle } from '../src/offline.ts'
import type { CompositionChange } from '../src/schemas.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const changes: CompositionChange[] = [
  { kind: 'set_plugin', plugin: 'organizations', options: { allowCreate: true } },
  { kind: 'set_plugin', plugin: 'local-auth', options: { methods: ['magic-link'] } },
  { kind: 'set_plugin', plugin: 'mail-outbox' },
  { kind: 'set_interactive', interactive: true },
]
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-composition-')); roots.push(root)
  const { server, store, workflow } = await createServer({ root })
  expect(await workflow.call('bootstrap_instance', { id: 'composition_fixture', target: 'cloudflare-github' })).toMatchObject({ ok: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
  await writeFile(join(root, 'runtime.ts'), `// authored header
import { identity } from '@workbasehq/plugins/identity'
import { permissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import config from './config'
export default { ...config, plugins: [identity, permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }), members, machineCredentials()] }
// authored footer
`)
  await store.init()
  const call = async (name: string, args: Record<string, unknown>) => workflow.call(name, args) as Promise<any>
  const propose = async () => {
    const result = await call('propose_composition', { instance: 'composition-fixture', baseRevision: 1, changes })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, kind: 'composition_change', status: 'proposed' })
    return result.proposalId as string
  }
  return { root, server, store, call, propose }
}
async function authored(root: string) {
  const files = ['config.ts', 'access.ts', 'schema.lock.json', 'schema/worker.ts', 'package.json',
    ...(await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).map(name => `migrations/${name}`)]
  return Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(join(root, path), 'utf8')])))
}
it('persists a separate strict composition proposal and rejects mixed config changes', () => {
  const record = { kind: 'composition_change', proposalId: crypto.randomUUID(), instance: 'sample', baseRevision: 1,
    createdAt: new Date().toISOString(), status: 'proposed', changes }
  expect(parseProposal(record)).toEqual(record)
  expect(() => parseProposal({ ...record, changes: [{ kind: 'add_role', role: 'viewer' }] })).toThrow()
  expect(() => parseProposal({ ...record, targetVersion: '1.2.3' })).toThrow()
})
it('validates, verifies and promotes composition across restart, preserving all domain bytes and revision', async () => {
  const { root, server, store, call, propose } = await fixture()
  try {
    const before = await authored(root), runtime = await readFile(join(root, 'runtime.ts'), 'utf8')
    const proposalId = await propose()
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true, revision: 1 })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'verification_required' } })
    const preview = await call('preview_migration', { proposalId })
    expect(preview).toMatchObject({ ok: true, kind: 'composition_change', revision: 1, sql: '', files: [{ path: 'runtime.ts', data: expect.any(String) }] })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await authored(root)).toEqual(before)
    expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(runtime)
    for (const path of ['runtime.ts', 'config.ts', 'access.ts', 'schema/worker.ts', 'schema.lock.json', 'package.json', 'bun.lock', 'migrations/0001_r1.sql']) {
      const old = await readFile(join(root, path), 'utf8').catch(() => undefined)
      try {
        await writeFile(join(root, path), (old ?? '') + '\n')
        expect(await call('promote', { proposalId, expectedRevision: 1 }), path).toMatchObject({ ok: false, error: { code: 'validation_required' } })
      } finally {
        if (old === undefined) await rm(join(root, path))
        else await writeFile(join(root, path), old)
      }
    }
    const restarted = await createServer({ root })
    try {
      expect(await restarted.workflow.call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1, appliesToDatabase: false })
    } finally { await restarted.server.close() }
    expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(preview.files[0].data)
    expect(preview.files[0].data).toContain('// authored header')
    expect(preview.files[0].data).toContain('// authored footer')
    expect(parseRuntimeSource(preview.files[0].data)).toMatchObject({ interactive: true, plugins: expect.arrayContaining([{ plugin: 'mail-outbox' }]) })
    expect(await authored(root)).toEqual(before)
    const current = await store.load('composition-fixture')
    expect(await replayBundle(current, db => db.prepare('SELECT DISTINCT namespace FROM _plugin_migrations ORDER BY namespace').all().map(row => row.namespace)))
      .toEqual(['identity', 'machine-credentials', 'mail-outbox', 'members', 'organizations', 'workbase-sdk'])
    expect(await call('validate', { instance: 'composition-fixture' })).toMatchObject({ ok: true })
    expect(await call('submit_change', { instance: 'composition-fixture', proposalId, expectedBaseSha: 'a'.repeat(40) }))
      .toMatchObject({ ok: false, error: { code: 'composition_submit_unsupported' } })
  } finally { await server.close() }
})
it.each(['runtime.ts', 'access.ts', 'schema/worker.ts', 'schema.lock.json', 'package.json', 'bun.lock', 'migrations/0001_r1.sql'])(
  'rejects promotion after %s changes without publishing runtime', async path => {
    const { root, server, call, propose } = await fixture()
    try {
      const proposalId = await propose()
      expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
      // Proof comparison covers every authored input; no disposable is needed to reject a stale validation.
      const original = await readFile(join(root, 'runtime.ts'), 'utf8')
      const old = await readFile(join(root, path), 'utf8').catch(() => '')
      await writeFile(join(root, path), old + (path.endsWith('.json') ? ' ' : '\n'))
      expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
      if (path !== 'runtime.ts') expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(original)
    } finally { await server.close() }
  },
)
it('rejects noncanonical runtime without executing it, invalid graphs and stale revisions', async () => {
  const { root, server, call, propose } = await fixture()
  try {
    expect(await call('propose_composition', { instance: 'composition-fixture', baseRevision: 2, changes }))
      .toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    expect(await call('propose_composition', { instance: 'composition-fixture', baseRevision: 1, changes: [{ kind: 'set_interactive', interactive: true }] }))
      .toMatchObject({ ok: false, error: { code: 'invalid_composition' } })
    const proposalId = await propose()
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
    const source = await readFile(join(root, 'runtime.ts'), 'utf8')
    await writeFile(join(root, 'runtime.ts'), source + "throw new Error('runtime-must-not-execute')\n")
    expect(await call('validate', { proposalId })).toMatchObject({ ok: false, error: { code: 'runtime_not_canonical' } })
    const saved = JSON.parse(await readFile(join(root, 'proposals', `${proposalId}.json`), 'utf8'))
    expect(saved).toMatchObject({ status: 'proposed' })
    expect(saved.validation).toBeUndefined()
    expect(saved.verification).toBeUndefined()
    await writeFile(join(root, 'runtime.ts'), source)
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
    expect(await call('discard', { proposalId })).toMatchObject({ ok: true, status: 'discarded' })
  } finally { await server.close() }
})
it.each(['validate', 'apply_to_disposable'].flatMap(tool =>
  ['config.ts', 'migrations', 'migrations/0001_r1.sql'].map(path => ({ tool, path })),
))('revokes composition proofs before $tool fails on $path, including across restart', async ({ tool, path }) => {
  const { root, server, call, propose } = await fixture()
  let proposalId: string
  try {
    proposalId = await propose()
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
    const original = join(root, path), saved = join(root, 'preflight.saved')
    await rename(original, saved)
    try {
      if (path !== 'config.ts') await symlink(saved, original)
      // Force recovery to inspect the unsafe file before loading the bundle.
      if (path.endsWith('.sql')) await writeFile(join(root, 'proposals/.promotion.json'), JSON.stringify({
        files: [{ path, before: await readFile(saved, 'utf8') }],
      }))
      expect(await call(tool, { proposalId })).toMatchObject({ ok: false, error: {
        code: path === 'config.ts' ? 'invalid_instance_directory' : 'unsafe_path',
      } })
    } finally {
      if (path.endsWith('.sql')) await rm(join(root, 'proposals/.promotion.json'))
      if (path !== 'config.ts') await rm(original)
      await rename(saved, original)
    }
  } finally { await server.close() }
  const restarted = await createServer({ root })
  try {
    const record = JSON.parse(await readFile(join(root, 'proposals', `${proposalId}.json`), 'utf8'))
    expect(record.status).toBe(tool === 'validate' ? 'proposed' : 'validated')
    expect(record.verification).toBeUndefined()
    if (tool === 'validate') expect(record.validation).toBeUndefined()
    expect(await restarted.workflow.call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false,
      error: { code: tool === 'validate' ? 'validation_required' : 'verification_required' } })
  } finally { await restarted.server.close() }
})
it.each<CompositionChange>([
  { kind: 'set_plugin', plugin: 'local-auth' },
  { kind: 'set_interactive', interactive: false },
])('repairs interactive mode without a login provider using $kind', async change => {
  const { root, server, call } = await fixture()
  try {
    const source = await readFile(join(root, 'runtime.ts'), 'utf8')
    await writeFile(join(root, 'runtime.ts'), source.replace('...config, plugins:', '...config, interactive: true, plugins:'))
    const before = await authored(root)
    const proposal = await call('propose_composition', { instance: 'composition-fixture', baseRevision: 1, changes: [change] })
    expect(proposal).toMatchObject({ ok: true, status: 'proposed' })
    const proposalId = proposal.proposalId
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true, revision: 1 })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    expect(await call('validate', { instance: 'composition-fixture' })).toMatchObject({ ok: true })
    expect(await authored(root)).toEqual(before)
  } finally { await server.close() }
})
it.each(['publication fault', 'new schema input'])('rolls back runtime and proposal together after %s', async fault => {
  const { root, server, store, propose } = await fixture()
  try {
    const proposalId = await propose()
    const paths = ['runtime.ts', `proposals/${proposalId}.json`]
    const before = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))
    const bundle = await store.load('composition-fixture', { canonicalRuntime: true })
    const commit = store.commit('composition-fixture', paths.map(path => ({ path, data: 'publication bytes\n' })), bundle.guards, async () => {
      if (fault === 'publication fault') throw new Error('injected publication fault')
      await writeFile(join(root, 'schema/new.ts'), '// concurrent authored input\n')
    })
    await expect(commit).rejects.toThrow(fault === 'publication fault' ? 'injected publication fault' : 'Instance files changed during promotion')
    expect(await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))).toEqual(before)
    expect(await readFile(join(root, 'proposals/.promotion.json')).catch(() => undefined)).toBeUndefined()
    await store.recover(root)
    if (fault === 'new schema input') expect(await readFile(join(root, 'schema/new.ts'), 'utf8')).toBe('// concurrent authored input\n')
  } finally { await server.close() }
})
