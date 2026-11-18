import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from '../src/server.ts'
import { parseProposal } from '../src/proposals.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'
import { initializationPaths } from '../src/initialization.ts'
import { hash } from '../src/planning.ts'

const composition = { interactive: false, plugins: [
  { plugin: 'identity' }, { plugin: 'permissions' }, { plugin: 'members' },
  { plugin: 'organizations', options: { allowCreate: true } },
  { plugin: 'local-auth', options: { methods: ['magic-link'] } },
  { plugin: 'machine-credentials' }, { plugin: 'mail-outbox' },
] }
const instance = 'fresh-instance', bootstrap = { id: 'fresh_instance', target: 'cloudflare-github' }
const roots: string[] = []
const closers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function empty() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fresh-composition-'))); roots.push(root); return root
}
async function fixture() {
  const root = await empty(), app = await createServer({ root }); closers.push(() => app.server.close())
  const call = (name: string, input: Record<string, unknown>) => app.workflow.call(name, input) as Promise<any>
  expect(await call('bootstrap_instance', bootstrap)).toMatchObject({ ok: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  const original = await readFile(join(root, 'runtime.ts'), 'utf8')
  const propose = async (selection = composition) => {
    const result = await call('propose_initial_composition', { instance, composition: selection })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, kind: 'initial_composition', status: 'proposed', revision: 1 })
    return result
  }
  const proposal = await propose(), args = { proposalId: proposal.proposalId }
  const promote = () => call('promote', { ...args, expectedRevision: 1 })
  const verify = async () => {
    expect(await call('validate', args)).toMatchObject({ ok: true, revision: 1 })
    expect(await call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
  }
  return { root, app, call, original, propose, proposal, args, promote, verify }
}
async function unpublished(root: string, original: string) {
  expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(original)
  for (const path of initializationPaths) await expect(readFile(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
}
it('persists a strict captured fresh plan before initialization, with exact preview and no destination outputs', async () => {
  const { root, call, args, original, proposal } = await fixture()
  const record = JSON.parse(await readFile(join(root, 'proposals', `${proposal.proposalId}.json`), 'utf8'))
  expect(parseProposal(record)).toEqual(record)
  expect(record).toMatchObject({ kind: 'initial_composition', plan: { planHash: proposal.planHash, model: { interactive: false } } })
  for (const bad of [{ ...record, changes: [] }, { ...record, plan: { ...record.plan, unsafe: true } },
    { ...record, plan: { ...record.plan, files: record.plan.files.map((f: any, i: number) => i ? f : { ...f, data: 'tampered' }) } }]) {
    expect(() => parseProposal(bad)).toThrow()
  }
  const preview = await call('preview_migration', args)
  expect(preview).toMatchObject({ ok: true, planHash: proposal.planHash, revision: 1, files: record.plan.files,
    resolvedOptions: { plugins: expect.arrayContaining([{ plugin: 'permissions', options: { roles: ['admin', 'staff'], ownerRole: 'admin' } }]) },
    requirements: expect.arrayContaining([expect.objectContaining({ requirement: 'EMAIL', severity: 'warning' })]),
    pluginMigrations: expect.any(Array) })
  expect(preview.sql).toBe(record.plan.files.find((f: any) => f.path === 'migrations/0001_r1.sql').data)
  for (const f of preview.files) expect(f.hash).toBe(hash(f.data))
  await unpublished(root, original)
  expect(await call('validate', args)).toMatchObject({ ok: true })
  await unpublished(root, original)
})
it('requires matching proofs and publishes the exact preview once, refreshes Store and returns an identical receipt', async () => {
  const { root, call, args, original, proposal, promote } = await fixture()
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  expect(await call('apply_to_disposable', args)).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  expect(await call('validate', args)).toMatchObject({ ok: true })
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'verification_required' } })
  const preview = await call('preview_migration', args)
  const verification = await call('apply_to_disposable', { ...args, keep: true })
  expect(verification).toMatchObject({ ok: true, verified: true, diffs: [] })
  roots.push(verification.directory)
  async function sqlite(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? sqlite(join(dir, entry.name)) : [join(dir, entry.name)]))).flat().filter(path => path.includes('/persist/v3/d1/') && /[a-f0-9]{64}\.sqlite$/.test(path))
  }
  const db = new DatabaseSync((await sqlite(verification.directory))[0], { readOnly: true })
  try {
    expect(db.prepare('SELECT namespace,name,position,checksum FROM _plugin_migrations ORDER BY namespace,position').all()).toEqual(preview.pluginMigrations)
    const namespaces = db.prepare('SELECT DISTINCT namespace FROM _plugin_migrations').all().map(row => row.namespace)
    expect(namespaces).not.toContain('audit'); expect(namespaces).not.toContain('console')
    expect(db.prepare('SELECT revision FROM instance_meta').all()).toEqual([{ revision: 1 }])
  } finally { db.close() }
  await unpublished(root, original)
  expect(await call('promote', { ...args, expectedRevision: 2 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
  const receipt = await promote()
  expect(receipt).toMatchObject({ ok: true, status: 'promoted', revision: 1, planHash: proposal.planHash, appliesToDatabase: false })
  for (const file of preview.files) expect(await readFile(join(root, file.path), 'utf8')).toBe(file.data)
  expect(await call('inspect_schema', { instance })).toMatchObject({ ok: true, revision: 1, validation: { ok: true } })
  expect(await promote()).toEqual(receipt)
  expect(await call('bootstrap_instance', bootstrap)).toMatchObject({ ok: true, files: expect.arrayContaining([{ path: 'runtime.ts', status: 'conflict' }]) })
  for (const file of preview.files) expect(await readFile(join(root, file.path), 'utf8')).toBe(file.data)
  const restarted = await createServer({ root }); closers.push(() => restarted.server.close())
  expect(await restarted.workflow.call('promote', { ...args, expectedRevision: 1 })).toEqual(receipt)
})
it.each(['config.ts', 'package.json', 'bun.lock', 'wrangler.jsonc', 'src/index.ts', 'runtime.ts', 'migrations/0002_authored.sql'])
('refuses stale %s inputs without publishing', async path => {
  const { root, call, args, original, promote } = await fixture()
  expect(await call('validate', args)).toMatchObject({ ok: true })
  const previous = await readFile(join(root, path), 'utf8').catch(() => '')
  await writeFile(join(root, path), previous + (path.endsWith('.ts') ? '\n// authored\n' : '\n '))
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
  expect(await readFile(join(root, path), 'utf8')).toBe(previous + (path.endsWith('.ts') ? '\n// authored\n' : '\n '))
  if (path !== 'runtime.ts') await unpublished(root, original)
})
it('fences competing default initialization and second fresh proposal publication', async () => {
  const a = await fixture(), second = await a.propose({ ...composition, plugins: composition.plugins.filter(p => p.plugin !== 'mail-outbox') })
  const otherArgs = { proposalId: second.proposalId }
  expect(await a.call('validate', otherArgs)).toMatchObject({ ok: true })
  expect(await a.call('apply_to_disposable', otherArgs)).toMatchObject({ ok: true })
  await a.verify()
  expect(await a.promote()).toMatchObject({ ok: true })
  const published = await readFile(join(a.root, 'runtime.ts'), 'utf8')
  expect(await a.call('promote', { ...otherArgs, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
  const defaultPreview = await a.call('initialize_instance', { instance, mode: 'preview' })
  expect(defaultPreview).toMatchObject({ ok: true, conflicts: [] })
  expect(await a.call('initialize_instance', { instance, mode: 'apply', planHash: defaultPreview.planHash })).toMatchObject({ ok: true, status: 'unchanged' })
  expect(await readFile(join(a.root, 'runtime.ts'), 'utf8')).toBe(published)
  const b = await fixture()
  await b.verify()
  const preview = await b.call('initialize_instance', { instance, mode: 'preview' })
  expect(await b.call('initialize_instance', { instance, mode: 'apply', planHash: preview.planHash })).toMatchObject({ ok: true, status: 'initialized' })
  expect(await b.promote()).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
  expect(parseRuntimeSource(await readFile(join(b.root, 'runtime.ts'), 'utf8')).plugins).toHaveLength(9)
})
it('revokes verification on revalidation, closes discarded proposals and rejects mismatched proof identities', async () => {
  const { root, call, args, verify, promote, proposal } = await fixture()
  await verify()
  expect(await call('validate', args)).toMatchObject({ ok: true })
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'verification_required' } })
  const path = join(root, 'proposals', `${proposal.proposalId}.json`), record = JSON.parse(await readFile(path, 'utf8'))
  record.validation.planHash = '0'.repeat(64)
  await writeFile(path, JSON.stringify(record))
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  expect(await call('discard', args)).toMatchObject({ ok: true, status: 'discarded' })
  expect(await call('validate', args)).toMatchObject({ ok: false, error: { code: 'proposal_closed' } })
})
it('recovers interrupted runtime, artifacts and receipt together before retrying the verified proposal', async () => {
  const { root, args, original, verify, promote } = await fixture()
  await verify()
  const script = `import { createServer } from ${JSON.stringify(resolve('packages/mcp/src/server.ts'))};
const app = await createServer({root:${JSON.stringify(root)}});
const commit = app.store.commit.bind(app.store);
app.store.commit = (instance, files, guards) => commit(instance, files, guards, async () => process.exit(73));
await app.workflow.call('promote', ${JSON.stringify({ ...args, expectedRevision: 1 })});`
  const child = spawnSync('bun', ['--no-install', '--eval', script], { encoding: 'utf8', env: process.env })
  expect(child.status, child.stderr).toBe(73)
  expect(await readdir(join(root, 'proposals'))).toContain('.promotion.json')
  const restarted = await createServer({ root }); closers.push(() => restarted.server.close())
  await unpublished(root, original)
  expect((await restarted.store.find(args.proposalId)).proposal.status).toBe('verified')
  expect(await promote()).toMatchObject({ ok: true, status: 'promoted' })
})
it.each(['source', 'dependencies', 'requirements'])('rolls back runtime and all artifacts when %s change during publication', async change => {
  const { root, app, original, verify, promote, args } = await fixture()
  await verify()
  const commit = app.store.commit.bind(app.store)
  app.store.commit = (id, files, guards, verifyInputs) => commit(id, files, guards, async () => {
    if (change === 'dependencies') await rm(join(root, 'node_modules'))
    else {
      const path = change === 'source' ? 'config.ts' : 'wrangler.jsonc'
      await writeFile(join(root, path), await readFile(join(root, path), 'utf8') + '\n ')
    }
    await verifyInputs?.()
  })
  expect(await promote()).toMatchObject({ ok: false, error: { code: change === 'dependencies' ? 'dependencies_missing' : 'concurrent_modification' } })
  await unpublished(root, original)
  expect((await app.store.find(args.proposalId)).proposal.status).toBe('verified')
})
it('refuses a changed persisted selection and clears old proofs when revalidation fails', async () => {
  const { root, call, args, verify, promote, proposal, original } = await fixture()
  await verify()
  const path = join(root, 'proposals', `${proposal.proposalId}.json`), record = JSON.parse(await readFile(path, 'utf8'))
  record.composition.plugins = record.composition.plugins.filter((p: any) => p.plugin !== 'mail-outbox')
  await writeFile(path, JSON.stringify(record))
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
  expect(await call('validate', args)).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
  const revoked = JSON.parse(await readFile(path, 'utf8'))
  expect(revoked.status).toBe('proposed')
  expect(revoked.validation).toBeUndefined(); expect(revoked.verification).toBeUndefined()
  revoked.composition = composition
  await writeFile(path, JSON.stringify(revoked))
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  await unpublished(root, original)
})
it('clears old disposable proof on an interrupted verification attempt', async () => {
  const { root, app, args, verify, promote, original } = await fixture()
  await verify()
  const controller = new AbortController(); controller.abort()
  expect(await app.workflow.call('apply_to_disposable', args, controller.signal)).toMatchObject({ ok: false, verified: false, diffs: [expect.objectContaining({ code: 'disposable_apply_failed' })] })
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'verification_required' } })
  await unpublished(root, original)
})
it('serializes competing selected publication and default initialization through the shared Store lock', async () => {
  const { root, call, app, args, verify, proposal } = await fixture()
  await verify()
  const preview = await call('initialize_instance', { instance, mode: 'preview' })
  const other = await createServer({ root }); closers.push(() => other.server.close())
  const results = await Promise.all([
    app.workflow.call('promote', { ...args, expectedRevision: 1 }),
    other.workflow.call('initialize_instance', { instance, mode: 'apply', planHash: preview.planHash }),
  ]) as any[]
  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.find(result => !result.ok).error.code).toBe('instance_busy')
  const model = parseRuntimeSource(await readFile(join(root, 'runtime.ts'), 'utf8'))
  expect(model.plugins).toHaveLength(results[0].ok ? 7 : 9)
  if (results[0].ok) expect(results[0].planHash).toBe(proposal.planHash)
  expect(await call('inspect_schema', { instance })).toMatchObject({ ok: true, revision: 1, validation: { ok: true } })
})
async function stdio(root: string, runtime: string) {
  const client = new Client({ name: 'initial-composition-contract', version: '1' })
  const transport = new StdioClientTransport({ command: runtime, args: [
    ...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
    resolve('packages/mcp/src/stdio.ts'), '--root', root,
  ], stderr: 'pipe', env: { TMPDIR: tmpdir(), WORKBASE_MCP_STATE_ROOT: process.env.WORKBASE_MCP_STATE_ROOT! } })
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data.toString() })
  await client.connect(transport)
  return { client, call: async (name: string, input: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 120000 })
    const result = response.structuredContent as any
    expect(result, stderr).toBeDefined(); return result
  }, close: async () => { await client.close(); await transport.close() } }
}
it.each(['bun', 'node'])('runs the exact seven-plugin fresh flow through real %s stdio with restarts and no source edits', async runtime => {
  const root = await empty(); let session = await stdio(root, runtime)
  try {
    const tool = (await session.client.listTools()).tools.find(t => t.name === 'propose_initial_composition')
    expect(tool?.description).toContain('fresh')
    expect(await session.call('bootstrap_instance', bootstrap)).toMatchObject({ ok: true })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    const proposed = await session.call('propose_initial_composition', { instance, composition })
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, kind: 'initial_composition' })
    const args = { proposalId: proposed.proposalId }
    expect(await session.call('validate', args)).toMatchObject({ ok: true })
    await session.close(); session = await stdio(root, runtime)
    const preview = await session.call('preview_migration', args)
    expect(preview).toMatchObject({ ok: true, revision: 1 })
    expect(await session.call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
    await session.close(); session = await stdio(root, runtime)
    const receipt = await session.call('promote', { ...args, expectedRevision: 1 })
    expect(receipt).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    for (const file of preview.files) expect(await readFile(join(root, file.path), 'utf8')).toBe(file.data)
    const model = parseRuntimeSource(await readFile(join(root, 'runtime.ts'), 'utf8'))
    expect(model).toEqual(preview.resolvedOptions)
    expect(model.plugins.map(p => p.plugin)).toEqual(composition.plugins.map(p => p.plugin))
    expect(model.interactive).toBe(false)
    expect(await session.call('inspect_schema', { instance })).toMatchObject({ ok: true, revision: 1, validation: { ok: true }, instance_meta: { revision: 1 } })
    await session.close(); session = await stdio(root, runtime)
    expect(await session.call('promote', { ...args, expectedRevision: 1 })).toEqual(receipt)
    expect(await session.call('inspect_schema', { instance })).toMatchObject({ ok: true, revision: 1, validation: { ok: true } })
  } finally { await session.close() }
})
