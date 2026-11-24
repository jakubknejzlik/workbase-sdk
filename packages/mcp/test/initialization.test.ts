import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from '../src/server.ts'
import { bootstrapInstance } from '../src/bootstrap.ts'
import { initializationPaths } from '../src/initialization.ts'
import { initializationDependencies, planInitialization } from '../src/initialization-plan.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'
import { provisionLocalSdk, provisionProbeSdk } from './fixtures/local-sdk.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function empty() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'initialize-instance-'))); roots.push(root)
  return root
}
const bootstrap = { id: 'fresh_instance', target: 'cloudflare-github' }
const instance = 'fresh-instance'
const digest = (data: string) => createHash('sha256').update(data).digest('hex')
const artifacts = (root: string) => Promise.all(initializationPaths.map(path => readFile(join(root, path), 'utf8')))
async function provision(root: string) {
  // Dependencies are supplied by the test harness; the MCP tool never installs them.
  await provisionLocalSdk(root)
}
async function stdio(root: string, runtime = 'bun', env?: Record<string, string>) {
  const client = new Client({ name: 'initialization-contract', version: '1' })
  const transport = new StdioClientTransport({ command: runtime, args: [
    ...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
    resolve('packages/mcp/src/stdio.ts'), '--root', root,
  ], stderr: 'pipe', env: {
    ...(env ? { ...process.env, ...env } as Record<string, string> : {}),
    TMPDIR: tmpdir(),
    ...(process.env.WORKBASE_MCP_STATE_ROOT === undefined ? {} : { WORKBASE_MCP_STATE_ROOT: process.env.WORKBASE_MCP_STATE_ROOT }),
  } })
  let stderr = ''
  const responses: unknown[] = []
  transport.stderr?.on('data', data => { stderr += data.toString() })
  await client.connect(transport)
  return { client, responses, stderr: () => stderr, call: async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
    responses.push(response)
    const result = response.structuredContent as any
    expect(result, env ? undefined : stderr).toBeDefined()
    return result
  }, close: async () => { await client.close(); await transport.close() } }
}
async function isolatedSdk(root: string) {
  // Consumer sources have no producer node_modules fallback (review2 fixture).
  for (const name of ['core', 'plugins']) {
    await cp(resolve('packages', name), join(root, 'node_modules/@workbasehq', name), {
      recursive: true, filter: path => !['node_modules', 'test', 'ui'].includes(path.split('/').at(-1)!),
    })
  }
}
async function fixture() {
  const root = await empty()
  await bootstrapInstance(root, bootstrap)
  await provision(root)
  const app = await createServer({ root })
  const call = (name: string, args: Record<string, unknown>) => app.workflow.call(name, args) as Promise<any>
  const preview = () => call('initialize_instance', { instance, mode: 'preview' })
  const apply = (planHash: string) => call('initialize_instance', { instance, mode: 'apply', planHash })
  return { root, app, call, preview, apply }
}

// Include directory metadata so a transient lock or mkdir/unlink is observable.
async function tree(root: string): Promise<unknown> {
  const entries: unknown[] = []
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), stat = await lstat(path, { bigint: true })
    entries.push([name, stat.mode.toString(), stat.ino.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(),
      stat.isSymbolicLink() ? await readlink(path) : stat.isDirectory() ? await tree(path) : (await readFile(path)).toString('base64')])
  }
  return entries
}
it.each(['bun', 'node'])('keeps the entire instance tree identical across first, repeated and initialized %s previews', async runtime => {
  const root = await empty(), session = await stdio(root, runtime)
  try {
    expect(await session.call('bootstrap_instance', bootstrap)).toMatchObject({ ok: true })
    await provision(root)
    const before = await tree(root)
    const first = await session.call('initialize_instance', { instance, mode: 'preview' })
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true })
    expect(await tree(root)).toEqual(before)
    expect(await session.call('initialize_instance', { instance, mode: 'preview' })).toMatchObject({ ok: true, planHash: first.planHash })
    expect(await tree(root)).toEqual(before)
    expect(await session.call('initialize_instance', { instance, mode: 'apply', planHash: first.planHash })).toMatchObject({ ok: true, status: 'initialized' })
    // A read-only preview must not recreate even a missing proposals directory.
    await rm(join(root, 'proposals'), { recursive: true })
    const initialized = await tree(root)
    expect(await session.call('initialize_instance', { instance, mode: 'preview' })).toMatchObject({ ok: true })
    expect(await tree(root)).toEqual(initialized)
  } finally { await session.close() }
})
it.each(['bun', 'node'].flatMap(runtime => ['core', 'plugins'].map(packageName => [runtime, packageName])))
('rejects warm consumer %s resolution after removing the %s link and restores the original plan after relinking', async (runtime, packageName) => {
  const root = await empty()
  await bootstrapInstance(root, bootstrap)
  await provision(root)
  const session = await stdio(root, runtime)
  try {
    const first = await session.call('initialize_instance', { instance, mode: 'preview' })
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true })
    const link = join(root, 'node_modules/@workbasehq', packageName)
    await rm(link)
    const removed = await tree(root)
    for (const mode of ['preview', 'apply']) {
      expect(await session.call('initialize_instance', { instance, mode, ...(mode === 'apply' ? { planHash: first.planHash } : {}) }))
        .toMatchObject({ ok: false, error: { code: 'dependencies_missing', status: 422, details: { package: `@workbasehq/${packageName}` } } })
      expect(await tree(root)).toEqual(removed)
    }
    await symlink(join(root, 'node_modules/.sdk', packageName), link)
    const restored = await session.call('initialize_instance', { instance, mode: 'preview' })
    // The plan binds the dependency guards; relinking the same bytes must restore it.
    expect(restored).toMatchObject({ ok: true, planHash: first.planHash, files: first.files })
    expect(await session.call('initialize_instance', { instance, mode: 'apply', planHash: first.planHash })).toMatchObject({ ok: true, status: 'initialized' })
  } finally { await session.close() }
})
it.each(['bun', 'node'])('fails closed without writes for a missing transitive zod dependency under %s', async runtime => {
  const root = await empty()
  await bootstrapInstance(root, bootstrap)
  await isolatedSdk(root)
  const session = await stdio(root, runtime)
  try {
    const before = await tree(root)
    for (const mode of ['preview', 'apply']) {
      const result = await session.call('initialize_instance', { instance, mode, ...(mode === 'apply' ? { planHash: '0'.repeat(64) } : {}) })
      expect(result).toMatchObject({ ok: false, error: { code: 'dependencies_missing', status: 422, details: {
        reason: 'import_failed', entrypoint: '@workbasehq/core/kernel/registry', missingDependency: 'zod', remedy: expect.stringContaining('transitive'),
      } } })
      expect(await tree(root)).toEqual(before)
    }
  } finally { await session.close() }
})
it.each(['bun', 'node'].flatMap(runtime => ['early-exit', 'throw-secret', 'stderr-secret', 'forged-result', 'forged-missing', 'overflow'].map(failure => [runtime, failure])))
('fails closed without writes or secret output under %s with %s', async (runtime, failure) => {
  const root = await empty()
  await bootstrapInstance(root, bootstrap)
  await isolatedSdk(root)
  // A real SDK transitive import exits before the rest of the graph runs.
  // Supply the rest of the graph so missing modules cannot mask this fixture.
  for (const owner of ['core', 'plugins']) {
    const manifest = JSON.parse(await readFile(resolve('packages', owner, 'package.json'), 'utf8'))
    for (const name of Object.keys(manifest.dependencies).filter(name => name !== 'zod')) {
      const destination = join(root, 'node_modules', name)
      await mkdir(dirname(destination), { recursive: true })
      await symlink(await realpath(resolve('packages', owner, 'node_modules', name)), destination)
    }
  }
  const zod = join(root, 'node_modules/zod')
  await mkdir(zod, { recursive: true })
  await writeFile(join(zod, 'package.json'), JSON.stringify({ name: 'zod', type: 'module', exports: './index.js' }))
  const source: Record<string, string> = {
    'early-exit': 'process.exit(0)',
    'throw-secret': 'throw new Error(process.env.WB_PREFLIGHT_TEST_SECRET)',
    'stderr-secret': 'console.error(process.env.WB_PREFLIGHT_TEST_SECRET); process.exit(1)',
    'forged-result': `console.log(JSON.stringify({ status: 'complete', diagnostic: process.env.WB_PREFLIGHT_TEST_SECRET })); process.exit(0)`,
    'forged-missing': `throw Object.assign(new Error("Cannot find package '" + process.env.WB_PREFLIGHT_TEST_SECRET + "' imported from fixture"), { code: 'ERR_MODULE_NOT_FOUND' })`,
    'overflow': `await new Promise(resolve => process.stdout.write(process.env.WB_PREFLIGHT_TEST_SECRET.repeat(70000), resolve)); process.exit(1)`,
  }
  await writeFile(join(zod, 'index.js'), `export const z = {}; export class ZodError extends Error {}\n${source[failure]};\n`)
  const secret = ['wb166f2', 'synthetic', 'secret', randomUUID()].join('-')
  const session = await stdio(root, runtime, { WB_PREFLIGHT_TEST_SECRET: secret })
  try {
    const before = await tree(root)
    for (const mode of ['preview', 'apply']) {
      const result = await session.call('initialize_instance', { instance, mode, ...(mode === 'apply' ? { planHash: '0'.repeat(64) } : {}) })
      // Check the entire MCP envelope (text content as well as structuredContent).
      // Boolean assertions keep the synthetic secret out of failure logs too.
      expect(JSON.stringify(session.responses).includes(secret)).toBe(false)
      expect(session.stderr().includes(secret)).toBe(false)
      expect(result).toMatchObject({ ok: false, error: { code: 'dependencies_missing', status: 422, details: {
        reason: failure === 'throw-secret' || failure === 'forged-missing' ? 'import_failed' : failure === 'overflow' ? 'preflight_failed' : 'preflight_incomplete',
      } } })
      const details = result.error.details
      expect(Object.keys(details).sort()).toEqual(failure === 'throw-secret' || failure === 'forged-missing'
        ? ['entrypoint', 'reason', 'remedy', 'supportedVersion']
        : failure === 'overflow' ? ['reason', 'remedy'] : ['reason', 'remedy', 'supportedVersion'])
      expect(await tree(root)).toEqual(before)
    }
  } finally { await session.close() }
})
it.each(['bun', 'node'])('initializes and composes through real %s stdio in one session and after restart, without generators', async runtime => {
  const root = await empty()
  let session = await stdio(root, runtime)
  try {
    expect((await session.client.listTools()).tools.map(tool => tool.name)).toContain('initialize_instance')
    expect(await session.call('bootstrap_instance', bootstrap)).toMatchObject({ ok: true, nextStep: { tool: 'initialize_instance', arguments: { instance, mode: 'preview' } } })
    await provision(root)
    expect(await session.call('inspect_schema', { instance })).toMatchObject({ ok: false, error: { code: 'initialization_required', details: { nextStep: { tool: 'initialize_instance' } } } })
    await session.close()
    session = await stdio(root, runtime) // The incomplete scaffold must also start.
    expect(await session.call('validate', { instance })).toMatchObject({ ok: false, error: { code: 'initialization_required' } })
    const preview = await session.call('initialize_instance', { instance, mode: 'preview' })
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, mode: 'preview', conflicts: [] })
    expect(preview.files.map((file: any) => file.path)).toEqual(initializationPaths)
    for (const file of preview.files) expect(file.hash).toBe(digest(file.data))
    expect(await session.call('initialize_instance', { instance, mode: 'apply', planHash: preview.planHash })).toMatchObject({ ok: true, status: 'initialized' })
    expect(await artifacts(root)).toEqual(preview.files.map((file: any) => file.data))
    expect(await session.call('inspect_schema', { instance })).toMatchObject({ ok: true, revision: 1, validation: { ok: true } })
    expect(await session.call('initialize_instance', { instance, mode: 'apply', planHash: preview.planHash })).toMatchObject({ ok: true, status: 'unchanged', planHash: preview.planHash })
    await session.close()
    session = await stdio(root, runtime)
    expect(await session.call('inspect_schema', { instance })).toMatchObject({ ok: true, revision: 1, validation: { ok: true } })
    const preserved = ['config.ts', 'schema.lock.json', 'migrations/0001_r1.sql']
    const before = await Promise.all(preserved.map(path => readFile(join(root, path), 'utf8')))
    const proposal = await session.call('propose_composition', { instance, baseRevision: 1,
      changes: [{ kind: 'set_plugin', plugin: 'organizations', options: { allowCreate: true } }] })
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, kind: 'composition_change' })
    const args = { proposalId: proposal.proposalId }
    expect(await session.call('validate', args)).toMatchObject({ ok: true })
    expect(await session.call('preview_migration', args)).toMatchObject({ ok: true, sql: '' })
    expect(await session.call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await session.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    expect(await Promise.all(preserved.map(path => readFile(join(root, path), 'utf8')))).toEqual(before)
  } finally { await session.close() }
})

it('generates identical artifacts but binds plans to each canonical instance root', async () => {
  const a = await fixture(), b = await fixture()
  try {
    const first = await a.preview(), second = await b.preview()
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true })
    expect(second.files).toEqual(first.files)
    expect(second.planHash).not.toBe(first.planHash)
    expect(await a.apply(first.planHash)).toMatchObject({ ok: true })
    expect(await b.apply(second.planHash)).toMatchObject({ ok: true })
    expect(await artifacts(a.root)).toEqual(await artifacts(b.root))
  } finally { await a.app.server.close(); await b.app.server.close() }
})
it.each(['partial', 'different', 'other migration', 'invalid lock'])('reports %s artifacts without overwriting authored bytes', async kind => {
  const { root, app, preview, apply } = await fixture()
  try {
    const first = await preview()
    const path = kind === 'other migration' ? 'migrations/0020_authored.sql' : kind === 'invalid lock' ? 'schema.lock.json' : 'openapi.json'
    if (kind === 'different') expect(await apply(first.planHash)).toMatchObject({ ok: true })
    const data = kind === 'partial' ? first.files.find((file: any) => file.path === path).data : 'authored bytes\n'
    await writeFile(join(root, path), data)
    const next = await preview()
    expect(next, JSON.stringify(next)).toMatchObject({ ok: true, conflicts: expect.arrayContaining([path]) })
    expect(await apply(next.planHash)).toMatchObject({ ok: false, error: { code: 'initialization_conflict' } })
    expect(await readFile(join(root, path), 'utf8')).toBe(data)
    if (kind !== 'different') expect(await readdir(join(root, 'migrations'))).not.toContain('0001_r1.sql')
  } finally { await app.server.close() }
})
it.each(['config.ts', 'schema/worker.ts', 'access.ts', 'runtime.ts', 'package.json', 'bun.lock'])('rejects a stale preview after %s changes', async path => {
  const { root, app, preview, apply } = await fixture()
  try {
    const first = await preview()
    const original = await readFile(join(root, path), 'utf8').catch(() => '')
    await writeFile(join(root, path), original + (path.endsWith('.json') || path === 'bun.lock' ? '\n' : '\n// authored edit\n'))
    expect(await apply(first.planHash)).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
    expect(await readdir(join(root, 'migrations'))).toEqual(['.gitkeep'])
  } finally { await app.server.close() }
})
it.each(['bun', 'node'].flatMap(runtime => ['@workbasehq/core', '@workbasehq/plugins'].map(packageName => [runtime, packageName])))('returns actionable missing diagnostics under %s for %s after restarting an incomplete scaffold', async (runtime, packageName) => {
  const root = await empty()
  await bootstrapInstance(root, bootstrap)
  if (packageName === '@workbasehq/plugins') {
    await mkdir(join(root, 'node_modules/@workbasehq'), { recursive: true })
    await cp(resolve('packages/core'), join(root, 'node_modules/@workbasehq/core'), { recursive: true, filter: path => !['node_modules', 'test'].includes(path.split('/').at(-1)!) })
  }
  const session = await stdio(root, runtime)
  try {
    const before = await tree(root)
    for (const mode of ['preview', 'apply']) {
      expect(await session.call('initialize_instance', { instance, mode, ...(mode === 'apply' ? { planHash: '0'.repeat(64) } : {}) })).toMatchObject({ ok: false, error: { code: 'dependencies_missing', details: { package: packageName, remedy: expect.stringContaining('node_modules') } } })
      expect(await tree(root)).toEqual(before)
    }
    expect(await readdir(join(root, 'migrations'))).toEqual(['.gitkeep'])
  } finally { await session.close() }
})
it('rejects incompatible dependencies without loading their executable entrypoint', async () => {
  const root = await empty()
  await bootstrapInstance(root, bootstrap)
  const core = join(root, 'node_modules/@workbasehq/core')
  await mkdir(core, { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@workbasehq/core', version: '0.0.0', exports: { './schema': './schema.ts' } }))
  await writeFile(join(core, 'schema.ts'), "throw new Error('must never execute')")
  const session = await stdio(root)
  try {
    expect(await session.call('initialize_instance', { instance })).toMatchObject({ ok: false, error: { code: 'dependencies_missing', details: { package: '@workbasehq/core' } } })
  } finally { await session.close() }
})
it('requires a preview hash and rejects custom runtime expressions without executing them', async () => {
  const { root, app, call, preview } = await fixture()
  try {
    expect(await call('initialize_instance', { instance, mode: 'apply' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    await writeFile(join(root, 'runtime.ts'), "throw new Error('must never execute')\n")
    expect(await preview()).toMatchObject({ ok: false, error: { code: 'runtime_not_canonical' } })
    expect(await readdir(join(root, 'migrations'))).toEqual(['.gitkeep'])
  } finally { await app.server.close() }
})
it('rejects unsafe artifacts, invalid declarations, ID mismatch and allowlist mismatch', async () => {
  const { root, app, preview } = await fixture()
  try {
    await symlink(join(root, 'config.ts'), join(root, 'schema.lock.json'))
    expect(await preview()).toMatchObject({ ok: false, error: { code: 'unsafe_path' } })
    await rm(join(root, 'schema.lock.json'))
    const source = await readFile(join(root, 'config.ts'), 'utf8')
    await writeFile(join(root, 'config.ts'), source.replace("id: 'fresh_instance'", "id: 'different'"))
    expect(await preview()).toMatchObject({ ok: false, error: { code: 'invalid_instance_id' } })
    await writeFile(join(root, 'config.ts'), source.replace("entities: { worker }", "entities: { worker: (() => { throw new Error('must never execute') })() }"))
    expect(await preview()).toMatchObject({ ok: false, error: { code: 'invalid_access' } })
    await writeFile(join(root, 'config.ts'), source)
    await expect(createServer({ root, allowed: ['different'] })).rejects.toMatchObject({ code: 'invalid_allowlist' })
  } finally { await app.server.close() }
})
it('serializes concurrent initializations under the canonical instance lock', async () => {
  const { root, app, preview, apply } = await fixture()
  const other = await createServer({ root })
  try {
    const first = await preview()
    const results = await Promise.all([apply(first.planHash), other.workflow.call('initialize_instance', { instance, mode: 'apply', planHash: first.planHash })])
    expect(results.some(result => result.ok === true)).toBe(true)
    for (const result of results) expect(result.ok === true ? ['initialized', 'unchanged'] : ['instance_busy']).toContain(result.ok === true ? result.status : (result.error as any).code)
    expect(await artifacts(root)).toEqual(first.files.map((file: any) => file.data))
  } finally { await app.server.close(); await other.server.close() }
})
it('recovers an interrupted five-file initialization before rediscovery and reapplication', async () => {
  const { root, app, preview, apply } = await fixture()
  try {
    const first = await preview()
    // Exit after all destinations are linked but before the durable journal retires.
    const script = `import { createServer } from ${JSON.stringify(resolve('packages/mcp/src/server.ts'))};
const app = await createServer({root:${JSON.stringify(root)}});
const commit = app.store.commit.bind(app.store);
app.store.commit = (instance, files, guards) => commit(instance, files, guards, async () => process.exit(73));
await app.workflow.call('initialize_instance', {instance:${JSON.stringify(instance)}, mode:'apply', planHash:${JSON.stringify(first.planHash)}});`
    const child = spawnSync('bun', ['--no-install', '--eval', script], { encoding: 'utf8', env: process.env })
    expect(child.status, child.stderr).toBe(73)
    expect(await readdir(join(root, 'proposals'))).toContain('.promotion.json')
    const restarted = await createServer({ root })
    try {
      for (const path of initializationPaths) await expect(readFile(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await restarted.workflow.call('inspect_schema', { instance })).toMatchObject({ ok: false, error: { code: 'initialization_required' } })
      expect(await apply(first.planHash)).toMatchObject({ ok: true, status: 'initialized' })
    } finally { await restarted.server.close() }
  } finally { await app.server.close() }
})
it.each(['source', 'dependencies', 'internal origin', 'outside origin'])('rolls back all artifacts when %s change during guarded publication', async change => {
  const { root, app, preview, apply } = await fixture()
  try {
    const first = await preview()
    const commit = app.store.commit.bind(app.store)
    app.store.commit = (instance, files, guards, verify) => commit(instance, files, guards, async () => {
      if (change === 'source') await writeFile(join(root, 'config.ts'), await readFile(join(root, 'config.ts'), 'utf8') + '\n// concurrent author\n')
      else if (change === 'dependencies') await rm(join(root, 'node_modules'), { recursive: true })
      else {
        const target = change === 'internal origin' ? join(root, 'node_modules/.sdk/plugins-next') : join(await empty(), 'plugins')
        await cp(join(root, 'node_modules/.sdk/plugins'), target, { recursive: true })
        await rm(join(root, 'node_modules/@workbasehq/plugins'))
        await symlink(target, join(root, 'node_modules/@workbasehq/plugins'))
      }
      await verify?.()
    })
    expect(await apply(first.planHash)).toMatchObject({ ok: false, error: { code: change === 'source' ? 'concurrent_modification' : change === 'internal origin' ? 'stale_plan' : 'dependencies_missing' } })
    for (const path of initializationPaths) await expect(readFile(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(root, 'proposals'))).not.toContain('.promotion.json')
  } finally { await app.server.close() }
})

it('shares the read-only planner with the default tool and returns byte-exact five-artifact previews', async () => {
  const { root, app, preview, apply } = await fixture()
  try {
    const before = await tree(root)
    const planned = await planInitialization(root, instance)
    const tool = await preview()
    expect(tool).toMatchObject({ ok: true, planHash: planned.planHash, files: planned.files, conflicts: [] })
    expect(planned.files.map(file => file.path)).toEqual(initializationPaths)
    for (const file of planned.files) expect(file.hash).toBe(digest(file.data))
    expect(await tree(root)).toEqual(before)
    expect(await apply(tool.planHash)).toMatchObject({ ok: true, status: 'initialized' })
    expect(await artifacts(root)).toEqual(planned.files.map(file => file.data))
    expect(await apply(tool.planHash)).toMatchObject({ ok: true, status: 'unchanged', planHash: planned.planHash })
  } finally { await app.server.close() }
})

// Exercise the actual Bun child through MCP; existing stdio controls also cover Node/tsx.
it.each(['ancestor-only', 'mixed', 'package-link', 'entrypoint-link', 'manifest-link', 'node-modules-link', 'sibling-prefix'])
('rejects %s origins before any selected consumer import and leaves no artifacts or lock metadata', async kind => {
  const parent = await empty(), root = join(parent, 'inst'), outside = join(parent, 'inst-other')
  await mkdir(root); await mkdir(outside)
  await bootstrapInstance(root, bootstrap)
  const marker = join(parent, 'selected-imports')
  await provisionProbeSdk(root, marker); await provisionProbeSdk(outside, marker)
  const sdk = (base: string, owner = 'plugins') => join(base, 'node_modules/@workbasehq', owner)
  if (kind === 'ancestor-only' || kind === 'mixed') {
    await cp(join(outside, 'node_modules'), join(parent, 'node_modules'), { recursive: true })
    await rm(kind === 'ancestor-only' ? join(root, 'node_modules') : sdk(root), { recursive: true })
  } else if (kind === 'node-modules-link') {
    await rm(join(root, 'node_modules'), { recursive: true })
    await symlink(join(outside, 'node_modules'), join(root, 'node_modules'))
  } else if (kind === 'entrypoint-link' || kind === 'manifest-link') {
    const file = kind === 'entrypoint-link' ? 'index.js' : 'package.json'
    await rm(join(sdk(root), file))
    await symlink(join(sdk(outside), file), join(sdk(root), file))
  } else {
    const destination = kind === 'sibling-prefix' ? join(outside, 'plugins') : sdk(outside)
    if (kind === 'sibling-prefix') await cp(sdk(outside), destination, { recursive: true })
    await rm(sdk(root), { recursive: true })
    await symlink(destination, sdk(root))
  }
  const session = await stdio(root)
  try {
    const before = await tree(root)
    for (const mode of ['preview', 'apply']) {
      const result = await session.call('initialize_instance', { instance, mode, ...(mode === 'apply' ? { planHash: '0'.repeat(64) } : {}) })
      expect(result).toMatchObject({ ok: false, error: { code: 'dependencies_missing', status: 422,
        details: { remedy: expect.stringContaining('locally') } } })
      expect(JSON.stringify(result)).not.toContain(parent)
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await tree(root)).toEqual(before)
    }
  } finally { await session.close() }
})
it('accepts internal entrypoint and manifest links with a canonical instance-root alias', async () => {
  const parent = await empty(), root = join(parent, 'inst'), alias = join(parent, 'alias')
  await mkdir(root); await symlink(root, alias)
  await bootstrapInstance(root, bootstrap)
  const marker = join(parent, 'selected-imports')
  await provisionProbeSdk(root, marker)
  const plugins = join(root, 'node_modules/@workbasehq/plugins')
  for (const name of ['index.js', 'package.json']) {
    await cp(join(plugins, name), join(plugins, 'linked-' + name))
    await rm(join(plugins, name))
    await symlink(join(plugins, 'linked-' + name), join(plugins, name))
  }
  const model = parseRuntimeSource(await readFile(join(root, 'runtime.ts'), 'utf8'))
  const first = await initializationDependencies(alias, model)
  expect(await initializationDependencies(root, model)).toEqual(first)
  expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['core', 'plugins', 'core', 'plugins'])
})
it.each(['package', 'entrypoint', 'manifest'])('requires a fresh preview after an identical-byte internal %s origin swap', async kind => {
  const { root, app, preview, apply } = await fixture()
  try {
    const first = await preview(), plugins = join(root, 'node_modules/.sdk/plugins')
    if (kind === 'package') {
      await cp(plugins, join(root, 'node_modules/.sdk/plugins-next'), { recursive: true })
      await rm(join(root, 'node_modules/@workbasehq/plugins'))
      await symlink(join(root, 'node_modules/.sdk/plugins-next'), join(root, 'node_modules/@workbasehq/plugins'))
    } else {
      const path = join(plugins, kind === 'manifest' ? 'package.json' : 'permissions/src/index.ts')
      await cp(path, path + '.copy' + (kind === 'entrypoint' ? '.ts' : '.json'))
      await rm(path); await symlink(path + '.copy' + (kind === 'entrypoint' ? '.ts' : '.json'), path)
    }
    expect(await apply(first.planHash)).toMatchObject({ ok: false, error: { code: 'stale_plan' } })
    for (const path of initializationPaths) await expect(readFile(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
    const fresh = await preview()
    expect(fresh.files).toEqual(first.files)
    expect(fresh.planHash).not.toBe(first.planHash)
    expect(await apply(fresh.planHash)).toMatchObject({ ok: true, status: 'initialized' })
  } finally { await app.server.close() }
})
it('rejects an outside-origin swap after preview before any apply import or lock metadata', async () => {
  const root = await empty(), outside = await empty(), marker = join(outside, 'selected-imports')
  await bootstrapInstance(root, bootstrap)
  await provisionProbeSdk(root, marker); await provisionProbeSdk(outside, marker)
  const session = await stdio(root)
  try {
    const first = await session.call('initialize_instance', { instance, mode: 'preview' })
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true })
    expect(await readFile(marker, 'utf8')).toContain('core')
    await rm(marker)
    await rm(join(root, 'node_modules/@workbasehq/plugins'), { recursive: true })
    await symlink(join(outside, 'node_modules/@workbasehq/plugins'), join(root, 'node_modules/@workbasehq/plugins'))
    const before = await tree(root)
    expect(await session.call('initialize_instance', { instance, mode: 'apply', planHash: first.planHash }))
      .toMatchObject({ ok: false, error: { code: 'dependencies_missing', status: 422 } })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await tree(root)).toEqual(before)
  } finally { await session.close() }
})
