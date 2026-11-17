import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execute } from './sdk-process.ts'
import { bindSchemaLock } from '@workbasehq/core/schema'
import { isLiteralConfig, loadConfig } from '@workbasehq/core/schema/load'
import { plan } from '@workbasehq/core/migrations/schema-plan'
import { generate } from '@workbasehq/core/openapi/generate'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { serializeAccessLock } from '@workbasehq/core/access/lock'
import metadata from '../package.json' with { type: 'json' }
import type { Store } from './storage.ts'
import { WorkflowError, instanceSelector, fail } from './schemas.ts'
import { noLink } from './paths.ts'
import { hash } from './planning.ts'
import { replaySources } from './replay-sources.ts'
import { parseRuntimeSource, type RuntimeModel } from './composition/runtime-source.ts'
import { hydrateRuntimePlugins } from './composition/registry.ts'

export const initializationPaths = ['schema.lock.json', 'migrations/0001_r1.sql', 'openapi.json', 'access.lock.json', 'access.lock.md'] as const
const nextStep = (instance: string) => ({ tool: 'initialize_instance', arguments: { instance, mode: 'preview' } })
async function bytes(root: string, path: string) {
  await noLink(join(root, path), true)
  try { return await readFile(join(root, path), { flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** Incomplete declarations remain discoverable, but normal config operations never import them. */
export async function assertInitialized(root: string, instance: string) {
  if (!isLiteralConfig(join(root, 'config.ts'))) return
  const required = ['schema.lock.json', 'openapi.json']
  // An unbound V3 config may intentionally omit OpenAPI. Preserve that opt-in.
  const source = await readFile(join(root, 'config.ts'), 'utf8')
  const missing = []
  for (const path of required) {
    if (path === 'openapi.json' && !source.includes('./openapi.json')) continue
    if (await bytes(root, path) === null) missing.push(path)
  }
  if (missing.length) throw new WorkflowError('initialization_required', 'Initialize this fresh V3 instance before configuration operations', 409,
    { missing, nextStep: nextStep(instance) })
}

/** Check the installed consumer graph without importing authored config or installing.
 * A fresh process prevents module caches from hiding removed transitive dependencies. */
async function dependencies(root: string, model: RuntimeModel) {
  const require = createRequire(join(root, 'package.json'))
  const result: Record<string, string> = {}
  const imports: Record<string, string> = {}
  for (const [packageName, entrypoints] of [
    ['@workbasehq/core', ['schema', 'kernel/registry']],
    ['@workbasehq/plugins', model.plugins.map(({ plugin }) => plugin)],
  ] as const) {
    try {
      for (const entry of [...new Set(entrypoints)].sort()) {
        const path = require.resolve(`${packageName}/${entry}`)
        imports[`${packageName}/${entry}`] = pathToFileURL(path).href
        let directory = dirname(path)
        let manifest: Buffer | undefined
        while (true) {
          const candidate = await bytes(directory, 'package.json')
          if (candidate && JSON.parse(candidate.toString()).name === packageName) { manifest = candidate; break }
          const parent = dirname(directory)
          if (parent === directory) throw new Error('Package metadata missing')
          directory = parent
        }
        const version = JSON.parse(manifest.toString()).version
        if (version !== metadata.version) throw new Error(`Installed version ${String(version)} is incompatible`)
        result[`${packageName}/package.json`] = hash(manifest.toString('base64'))
        result[`${packageName}/${entry}`] = hash((await readFile(path)).toString('base64'))
      }
    } catch {
      throw new WorkflowError('dependencies_missing', `${packageName}@${metadata.version} must be available from the instance root`, 422,
        { package: packageName, supportedVersion: metadata.version, remedy: `Provision ${packageName}@${metadata.version} in this instance's node_modules, then retry initialize_instance preview. No packages were installed.` })
    }
  }
  const script = `for (const [entrypoint, url] of Object.entries(${JSON.stringify(imports)})) {
    try { await import(url) }
    catch (error) { console.log(JSON.stringify({ entrypoint, diagnostic: String(error) })); process.exit(1) }
  }`
  try {
    const runtime = process.versions.bun ? ['--no-install'] : ['--import', createRequire(import.meta.url).resolve('tsx')]
    const checked = await execute([process.execPath, ...runtime, '--input-type=module', '--eval', script], root,
      { timeoutMs: 30000, maxOutputBytes: 65536, env: { ...process.env, TSX_DISABLE_CACHE: '1' } })
    if (checked.rc !== 0) {
      let diagnostic: Record<string, unknown>
      try { diagnostic = JSON.parse(checked.stdout) }
      catch { diagnostic = { diagnostic: checked.timedOut ? 'Dependency import timed out' : checked.stderr.slice(0, 4000) } }
      throw new WorkflowError('dependencies_missing', 'The installed SDK runtime dependency graph cannot be imported', 422,
        { ...diagnostic, supportedVersion: metadata.version,
          remedy: `Provision the complete dependencies of @workbasehq/core@${metadata.version} and @workbasehq/plugins@${metadata.version}, including transitive packages named in the diagnostic, in this instance's node_modules; retry initialize_instance preview. No packages were installed.` })
    }
  } catch (error) {
    if (error instanceof WorkflowError) throw error
    throw new WorkflowError('dependencies_missing', 'Unable to verify the installed SDK runtime dependency graph', 422,
      { diagnostic: String(error), remedy: 'Ensure the local runtime and the complete SDK dependencies are available, then retry initialize_instance preview. No packages were installed.' })
  }
  return result
}

async function snapshot(root: string) {
  const inputs = await replaySources(root, { accessLock: true })
  for (const name of (await readdir(root)).filter(name => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(name)).sort()) {
    inputs[name] = (await bytes(root, name))!
  }
  const migrations = (await readdir(join(root, 'migrations'))).filter(name => name !== '.gitkeep').sort()
  for (const name of migrations) inputs[`migrations/${name}`] = (await bytes(root, `migrations/${name}`))!
  const guards: Record<string, string | null> = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, data]) => [path, hash(data.toString('utf8'))]))
  for (const path of ['package.json', 'bun.lock']) {
    const data = await bytes(root, path)
    guards[path] = data === null ? null : hash(data.toString('base64'))
  }
  for (const path of initializationPaths) guards[path] ??= null
  return { inputs, guards, migrations }
}

export async function initializeInstance(store: Store, instance: string, input: { mode: 'preview' | 'apply'; planHash?: string }) {
  const root = await store.directory(instance, true)
  const run = async () => {
    const before = await snapshot(root)
    if (!isLiteralConfig(join(root, 'config.ts'))) fail('initialization_unsupported', 'initialize_instance supports fresh literal V3 declarations only', 422)
    const loaded = await loadConfig(join(root, 'config.ts'), { bindExistingLock: false })
    if (instanceSelector(loaded.config.id) !== instance) fail('invalid_instance_id', 'Config id does not match the selected instance', 409)
    const runtimeSource = before.inputs['runtime.ts']
    if (!runtimeSource) fail('runtime_not_canonical', 'Fresh initialization requires canonical runtime.ts', 422)
    const model = parseRuntimeSource(runtimeSource.toString('utf8'))
    const dependencyGuards = await dependencies(root, model)
    const schema = await plan({ config: loaded.config, sources: loaded.sources, baseMigrations: {} })
    if (!schema.bundle || schema.bundle.filename !== '0001_r1.sql') fail('initialization_unsupported', 'Fresh initialization requires the first domain revision', 422)
    bindSchemaLock(loaded.config, JSON.parse(schema.lock))
    const domain = new KernelRegistry(loaded.config)
    const runtime = new KernelRegistry({ ...loaded.config, ...(model.interactive === undefined ? {} : { interactive: model.interactive }), plugins: hydrateRuntimePlugins(model, loaded.config) })
    const access = serializeAccessLock(runtime, { root, sources: loaded.sources })
    const artifacts = [schema.lock, schema.bundle.sql, generate(domain.config, domain, loaded.configHash), access.json, access.md]
    const files = initializationPaths.map((path, i) => ({ path, data: artifacts[i], hash: hash(artifacts[i]),
      status: before.inputs[path] === undefined ? 'create' : before.inputs[path].equals(Buffer.from(artifacts[i])) ? 'unchanged' : 'conflict' }))
    const existing = files.filter(file => file.status !== 'create')
    const conflicts = [
      ...files.filter(file => file.status === 'conflict').map(file => file.path),
      ...(existing.length > 0 && existing.length < files.length ? existing.map(file => file.path) : []),
      ...before.migrations.filter(name => name !== '0001_r1.sql').map(name => `migrations/${name}`),
    ].filter((path, index, paths) => paths.indexOf(path) === index).sort()
    // Outputs are verified separately. This lets a completed matching plan be safely reapplied.
    const sourceGuards = Object.fromEntries(Object.entries(before.guards).filter(([path]) => !initializationPaths.some(output => output === path)))
    const planHash = hash({ version: 1, instance, sources: sourceGuards, dependencies: dependencyGuards, files: files.map(({ path, hash }) => ({ path, hash })) })
    const report = { ok: true, instance, planHash, files, conflicts, nextStep: { tool: 'inspect_schema', arguments: { instance } } }
    if (input.mode === 'preview') return { ...report, mode: 'preview', nextStep: { tool: 'initialize_instance', arguments: { instance, mode: 'apply', planHash } } }
    if (input.planHash !== planHash) throw new WorkflowError('stale_plan', 'Initialization inputs changed; preview initialize_instance again', 409, { planHash, nextStep: nextStep(instance) })
    if (conflicts.length) throw new WorkflowError('initialization_conflict', 'Partial or differing artifacts already exist; preserve and review them before retrying fresh initialization', 409, { conflicts })
    // Also fence installed dependencies throughout the guarded publication.
    const verify = async () => {
      if (hash(await dependencies(root, model)) !== hash(dependencyGuards)) fail('stale_plan', 'SDK dependencies changed during initialization; preview again', 409)
    }
    await verify()
    if (existing.length === files.length) return { ...report, mode: 'apply', status: 'unchanged' }
    await store.commit(instance, files.map(({ path, data }) => ({ path, data, create: true })), before.guards, verify)
    return { ...report, mode: 'apply', status: 'initialized' }
  }
  if (input.mode === 'preview') return run()
  // Fail before creating even lock metadata when the consumer graph is broken.
  await dependencies(root, parseRuntimeSource((await bytes(root, 'runtime.ts'))?.toString('utf8') ?? ''))
  return store.locked(instance, run)
}
