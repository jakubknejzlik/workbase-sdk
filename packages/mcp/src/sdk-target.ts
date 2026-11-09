import { randomUUID, createHash } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from './sdk-process.ts'
import { assertRegistryLock, assertRegistryManifest, downloadRegistryArchives, resolveRegistrySdk, sdkNames, verifyRegistryConsumer } from './sdk-registry.ts'
import { acceptUpgradeResult, assertBound, BRIDGE_VERSION, bridgeDigest, bridgeFiles, consumerModules, digestBytes, identitySchema, inputPath, inside, preparedSchema,
  type UpgradeIdentity, type UpgradeRequest, type UpgradeStage } from './sdk-upgrade-protocol.ts'

export type SdkInputs = Record<string, Buffer>
export type BaseDigests = Pick<UpgradeIdentity, 'baseFingerprint' | 'baseDependencyDigest'>
export type TargetOptions = {
  instanceRoot: string; checkoutRoot: string; targetVersion: string
  base: BaseDigests & { instanceId: string; baseRevision: number }
  inputs: SdkInputs
  /** Caller holds the Instance lock and recomputes BOTH original base digests. */
  readBase: () => Promise<BaseDigests>
  signal?: AbortSignal; timeoutMs?: number; registry?: string
}
const dependencyNames = ['package.json', 'bun.lock']
const hashInputs = (inputs: SdkInputs) => Object.fromEntries(Object.keys(inputs).sort().map(path => [path, digestBytes(inputs[path])]))
const rawDigest = (inputs: SdkInputs) => digestBytes(JSON.stringify(hashInputs(inputs)))
async function regular(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error(`SDK input must be a bounded regular file: ${path}`)
  return readFile(path)
}
/** Capture raw application/dependency bytes, including the complete SQL list. */
export async function captureSdkInputs(root: string): Promise<SdkInputs> {
  if (!(await lstat(join(root, 'migrations'))).isDirectory()) throw new Error('Linked migrations directory')
  const names = [...dependencyNames, ...(await readdir(root)).filter(name => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(name)),
    ...(await readdir(join(root, 'migrations'))).map(name => `migrations/${name}`)].sort()
  if (!names.includes('config.ts')) throw new Error('Missing captured configuration')
  const inputs: SdkInputs = {}
  let bytes = 0
  if (names.length > 12000) throw new Error('Too many SDK inputs')
  for (const name of names) {
    inputPath.parse(name)
    inputs[name] = await regular(join(root, name)); bytes += inputs[name].length
    if (bytes > 32 * 1024 * 1024) throw new Error('SDK inputs exceed byte bound')
  }
  return inputs
}
function standaloneManifest(inputs: SdkInputs, version: string, registry: string) {
  const manifest = JSON.parse(inputs['package.json'].toString('utf8'))
  assertRegistryManifest(manifest)
  const lock = assertRegistryLock(inputs['bun.lock'].toString('utf8'), registry)
  if (manifest.workspaces || Object.keys(lock.workspaces).some(key => key !== '') || manifest.patchedDependencies || lock.patchedDependencies) throw new Error('SDK target requires a standalone registry consumer')
  const pin = (entries: Record<string, any>) => {
    for (const key of Object.keys(entries)) {
      if (sdkNames.includes(key)) entries[key] = version
      else if (sdkNames.some(name => key.includes(name))) throw new Error(`Unsupported SDK alias or override: ${key}`)
      else if (entries[key] && typeof entries[key] === 'object') pin(entries[key])
    }
  }
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions']) if (manifest[key]) pin(manifest[key])
  const pins = Object.fromEntries(sdkNames.map(name => [name, version]))
  manifest.dependencies = { ...manifest.dependencies, ...pins }
  manifest.overrides = { ...manifest.overrides, ...pins }
  return Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
}
async function executable(name: string, excluded: string[]) {
  for (const path of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      const candidate = await realpath(join(path, name))
      if (excluded.some(root => candidate === root || inside(root, candidate))) continue
      await access(candidate, constants.X_OK)
      if ((await lstat(candidate)).isFile()) return candidate
    } catch { /* next trusted executable search path */ }
  }
  throw new Error(`Missing external ${name} executable`)
}
async function isolatedEnvironment(scratch: string, excluded: string[], registry: string) {
  for (const name of ['home', 'tools', 'tmp', 'config', 'cache']) await mkdir(join(scratch, name))
  for (const name of ['bun', 'node']) await symlink(await executable(name, excluded), join(scratch, 'tools', name))
  const npmrc = join(scratch, 'npmrc')
  await writeFile(npmrc, `registry=${registry}\nignore-scripts=true\n`)
  await writeFile(join(scratch, 'home/.npmrc'), `registry=${registry}\nignore-scripts=true\n`)
  await writeFile(join(scratch, 'home/.bunfig.toml'), '[install]\ncache = false\n')
  // An allowlist removes NODE_OPTIONS/NODE_PATH, tokens, proxy/registry variables,
  // producer binaries and all user package-manager/loader configuration.
  const env: NodeJS.ProcessEnv = {
    PATH: [join(scratch, 'tools'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp'),
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
    BUN_INSTALL_CACHE_DIR: join(scratch, 'bun-cache'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    npm_config_userconfig: npmrc, npm_config_globalconfig: npmrc, npm_config_cache: join(scratch, 'npm-cache'),
    CI: 'true', LANG: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1',
    CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(scratch, 'wrangler.log'),
  }
  return env
}
async function installedDigests(consumer: string) {
  const result: { name: string; sha256: string }[] = []
  for (const name of sdkNames) {
    const hash = createHash('sha256')
    const walk = async (path: string, prefix = ''): Promise<void> => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const relative = prefix + entry.name, absolute = join(path, entry.name)
        if (entry.isDirectory()) await walk(absolute, relative + '/')
        else {
          const bytes = await regular(absolute)
          // Length framing binds paths and arbitrary binary bytes unambiguously.
          hash.update(`${Buffer.byteLength(relative)}:${relative}:${bytes.length}:`).update(bytes)
        }
      }
    }
    await walk(join(consumer, 'node_modules', name))
    result.push({ name, sha256: hash.digest('hex') })
  }
  return result
}

/** Internal only. No proposal writes, public dispatch or evidence publication.
 * Always await the D1 process runner and delete owned scratch before returning. */
export async function runSdkTarget(options: TargetOptions) {
  const instance = await realpath(options.instanceRoot), checkout = await realpath(options.checkoutRoot)
  // Copy caller buffers so later mutation cannot replace parent-held expectations.
  const captured = Object.fromEntries(Object.entries(options.inputs).map(([path, bytes]) => [path, Buffer.from(bytes)]))
  const registry = options.registry ?? 'https://registry.npmjs.org'
  const manifest = standaloneManifest(captured, options.targetVersion, registry)
  const sourceDirectory = fileURLToPath(new URL('.', import.meta.url).href)
  const identity = identitySchema.parse({ ...options.base, targetVersion: options.targetVersion, runId: randomUUID(),
    bridgeVersion: BRIDGE_VERSION, bridgeDigest: await bridgeDigest(sourceDirectory) })
  const shutdown = new AbortController()
  const signal = AbortSignal.any([shutdown.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 300000)])
  const checkBase = async () => {
    signal.throwIfAborted()
    assertBound(await options.readBase(), { baseFingerprint: identity.baseFingerprint, baseDependencyDigest: identity.baseDependencyDigest }, 'base digests')
    assertBound(hashInputs(await captureSdkInputs(instance)), hashInputs(captured), 'base input bytes')
  }
  await checkBase()
  const temporary = await realpath(tmpdir())
  if ([checkout, instance].some(root => temporary === root || inside(root, temporary))) throw new Error('TMPDIR is inside checkout or Instance')
  const scratch = await mkdtemp(join(temporary, 'workbase-sdk-target-'))
  const stop = () => shutdown.abort(new Error('SDK target shutdown'))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const consumer = join(scratch, 'consumer'), archives = join(scratch, 'archives')
    await mkdir(consumer, { mode: 0o700 }); await mkdir(join(consumer, 'migrations')); await mkdir(join(consumer, '.sdk-bridge'))
    const env = await isolatedEnvironment(scratch, [checkout, instance], registry)
    const command = async (argv: string[]) => {
      signal.throwIfAborted()
      const result = await execute(argv, consumer, { env, signal, timeoutMs: 90000, maxOutputBytes: 1024 * 1024 })
      signal.throwIfAborted()
      if (result.rc !== 0) throw new Error(`SDK target command failed (${result.rc}): ${result.stderr}\n${result.stdout}`)
    }
    for (const [path, bytes] of Object.entries(captured)) {
      inputPath.parse(path)
      if (!dependencyNames.includes(path)) await writeFile(join(consumer, path), bytes)
    }
    await writeFile(join(consumer, 'package.json'), manifest)
    await writeFile(join(consumer, 'bunfig.toml'), `[install]\nregistry = ${JSON.stringify(registry)}\n[install.scopes]\nworkbasehq = ${JSON.stringify(registry)}\n`)
    const sdk = await resolveRegistrySdk(identity.targetVersion, registry, { signal, timeoutMs: 30000 })
    const archiveWitnesses = await downloadRegistryArchives(sdk, archives, { signal, timeoutMs: 30000 })
    await checkBase()
    await command([join(scratch, 'tools/bun'), 'install', '--ignore-scripts', '--no-cache', '--linker', 'hoisted', '--registry', registry])
    await checkBase()
    assertBound(digestBytes(await regular(join(consumer, 'package.json'))), digestBytes(manifest), 'installed manifest')
    const targetInputs = await captureSdkInputs(consumer)
    const inputHashes = hashInputs(targetInputs)
    for (const [path, bytes] of Object.entries(captured)) if (!dependencyNames.includes(path)) assertBound(inputHashes[path], digestBytes(bytes), `copied input ${path}`)
    const verify = async () => {
      await checkBase()
      await verifyRegistryConsumer(consumer, sdk, archives, env, { signal, timeoutMs: 30000 })
      await checkBase()
    }
    await verify()
    const installed = await installedDigests(consumer)
    const modules = await consumerModules(consumer)
    for (const path of bridgeFiles) await writeFile(join(consumer, '.sdk-bridge', path), await readFile(join(sourceDirectory, path)))
    if (await bridgeDigest(join(consumer, '.sdk-bridge')) !== identity.bridgeDigest) throw new Error('Bridge copy changed')
    const bridge = async (request: UpgradeRequest) => {
      await rm(join(consumer, '.sdk-bridge/result.json'), { force: true })
      await writeFile(join(consumer, '.sdk-bridge/request.json'), JSON.stringify(request))
      await command([join(scratch, 'tools/node'), '--import', modules.resolutions.tsx, join(consumer, '.sdk-bridge/sdk-upgrade-worker.ts')])
      return JSON.parse((await regular(join(consumer, '.sdk-bridge/result.json'))).toString('utf8'))
    }
    const prepared = preparedSchema.parse(await bridge({ action: 'prepare', identity, inputHashes }))
    assertBound(prepared.identity, identity, 'prepared identity'); assertBound(prepared.inputHashes, inputHashes, 'prepared hashes')
    const stage: UpgradeStage = prepared.stage
    const count = Object.keys(captured).filter(path => path.startsWith('migrations/')).length
    assertBound(stage.marker.path, `migrations/${String(count + 1).padStart(4, '0')}_sdk_upgrade.sql`, 'marker path')
    const marker = await regular(join(consumer, stage.marker.path))
    const checkStage = async () => {
      assertBound(hashInputs(await captureSdkInputs(consumer)), { ...inputHashes, [stage.marker.path]: digestBytes(marker) }, 'staged input bytes')
      if (digestBytes(marker) !== stage.marker.sha256 || digestBytes(await regular(join(consumer, '.sdk-bridge/replay.sql'))) !== stage.replaySha256
        || await bridgeDigest(join(consumer, '.sdk-bridge')) !== identity.bridgeDigest) throw new Error('Changed bridge or staged SQL')
    }
    await checkStage()
    await verify()
    await writeFile(join(consumer, '.sdk-bridge/wrangler.json'), JSON.stringify({ name: 'sdk-upgrade-verification', compatibility_date: '2026-08-01',
      d1_databases: [{ binding: 'DB', database_name: 'sdk-upgrade', database_id: '00000000-0000-0000-0000-000000000186' }] }))
    // Parent owns each child group; the bridge itself launches no descendants.
    await command([join(scratch, 'tools/node'), modules.resolutions.wrangler, 'd1', 'execute', 'DB', '--local', '--persist-to', '.sdk-bridge/persist',
      '--config', '.sdk-bridge/wrangler.json', '--file', '.sdk-bridge/replay.sql'])
    await checkStage()
    await verify()
    const request: UpgradeRequest = { action: 'verify', identity, inputHashes, stage }
    const raw = await bridge(request)
    await verify()
    await checkStage()
    assertBound(await installedDigests(consumer), installed, 'installed SDK digests')
    const result = acceptUpgradeResult(raw, request, modules.packages, modules.resolutions)
    // Return raw artifacts rather than scratch paths as durable evidence inputs.
    const artifacts = Object.fromEntries(['package.json', 'bun.lock', stage.marker.path].map(path => [path, {
      bytes: path === stage.marker.path ? marker : targetInputs[path], sha256: path === stage.marker.path ? digestBytes(marker) : inputHashes[path],
    }]))
    const targetDependencyDigest = digestBytes(JSON.stringify(Object.fromEntries(dependencyNames.map(path => [path, inputHashes[path]]))))
    if (rawDigest(captured) !== rawDigest(options.inputs)) throw new Error('Caller changed captured inputs')
    await checkBase()
    return { result, artifacts, targetDependencyDigest, archives: archiveWitnesses.map(({ archive: _archive, ...witness }) => witness), installed }
  } finally {
    try { await rm(scratch, { recursive: true, force: true }) }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
    signal.throwIfAborted()
  }
}
