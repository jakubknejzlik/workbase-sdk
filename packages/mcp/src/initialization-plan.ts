import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execute } from './sdk-process.ts'
import { bindSchemaLock } from '@workbasehq/core/schema'
import { decodeSource, isLiteralConfig, loadConfig } from '@workbasehq/core/schema/load'
import { plan } from '@workbasehq/core/migrations/schema-plan'
import { generate } from '@workbasehq/core/openapi/generate'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { serializeAccessLock } from '@workbasehq/core/access/lock'
import metadata from '../package.json' with { type: 'json' }
import { WorkflowError, instanceSelector, fail } from './schemas.ts'
import { noLink } from './paths.ts'
import { hash } from './planning.ts'
import { byteHash, byteManifest } from './byte-digest.ts'
import { replaySources } from './replay-sources.ts'
import { parseRuntimeSource, type RuntimeModel } from './composition/runtime-source.ts'
import { hydrateRuntimePlugins, permissionOptions } from './composition/registry.ts'

export const initializationPaths = ['schema.lock.json', 'migrations/0001_r1.sql', 'openapi.json', 'access.lock.json', 'access.lock.md'] as const

async function bytes(root: string, path: string) {
  await noLink(join(root, path), true)
  try { return await readFile(join(root, path), { flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** Check the installed consumer graph without importing authored config or installing.
 * Resolve and import in a fresh process: Bun caches consumer resolution as well as modules. */
export async function initializationDependencies(root: string, model: RuntimeModel) {
  const packages = [
    ['@workbasehq/core', ['schema', 'kernel/registry']],
    ['@workbasehq/plugins', model.plugins.map(({ plugin }) => plugin)],
  ] as const
  const entrypoints = packages.flatMap(([name, entries]) => [...new Set(entries)].sort().map(entry => `${name}/${entry}`))
  const nonce = randomUUID()
  // Only this closed vocabulary can cross the process boundary. A dependency
  // can put arbitrary data (including credentials) in its exception or output.
  const dependencyNames = ['zod', 'hono', 'typescript', 'better-auth'] as const
  const script = `import { createRequire } from 'node:module';
  import { createHash } from 'node:crypto';
  import { constants } from 'node:fs';
  import { lstat, readFile } from 'node:fs/promises';
  import { dirname, join } from 'node:path';
  import { pathToFileURL } from 'node:url';
  const write = process.stdout.write.bind(process.stdout);
  const emit = result => write(JSON.stringify({ nonce: ${JSON.stringify(nonce)}, ...result }));
  const require = createRequire(join(process.cwd(), 'package.json'));
  const hash = data => createHash('sha256').update(data.toString('base64')).digest('hex');
  const resolved = [];
  for (const [packageName, entries] of ${JSON.stringify(packages)}) {
    try {
      for (const entry of [...new Set(entries)].sort()) {
        const entrypoint = packageName + '/' + entry;
        const path = require.resolve(entrypoint);
        let directory = dirname(path), manifest;
        while (true) {
          const candidate = join(directory, 'package.json');
          try {
            if ((await lstat(candidate)).isSymbolicLink()) throw new Error('Unsafe package metadata');
            const data = await readFile(candidate, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
            if (JSON.parse(data.toString()).name === packageName) { manifest = data; break }
          } catch (error) { if (error.code !== 'ENOENT') throw error }
          const parent = dirname(directory);
          if (parent === directory) throw new Error('Package metadata missing');
          directory = parent;
        }
        if (JSON.parse(manifest.toString()).version !== ${JSON.stringify(metadata.version)}) throw new Error('Incompatible package version');
        resolved.push({ entrypoint, path, manifestHash: hash(manifest), hash: hash(await readFile(path)) });
      }
    } catch {
      emit({ status: 'resolution_failed', package: packageName });
      process.exit(1);
    }
  }
  const names = ${JSON.stringify(dependencyNames)};
  for (const { entrypoint, path } of resolved) {
    try { await import(pathToFileURL(path).href) }
    catch (error) {
      let missingDependency;
      if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
        const match = typeof error.message === 'string' && /^(?:Cannot find (?:package|module)|Cannot resolve (?:package|module)) ['"]([^'"]+)['"]/.exec(error.message);
        missingDependency = names.find(name => name === match?.[1]);
      }
      emit({ status: 'import_failed', entrypoint, ...(missingDependency ? { missingDependency } : {}) });
      process.exitCode = 1;
      break;
    }
  }
  if (!process.exitCode) emit({ status: 'complete', entrypoints: resolved });`
  try {
    const runtime = process.versions.bun ? ['--no-install'] : ['--import', createRequire(import.meta.url).resolve('tsx')]
    const checked = await execute([process.execPath, ...runtime, '--input-type=module', '--eval', script], root,
      { timeoutMs: 30000, maxOutputBytes: 65536, env: { ...process.env, TSX_DISABLE_CACHE: '1' }, onStderr: () => {} })
    // Treat stdout as untrusted, including syntactically valid JSON. Never
    // spread it into a response, and require proof that every resolution and import finished.
    let outcome: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(checked.stdout)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) outcome = parsed as Record<string, unknown>
    } catch { /* missing/malformed result fails closed */ }
    const verified = outcome?.nonce === nonce ? outcome : undefined
    const result: Record<string, string> = {}
    const completed = verified?.status === 'complete' &&
      Object.keys(verified).sort().join(',') === 'entrypoints,nonce,status' &&
      Array.isArray(verified.entrypoints) && verified.entrypoints.length === entrypoints.length &&
      verified.entrypoints.every((entry: unknown, index: number) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
        const resolved = entry as Record<string, unknown>
        if (Object.keys(resolved).sort().join(',') !== 'entrypoint,hash,manifestHash,path' ||
          resolved.entrypoint !== entrypoints[index] || typeof resolved.path !== 'string' || !isAbsolute(resolved.path) ||
          typeof resolved.hash !== 'string' || !/^[a-f0-9]{64}$/.test(resolved.hash) ||
          typeof resolved.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(resolved.manifestHash)) return false
        const packageName = packages.find(([name]) => entrypoints[index].startsWith(name + '/'))![0]
        const manifestKey = `${packageName}/package.json`
        if (result[manifestKey] !== undefined && result[manifestKey] !== resolved.manifestHash) return false
        result[manifestKey] = resolved.manifestHash
        result[entrypoints[index]] = resolved.hash
        return true
      })
    if (checked.rc !== 0 || !completed) {
      const packageName = verified?.status === 'resolution_failed' ? packages.find(([name]) => name === verified.package)?.[0] : undefined
      if (packageName) throw new WorkflowError('dependencies_missing', `${packageName}@${metadata.version} must be available from the instance root`, 422,
        { package: packageName, supportedVersion: metadata.version, remedy: `Provision ${packageName}@${metadata.version} in this instance's node_modules, then retry initialize_instance preview. No packages were installed.` })
      const entrypoint = verified?.status === 'import_failed' ? entrypoints.find(name => name === verified.entrypoint) : undefined
      const missingDependency = entrypoint ? dependencyNames.find(name => name === verified?.missingDependency) : undefined
      throw new WorkflowError('dependencies_missing', 'The installed SDK runtime dependency graph cannot be imported', 422,
        { reason: checked.timedOut ? 'preflight_timeout' : entrypoint ? 'import_failed' : 'preflight_incomplete',
          ...(entrypoint ? { entrypoint } : {}), ...(missingDependency ? { missingDependency } : {}), supportedVersion: metadata.version,
          remedy: `Provision the complete dependencies of @workbasehq/core@${metadata.version} and @workbasehq/plugins@${metadata.version}, including transitive dependencies, in this instance's node_modules; retry initialize_instance preview. No packages were installed.` })
    }
    return result
  } catch (error) {
    if (error instanceof WorkflowError) throw error
    throw new WorkflowError('dependencies_missing', 'Unable to verify the installed SDK runtime dependency graph', 422,
      { reason: 'preflight_failed', remedy: 'Ensure the local runtime and the complete SDK dependencies are available, then retry initialize_instance preview. No packages were installed.' })
  }
}

export async function initializationSnapshot(root: string) {
  const inputs = await replaySources(root, { accessLock: true })
  for (const name of (await readdir(root)).filter(name => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(name)).sort()) {
    inputs[name] = (await bytes(root, name))!
  }
  const migrations = (await readdir(join(root, 'migrations'))).filter(name => name !== '.gitkeep').sort()
  for (const name of migrations) inputs[`migrations/${name}`] = (await bytes(root, `migrations/${name}`))!
  const guards: Record<string, string | null> = byteManifest(inputs)
  for (const path of ['package.json', 'bun.lock']) {
    const data = await bytes(root, path)
    guards[path] = data === null ? null : byteHash(data)
  }
  for (const path of initializationPaths) guards[path] ??= null
  return { inputs, guards, migrations }
}

/** Capture the literal declaration without evaluating consumer runtime modules. */
export async function loadInitializationInputs(root: string, instance: string, before?: Awaited<ReturnType<typeof initializationSnapshot>>) {
  before ??= await initializationSnapshot(root)
  if (!isLiteralConfig(join(root, 'config.ts'))) fail('initialization_unsupported', 'initialize_instance supports fresh literal V3 declarations only', 422)
  const loaded = await loadConfig(join(root, 'config.ts'), { bindExistingLock: false })
  if (instanceSelector(loaded.config.id) !== instance) fail('invalid_instance_id', 'Config id does not match the selected instance', 409)
  return { before, loaded }
}

/** Read-only five-artifact generator. Publication, locks and retry policy belong to callers. */
export async function planInitialization(root: string, instance: string, staged?: { model: RuntimeModel; source: string },
  captured?: Awaited<ReturnType<typeof loadInitializationInputs>>) {
  const { before, loaded } = captured ?? await loadInitializationInputs(root, instance)
  const runtimeSource = staged ? Buffer.from(staged.source) : before.inputs['runtime.ts']
  if (!runtimeSource) fail('runtime_not_canonical', 'Fresh initialization requires canonical runtime.ts', 422)
  const model = parseRuntimeSource(decodeSource(runtimeSource, join(root, 'runtime.ts')))
  if (staged && hash(model) !== hash(staged.model)) fail('runtime_not_canonical', 'Staged runtime model must match the rendered source', 422)
  const permissions = model.plugins.find(plugin => plugin.plugin === 'permissions')?.options as { roles: string[]; ownerRole: string } | undefined
  const expectedPermissions = permissionOptions(loaded.config)
  if (permissions && (JSON.stringify(permissions.roles) !== JSON.stringify(expectedPermissions.roles) || permissions.ownerRole !== expectedPermissions.ownerRole)) {
    fail('runtime_not_canonical', 'runtime.ts permissions must derive roles and ownerRole from the config graph before initialization', 422)
  }
  const dependencyGuards = await initializationDependencies(root, model)
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
  const planHash = hash({ version: 1, instance, ...(staged ? { runtime: hash(staged.source) } : {}), sources: sourceGuards, dependencies: dependencyGuards, files: files.map(({ path, hash }) => ({ path, hash })) })
  return { before, model, dependencyGuards, files, conflicts, planHash }
}
