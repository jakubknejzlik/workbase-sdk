import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
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
 * Resolve and import in a fresh process: Bun caches consumer resolution as well as modules. */
async function dependencies(root: string, model: RuntimeModel, dependencyRoots: readonly string[]) {
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
  import { readFile, realpath, stat } from 'node:fs/promises';
  import { isAbsolute, join, relative, sep } from 'node:path';
  import { pathToFileURL } from 'node:url';
  const write = process.stdout.write.bind(process.stdout);
  const emit = result => write(JSON.stringify({ nonce: ${JSON.stringify(nonce)}, ...result }));
  const require = createRequire(join(process.cwd(), 'package.json'));
  const hash = data => createHash('sha256').update(data.toString('base64')).digest('hex');
  const inside = (root, path) => { const part = relative(root, path); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)) };
  const extraRoots = ${JSON.stringify(dependencyRoots)};
  const reason = extraRoots.length ? 'outside_dependency_roots' : 'outside_instance_root';
  let roots, policyHash;
  try {
    const instanceRoot = await realpath(process.cwd());
    const trusted = [...new Set(await Promise.all(extraRoots.map(root => realpath(root))))].sort();
    const identities = [];
    for (const root of trusted) {
      const info = await stat(root, { bigint: true });
      if (!info.isDirectory()) throw new Error('Invalid dependency root');
      identities.push({ kind: 'trusted_directory', dev: info.dev.toString(), ino: info.ino.toString() });
    }
    roots = [instanceRoot, ...trusted];
    // Bind policy changes and root relinks without putting machine paths in plans.
    policyHash = hash(Buffer.from(JSON.stringify({ mode: extraRoots.length ? 'trusted_roots' : 'instance', roots: identities })));
  } catch {
    emit({ status: 'origin_failed', package: '@workbasehq/core', reason });
    process.exit(1);
  }
  const resolved = [];
  for (const [packageName, entries] of ${JSON.stringify(packages)}) {
    try {
      for (const entry of [...new Set(entries)].sort()) {
        const entrypoint = packageName + '/' + entry;
        const path = await realpath(require.resolve(entrypoint));
        if (!roots.some(root => inside(root, path))) {
          emit({ status: 'origin_failed', package: packageName, reason }); process.exit(1);
        }
        let packageRoot, manifestPath;
        // Locate the selected installation independently of the canonical entry:
        // a file symlink must not substitute another package's matching metadata.
        for (const location of require.resolve.paths(entrypoint) ?? []) {
          try {
            packageRoot = await realpath(join(location, packageName));
            manifestPath = await realpath(join(packageRoot, 'package.json'));
            break;
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        if (!packageRoot || !manifestPath) throw new Error('Package metadata missing');
        if (!roots.some(root => inside(root, packageRoot)) || !inside(packageRoot, path) || !inside(packageRoot, manifestPath)) {
          emit({ status: 'origin_failed', package: packageName, reason }); process.exit(1);
        }
        const manifest = await readFile(manifestPath, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
        const info = JSON.parse(manifest.toString());
        if (info.name !== packageName || info.version !== ${JSON.stringify(metadata.version)}) throw new Error('Incompatible package version');
        const rootIndex = roots.findIndex(root => inside(root, packageRoot));
        const originHash = hash(Buffer.from(JSON.stringify({ rootIndex, package: relative(roots[rootIndex], packageRoot),
          entry: relative(packageRoot, path), manifest: relative(packageRoot, manifestPath) })));
        resolved.push({ entrypoint, path, originHash, manifestHash: hash(manifest), hash: hash(await readFile(path)) });
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
  if (!process.exitCode) emit({ status: 'complete', policyHash, entrypoints: resolved });`
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
      Object.keys(verified).sort().join(',') === 'entrypoints,nonce,policyHash,status' &&
      typeof verified.policyHash === 'string' && /^[a-f0-9]{64}$/.test(verified.policyHash) &&
      Array.isArray(verified.entrypoints) && verified.entrypoints.length === entrypoints.length &&
      verified.entrypoints.every((entry: unknown, index: number) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
        const resolved = entry as Record<string, unknown>
        if (Object.keys(resolved).sort().join(',') !== 'entrypoint,hash,manifestHash,originHash,path' ||
          resolved.entrypoint !== entrypoints[index] || typeof resolved.path !== 'string' || !isAbsolute(resolved.path) ||
          typeof resolved.hash !== 'string' || !/^[a-f0-9]{64}$/.test(resolved.hash) ||
          typeof resolved.originHash !== 'string' || !/^[a-f0-9]{64}$/.test(resolved.originHash) ||
          typeof resolved.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(resolved.manifestHash)) return false
        const packageName = packages.find(([name]) => entrypoints[index].startsWith(name + '/'))![0]
        const manifestKey = `${packageName}/package.json`
        if (result[manifestKey] !== undefined && result[manifestKey] !== resolved.manifestHash) return false
        result[manifestKey] = resolved.manifestHash
        result[entrypoints[index]] = hash({ content: resolved.hash, origin: resolved.originHash })
        return true
      })
    if (checked.rc !== 0 || !completed) {
      const originPackage = verified?.status === 'origin_failed' && Object.keys(verified).sort().join(',') === 'nonce,package,reason,status'
        ? packages.find(([name]) => name === verified.package)?.[0] : undefined
      const originReason = dependencyRoots.length ? 'outside_dependency_roots' : 'outside_instance_root'
      if (originPackage && verified?.reason === originReason) throw new WorkflowError('dependencies_missing', 'SDK dependency origin is outside the permitted roots', 422,
        { reason: originReason, package: originPackage,
          remedy: "Provision physical SDK packages in this instance's node_modules, or have the server operator configure dependencyRoots for trusted workspace packages; retry initialize_instance preview." })
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
    return { policy: verified!.policyHash as string, ...result }
  } catch (error) {
    if (error instanceof WorkflowError) throw error
    throw new WorkflowError('dependencies_missing', 'Unable to verify the installed SDK runtime dependency graph', 422,
      { reason: 'preflight_failed', remedy: 'Ensure the local runtime and the complete SDK dependencies are available, then retry initialize_instance preview. No packages were installed.' })
  }
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
    const dependencyGuards = await dependencies(root, model, store.dependencyRoots)
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
      if (hash(await dependencies(root, model, store.dependencyRoots)) !== hash(dependencyGuards)) fail('stale_plan', 'SDK dependencies changed during initialization; preview again', 409)
    }
    await verify()
    if (existing.length === files.length) return { ...report, mode: 'apply', status: 'unchanged' }
    await store.commit(instance, files.map(({ path, data }) => ({ path, data, create: true })), before.guards, verify)
    return { ...report, mode: 'apply', status: 'initialized' }
  }
  if (input.mode === 'preview') return run()
  // Fail before creating even lock metadata when the consumer graph is broken.
  await dependencies(root, parseRuntimeSource((await bytes(root, 'runtime.ts'))?.toString('utf8') ?? ''), store.dependencyRoots)
  return store.locked(instance, run)
}
