import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { DatabaseSync } from 'node:sqlite'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { CORE_VERSION } from '@workbasehq/core/config'
import { execute } from '../src/sdk-process'
import { captureSdkInputs, runSdkTarget } from '../src/sdk-target'
import { acceptUpgradeResult, BRIDGE_VERSION, bridgeDigest, bridgeFiles, consumerModules, digestBytes, preparedSchema, resultSchema, type UpgradeRequest, type UpgradeStage } from '../src/sdk-upgrade-protocol'

const fixture = resolve('packages/mcp/test/fixtures/sdk-upgrade/valid-0.2.9')
const source = resolve('packages/mcp/src'), checkout = resolve('.')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) cleanupTempDir(root) })
const hashes = (inputs: Record<string, Buffer>) => Object.fromEntries(Object.entries(inputs).map(([path, bytes]) => [path, digestBytes(bytes)]))
const base = { instanceId: 'sdk_upgrade_fixture', baseRevision: 1, baseFingerprint: 'a'.repeat(64), baseDependencyDigest: 'b'.repeat(64) }
async function scratch() { const directory = registerTempDir(await mkdtemp(join(tmpdir(), 'sdk-worker-test-'))); roots.push(directory); return await realpath(directory) }
async function legacyHistory(root: string) {
  const path = join(root, 'config.versions.json'), history = JSON.parse(await readFile(path, 'utf8'))
  history[0].config.plugins = [
    { name: 'identity', version: '0.1.0', provides: { identity: '1.x' } },
    { name: 'rbac', version: '0.1.0', provides: { permissions: '1.x' } },
    { name: 'tenancy', version: '0.1.0', provides: { organizations: '1.x' }, requires: { identity: '^1' } },
  ]
  await writeFile(path, JSON.stringify(history, null, 2) + '\n')
}

// The closed-world SDK proof forbids all installs. This one registry test runs in
// the ordinary focused/MCP gates; every other case remains offline in that proof.
it.skipIf(process.env.BUN_CONFIG_SKIP_INSTALL_PACKAGES === '1')('executes the candidate bridge against published 0.2.10 with historical rbac and tenancy, SQL, target schema/plugins and bound hashes', async () => {
  const instance = join(await scratch(), 'instance')
  await cp(fixture, instance, { recursive: true })
  await legacyHistory(instance)
  const manifest = JSON.parse(await readFile(join(instance, 'package.json'), 'utf8'))
  manifest.dependencies.zod = '4.6.7'
  manifest.scripts = { postinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran','bad')\"" }
  await writeFile(join(instance, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(instance, 'config.ts'), (await readFile(join(instance, 'config.ts'), 'utf8'))
    + "\nimport { existsSync } from 'node:fs'\nif (existsSync(new URL('./lifecycle-ran', import.meta.url))) throw new Error('Lifecycle script executed')\n")
  const inputs = await captureSdkInputs(instance)
  const proof = await runSdkTarget({ instanceRoot: instance, checkoutRoot: checkout, targetVersion: '0.2.10', inputs, base,
    readBase: async () => ({ baseFingerprint: base.baseFingerprint, baseDependencyDigest: base.baseDependencyDigest }) })
  expect(proof.result.coreVersion).toBe('0.2.10')
  expect(proof.result.marker).toEqual({ version: '0.2.10', revision: 1 })
  expect(proof.result.packages.map(pkg => [pkg.name, pkg.version])).toEqual([
    ['@workbasehq/core', '0.2.10'], ['@workbasehq/plugins', '0.2.10'], ['@workbasehq/mcp', '0.2.10'],
  ])
  for (const pkg of proof.result.packages) {
    expect(pkg.directory).toContain('/workbase-sdk-target-')
    expect(pkg.directory).not.toContain(checkout)
    await expect(lstat(pkg.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(proof.result.schema.expected).toBe(proof.result.schema.applied)
  expect(proof.result.plugins.expected).toBe(proof.result.plugins.applied)
  expect(proof.archives).toHaveLength(3); expect(proof.installed).toHaveLength(3)
  expect(proof.result.inputHashes['config.ts']).toBe(digestBytes(inputs['config.ts']))
  expect(proof.result.inputHashes['config.indexes.json']).toBe(digestBytes(inputs['config.indexes.json']))
  expect(JSON.parse(proof.artifacts['package.json'].bytes.toString()).dependencies.zod).toBe('4.6.7')
  // The parent checks the consumer's entire captured input set as well. A script
  // must not create a side effect; inspect it before consumer cleanup via config.
  expect(proof.targetDependencyDigest).not.toBe(base.baseDependencyDigest)
  for (const artifact of Object.values(proof.artifacts)) expect(artifact.sha256).toBe(digestBytes(artifact.bytes))
  expect(hashes(await captureSdkInputs(instance))).toEqual(hashes(inputs))
}, 300000)

// Offline tests copy the current SDK sources and the few dependencies they load.
// No network, producer module resolution or target MCP handler is involved.
async function localConsumer(legacy = false, loader = false) {
  const root = await scratch()
  await cp(fixture, root, { recursive: true })
  for (const name of ['core', 'plugins', 'mcp']) {
    const directory = join(root, 'node_modules/@workbasehq', name)
    await cp(resolve('packages', name), directory, { recursive: true,
      filter: path => !path.split('/').some(part => ['node_modules', 'test', 'dev', 'templates'].includes(part)) })
  }
  const require = createRequire(join(checkout, 'packages/core/package.json'))
  const copied = new Set<string>()
  const copyDependency = async (name: string, from = require) => {
    if (copied.has(name)) return
    copied.add(name)
    let entry: string
    try { entry = from.resolve(`${name}/package.json`) } catch { entry = from.resolve(name) }
    let directory = dirname(await realpath(entry))
    while (true) {
      try { if (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name === name) break } catch { /* ascend */ }
      const parent = dirname(directory); if (parent === directory) throw new Error(`Missing ${name}`); directory = parent
    }
    await cp(directory, join(root, 'node_modules', name), { recursive: true, filter: path => !path.slice(directory.length).split('/').includes('node_modules') })
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyDependency(dependency, createRequire(join(directory, 'package.json')))
    if (name === 'esbuild') await copyDependency(`@esbuild/${process.platform}-${process.arch}`, createRequire(join(directory, 'package.json')))
  }
  for (const name of ['zod', 'hono', '@jakub.knejzlik/ts-query']) await copyDependency(name)
  if (legacy) await copyDependency('better-auth', createRequire(join(checkout, 'packages/plugins/package.json')))
  if (loader) await copyDependency('tsx', createRequire(join(checkout, 'packages/mcp/package.json')))
  // Resolution-only tools: offline cases replay local SQLite rather than Wrangler.
  for (const name of ['tsx', 'wrangler']) {
    if (name === 'tsx' && loader) continue
    const directory = join(root, 'node_modules', name)
    await mkdir(join(directory, 'bin'), { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    await writeFile(join(directory, 'index.js'), '')
    await writeFile(join(directory, 'bin/wrangler.js'), '')
  }
  await mkdir(join(root, '.sdk-bridge'))
  for (const name of bridgeFiles) await cp(join(source, name), join(root, '.sdk-bridge', name))
  return root
}
async function requestFor(root: string, stage?: UpgradeStage): Promise<UpgradeRequest> {
  const inputs = await captureSdkInputs(root)
  if (stage) delete inputs[stage.marker.path]
  return { action: stage ? 'verify' : 'prepare', identity: { ...base, targetVersion: CORE_VERSION, runId: randomUUID(), bridgeVersion: BRIDGE_VERSION,
    bridgeDigest: await bridgeDigest(join(root, '.sdk-bridge')) }, inputHashes: hashes(inputs), ...(stage ? { stage } : {}) }
}
async function bridge(root: string, request: UpgradeRequest) {
  const { runBridge } = await import('../src/sdk-upgrade-worker')
  return runBridge(root, request)
}
async function preparedDatabase(root: string) {
  const request = await requestFor(root)
  const prepared = preparedSchema.parse(await bridge(root, request))
  const directory = join(root, '.sdk-bridge/persist/v3/d1')
  await mkdir(directory, { recursive: true })
  const database = join(directory, '0'.repeat(64) + '.sqlite')
  const db = new DatabaseSync(database)
  try { db.exec(await readFile(join(root, '.sdk-bridge/replay.sql'), 'utf8')) } finally { db.close() }
  return { request: { ...request, action: 'verify' as const, stage: prepared.stage }, database }
}

it('verifies local target migrations and rejects unbound/unknown child result fields', async () => {
  const root = await localConsumer(), { request } = await preparedDatabase(root)
  const result = resultSchema.parse(await bridge(root, request)), modules = await consumerModules(root)
  expect(acceptUpgradeResult(result, request, modules.packages, modules.resolutions).schema.status).toBe('pass')
  for (const changed of [
    { ...result, identity: { ...result.identity, runId: randomUUID() } },
    { ...result, inputHashes: { ...result.inputHashes, 'config.ts': '0'.repeat(64) } },
    { ...result, marker: { ...result.marker, version: '0.2.9' } },
    { ...result, resolutions: { ...result.resolutions, '@workbasehq/core/config': '/producer/config.ts' } },
    { ...result, accepted: true },
  ]) expect(() => acceptUpgradeResult(changed, request, modules.packages, modules.resolutions)).toThrow()
})
it('rejects invalid target configuration', async () => {
  const root = await localConsumer()
  await writeFile(join(root, 'config.ts'), "export default { id: 'broken', entities: {} }\n")
  await expect(bridge(root, await requestFor(root))).rejects.toThrow()
})
it('prepares historical rbac and tenancy through consumer-resolved target exports', async () => {
  const root = await localConsumer()
  await legacyHistory(root)
  expect(preparedSchema.parse(await bridge(root, await requestFor(root))).kind).toBe('prepared')
})
it.each(['unknown-plugin', 'toString', 'constructor', '__proto__'])('rejects unknown historical descriptor %s', async name => {
  const root = await localConsumer(), path = join(root, 'config.versions.json')
  const history = JSON.parse(await readFile(path, 'utf8'))
  history[0].config.plugins = [{ name, version: '0.1.0' }]
  await writeFile(path, JSON.stringify(history))
  await expect(bridge(root, await requestFor(root))).rejects.toThrow(`Unsupported historical plugin: ${name}`)
})
it('rejects imports escaping the consumer, including absolute SDK imports', async () => {
  const root = await localConsumer(false, true)
  const outside = join(await scratch(), 'escape.mjs')
  await writeFile(outside, 'export default 123\n')
  await writeFile(join(root, 'config.ts'), `import external from ${JSON.stringify(outside)}\nexport default external\n`)
  await writeFile(join(root, '.sdk-bridge/request.json'), JSON.stringify(await requestFor(root)))
  const modules = await consumerModules(root)
  const result = await execute([process.execPath, '--import', modules.resolutions.tsx, join(root, '.sdk-bridge/sdk-upgrade-worker.ts')], root,
    { timeoutMs: 15000, maxOutputBytes: 65536 })
  expect(result.rc).not.toBe(0)
  expect(result.stderr).toContain('outside consumer')
})
it('keeps the incompatible historical configuration as a failure', async () => {
  const root = await localConsumer(true)
  await cp(resolve('scripts/test/fixtures/sdk-0.2.1-revision-3/config.ts'), join(root, 'config.ts'))
  await expect(bridge(root, await requestFor(root))).rejects.toThrow(/displayField/)
})
it('rejects failed historical SQL and migration sequence gaps', async () => {
  const root = await localConsumer()
  await writeFile(join(root, 'migrations/0001_initial.sql'), 'THIS IS NOT SQL;\n')
  await expect(bridge(root, await requestFor(root))).rejects.toThrow()
  const gap = await localConsumer()
  await writeFile(join(gap, 'migrations/0003_gap.sql'), 'SELECT 1;\n')
  await expect(bridge(gap, await requestFor(gap))).rejects.toThrow(/sequence/)
})
it('rejects target plugin migration failures', async () => {
  const root = await localConsumer()
  const config = await readFile(join(root, 'config.ts'), 'utf8')
  await writeFile(join(root, 'config.ts'), config.replace('plugins: [', "plugins: [{name:'broken',version:'1.0.0',migrations:[{name:'bad',sql:'THIS IS NOT SQL;'}]},"))
  const { request } = await preparedDatabase(root)
  await expect(bridge(root, request)).rejects.toThrow()
})
it('rejects physical schema/index drift requiring repair', async () => {
  const root = await localConsumer(), { request, database } = await preparedDatabase(root)
  const db = new DatabaseSync(database)
  try { db.exec('DROP INDEX notes_title_idx') } finally { db.close() }
  await expect(bridge(root, request)).rejects.toThrow(/physical schema/)
})
it('rejects wrong marker before the target migration engine can repair its stamp', async () => {
  const root = await localConsumer(), { request, database } = await preparedDatabase(root)
  const db = new DatabaseSync(database)
  try { db.exec("UPDATE instance_meta SET core_version='0.2.9'") } finally { db.close() }
  await expect(bridge(root, request)).rejects.toThrow(/Wrong replayed target marker/)
})
it('rejects changed config/history/index/SQL bytes and candidate bridge source', async () => {
  for (const path of ['config.ts', 'config.versions.json', 'config.indexes.json', 'migrations/0001_initial.sql', '.sdk-bridge/sdk-upgrade-worker.ts']) {
    const root = await localConsumer(), request = await requestFor(root)
    await writeFile(join(root, path), (await readFile(join(root, path), 'utf8')) + '\n')
    await expect(bridge(root, request)).rejects.toThrow(/Changed bridge input|source digest/)
  }
})
