import { AsyncLocalStorage } from 'node:async_hooks'
import { acquireInstanceLock } from './instance-lock.ts'
import { devFixtures } from './dev-support.ts'
import { noLink } from './paths.ts'
import { replaySources } from './replay-sources.ts'
import { constants } from 'node:fs'
import { open, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile, link, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { inspectInstance, isDisplayFieldError, serializableInstanceConfig, type InstanceConfig } from '@workbasehq/core/config'
import { isBuiltinPlugin } from '@workbasehq/core/plugins'
import { z } from 'zod'
import { hash } from './planning.ts'
import { WorkflowError, fail, identifier, instanceSelector, type Index } from './schemas.ts'

export type Migration = { name: string; sql: string }
export type Bundle = { config: InstanceConfig; runtime?: InstanceConfig; migrations: Migration[]; indexes: Index[]; fingerprint: string; dependencyDigest?: string; guards: Record<string, string | null> }
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
export const configSource = (config: InstanceConfig, options: { history?: boolean } = {}) => {
  const { plugins, ...data } = serializableInstanceConfig(config)
  // MCP may edit schema data, never synthesize executable plugin hooks from JSON.
  // Preserve the explicitly selected in-tree distribution on generated configs.
  const imports = new Set<string>()
  const names = (plugins ?? []).map(plugin => {
    if (!isBuiltinPlugin(plugin)) fail('unsupported_plugin_source', `Cannot serialize noncanonical plugin source: ${plugin.name}`)
    const factories: Record<string, [string, string]> = {
      identity: ['createIdentity', 'identity'], members: ['createMembers', 'members'],
      organizations: ['createOrganizations', 'organizations'], 'local-auth': ['createLocalAuth', 'localAuth'],
      permissions: ['permissions', 'permissions'], 'machine-credentials': ['machineCredentials', 'machineCredentials'],
      'mail-outbox': ['mailOutbox', 'mailOutbox'], audit: ['audit', 'audit'], console: ['consoleUI', 'consoleUI'],
      ...Object.fromEntries(Object.entries(devFixtures?.sources ?? {}).map(([name, entry]) => [name, [entry.exported, entry.exported] as [string, string]])),
    }
    const factory = factories[plugin.name]
    const compatibility = ['identity', 'members', 'organizations', 'local-auth'].includes(plugin.name) && plugin.configuration === undefined
    if (factory && !compatibility) {
      const [exported, local] = factory
      if (plugin.name === 'console' && options.history) {
        imports.add("import history from './config.versions.json'\n")
        imports.add("import { consoleUI } from '@workbasehq/plugins/console'\n")
        return 'consoleUI({ history })'
      }
      const source = devFixtures?.sources[plugin.name]?.source ?? `@workbasehq/plugins/${plugin.name}`
      imports.add(`import { ${exported === local ? local : `${exported} as ${local}`} } from '${source}'\n`)
      return `${local}(${plugin.configuration === undefined || plugin.name === 'members' ? '' : JSON.stringify(plugin.configuration)})`
    }
    const local = plugin.name === 'local-auth' ? 'localAuth' : plugin.name
    imports.add(`import { ${local === 'rbac' ? 'legacyPermissions as rbac' : local} } from '${['tenancy'].includes(plugin.name) ? '@workbasehq/core/plugins' : `@workbasehq/plugins/${plugin.name === 'rbac' ? 'permissions' : plugin.name}`}'\n`)
    return local
  })
  const input = JSON.stringify(data, null, 2)
  const source = plugins ? `{\n  plugins: [${names.join(', ')}],${input.slice(1)}` : input
  return `import { defineInstance } from '@workbasehq/core/config'\n${[...imports].join('')}export default defineInstance(${source})\n`
}
export { noLink } from './paths.ts'
export async function atomic(path: string, data: string | Uint8Array, beforePublish?: (temporary: string) => Promise<void>) {
  await noLink(path, true)
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(tmp, data, { flag: 'wx', mode: 0o600 })
    await beforePublish?.(tmp)
    await rename(tmp, path)
  }
  finally { await rm(tmp, { force: true }) }
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
/** SDK authorization records must survive process death and filesystem restart. */
export async function durableAtomic(path: string, data: string) {
  await atomic(path, data, async temporary => {
    const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  })
  await syncDirectory(dirname(path))
}
const require = createRequire(import.meta.url)
async function importConfig(path: string, sourceHash: string, replayPaths: string[] = []) {
  if (process.versions.bun) {
    // Reload sibling version sources and history JSON as well as the entrypoint.
    // Keep SDK/plugin modules cached so canonical plugin provenance is preserved.
    for (const name of (await readdir(dirname(path))).filter(n => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(n))) {
      const source = join(dirname(path), name)
      await noLink(source)
      delete require.cache[source]
    }
    for (const name of replayPaths) delete require.cache[join(dirname(path), name)]
  }
  const url = `${pathToFileURL(path).href}?mcp=${sourceHash}`
  // SDK consumers run Bun natively; tsx is only a Node/monorepo convenience.
  // Bun shares native imports with require.cache. Evicting every tracked sibling
  // above reloads the entrypoint and its dependencies; a query suffix is redundant.
  try {
    const loaded = process.versions.bun ? await import(path)
      : await (await import('tsx/esm/api')).tsImport(url, import.meta.url)
    return inspectInstance(loaded.default).config
  } catch (error) {
    // A config module commonly calls defineInstance while being imported.
    // Recover its checked, unchanged schema for inspection/repair only.
    if (isDisplayFieldError(error) && error.config) return inspectInstance(error.config).config
    throw error
  }
}
// Read exact bytes without following symlinks; absence is distinct from an empty file.
async function fileBytes(path: string) {
  return (await fileSnapshot(path))?.bytes ?? null
}
async function fileSnapshot(path: string) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) fail('unsafe_path', 'Transaction paths must be regular files', 403)
    const bytes = await handle.readFile()
    return { bytes, identity: { dev: stat.dev.toString(), ino: stat.ino.toString(), hash: byteHash(bytes) } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('unsafe_path', 'Symlinks are forbidden', 403)
    throw error
  } finally { await handle?.close() }
}
const byteHash = (bytes: Uint8Array) => hash(Buffer.from(bytes).toString('base64'))
// Also fail closed for this process if the filesystem rejects both ways of
// publishing a revocation marker. A successful retry must not reuse that proof.
const unknownSdkEvidence = new Set<string>()
function revokedSdkRecord(record: any) {
  if (record?.kind !== 'sdk_upgrade') return record
  if (record.status === 'promoted') return record
  const { evidence: _evidence, ...proposal } = record
  return { ...proposal, status: proposal.status === 'discarded' ? 'discarded' : 'proposed' }
}
async function dependencyHash(path: string) {
  const bytes = await fileBytes(path)
  return bytes === null ? null : byteHash(bytes)
}
const transactionPath = z.string().regex(/^(package\.json|bun\.lock|config(?:\.v[1-9][0-9]*)?\.ts|config\.(?:indexes|versions)\.json|migrations\/\d{4}_[a-z0-9_]+\.sql|proposals\/[a-f0-9-]+\.json)$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const base64 = z.string().refine(value => Buffer.from(value, 'base64').toString('base64') === value)
const identityPart = z.union([z.string().regex(/^(0|[1-9][0-9]*)$/), z.number().int().nonnegative().transform(String)])
const identitySchema = z.strictObject({ dev: identityPart, ino: identityPart, hash: digest })
type FileIdentity = z.infer<typeof identitySchema>
const ownedJournalSchema = z.strictObject({
  version: z.literal(3), transactionId: z.uuid(), files: z.array(z.strictObject({
    path: transactionPath, before: base64.nullable(), stage: z.uuid(), after: identitySchema,
    capture: z.strictObject({ token: z.uuid(), identity: identitySchema }).optional(),
  }).refine(file => file.before === null ? file.capture === undefined
    : file.capture !== undefined && file.capture.identity.hash === byteHash(Buffer.from(file.before, 'base64')))),
})
type OwnedJournal = z.infer<typeof ownedJournalSchema>
const journalSchema = z.union([
  ownedJournalSchema,
  z.strictObject({ version: z.literal(2), files: z.array(z.strictObject({ path: transactionPath, before: base64.nullable(), afterHash: digest, capture: z.uuid().optional() })) }),
  z.strictObject({ files: z.array(z.strictObject({ path: transactionPath, before: z.string().nullable(), afterHash: digest.optional() })) }),
])
// Validate all destinations before either publication or recovery can mutate anything.
async function validatePaths(dir: string, paths: string[], inspectFiles = true) {
  dir = resolve(dir)
  const seen = new Set<string>()
  await noLink(dir)
  const directories = new Map<string, { dev: bigint; ino: bigint }>()
  for (const parent of [resolve(dir), join(dir, 'proposals')]) {
    const stat = await lstat(parent, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_path', 'Transaction ancestors must be real directories', 403)
    directories.set(parent, { dev: stat.dev, ino: stat.ino })
  }
  for (const path of paths) {
    if (!transactionPath.safeParse(path).success || seen.has(path)) fail('invalid_journal', 'Invalid promotion journal path', 500)
    seen.add(path)
    const destination = resolve(dir, path)
    await noLink(dirname(destination))
    if (inspectFiles) await noLink(destination, true)
    for (let parent = dirname(destination); ; parent = dirname(parent)) {
      const stat = await lstat(parent, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_path', 'Transaction ancestors must be real directories', 403)
      const previous = directories.get(parent)
      if (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) conflict(path)
      directories.set(parent, { dev: stat.dev, ino: stat.ino })
      if (parent === resolve(dir)) break
    }
    // Reject directories and other special files as well as symlinks.
    if (inspectFiles) await fileBytes(destination)
  }
  return async (path: string) => {
    path = resolve(path)
    const chain: string[] = []
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      chain.unshift(parent)
      if (parent === dir) break
      if (parent === dirname(parent)) conflict(path)
    }
    // Node has no openat: the residual window between this full ancestry fence
    // and each syscall is accepted, as in #208; this is not a directory-handle lock.
    for (const parent of chain) {
      const stat = await lstat(parent, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') conflict(path)
        throw error
      })
      const expected = directories.get(parent)
      if (!expected || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) conflict(path)
    }
  }
}
class TransactionConflict extends WorkflowError {
  constructor(readonly path: string) { super('concurrent_modification', `Instance files changed during transaction: ${path}`, 409) }
}
function conflict(path: string): never { throw new TransactionConflict(path) }
type Fence = (path: string) => Promise<void>
const sameFile = (actual: FileIdentity | undefined, expected: FileIdentity) => actual?.dev === expected.dev && actual.ino === expected.ino && actual.hash === expected.hash
async function assertOwned(path: string, identity: FileIdentity, fence: Fence) {
  await fence(path)
  if (!sameFile((await fileSnapshot(path))?.identity, identity)) conflict(path)
}
// The destination is reserved by link(), never rename(). Keep the original
// until the journal has been retired, so rollback can restore its exact inode.
// Writers cooperate via acquireInstanceLock; noncooperating swaps between checks and syscalls are out of scope.
async function retain(path: string, temporary: string, identity: FileIdentity, fence: Fence) {
  await fence(path); await fence(temporary)
  try { await link(path, temporary) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict(temporary); throw error }
  await assertOwned(temporary, identity, fence)
  await syncDirectory(dirname(temporary))
  await assertOwned(path, identity, fence)
  await unlink(path)
}
async function restoreRetained(temporary: string, path: string, identity: FileIdentity, fence: Fence) {
  // Validation at discovery is insufficient: the retained name can be replaced
  // before restoration. Both the source and the resulting canonical bytes matter.
  await assertOwned(temporary, identity, fence)
  await fence(path)
  try { await link(temporary, path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict(path); throw error }
  await assertOwned(path, identity, fence)
  await assertOwned(temporary, identity, fence)
  await syncDirectory(dirname(path))
}
async function removeOwned(path: string, identity: FileIdentity, fence: Fence) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await retain(path, temporary, identity, fence)
  await assertOwned(temporary, identity, fence)
  await unlink(temporary)
}
// Never overwrite an unchecked destination, including while returning a capture.
async function install(captured: string, path: string, fence: Fence, published?: () => void, expected?: FileIdentity) {
  const staged = expected ?? (await fileSnapshot(captured))?.identity
  if (!staged) conflict(captured)
  await assertOwned(captured, staged, fence)
  await fence(path)
  try { await link(captured, path) }
  catch (error) {
    // A syscall wrapper may fail after the link completed. Only the staged inode,
    // never matching planned bytes, can prove publication in that case.
    if (published) {
      await fence(path)
      if (sameFile((await fileSnapshot(path))?.identity, staged)) published()
    }
    throw error
  }
  published?.()
  await assertOwned(path, staged, fence)
  await assertOwned(captured, staged, fence)
  await unlink(captured)
}
async function capture(path: string, expected: string, digestBytes: (bytes: Buffer) => string, fence: Fence, txid: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await fence(path)
  try { await link(path, temporary) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict(temporary)
    throw error
  }
  const identity = (await fileSnapshot(temporary))?.identity
  if (!identity) conflict(path)
  await assertOwned(path, identity, fence)
  await unlink(path)
  await fence(temporary)
  let bytes: Buffer | null
  try { bytes = await fileBytes(temporary) }
  catch (error) {
    if ((error as { code?: string }).code !== 'unsafe_path') throw error
    bytes = null
  }
  if (bytes === null || digestBytes(bytes) !== expected) {
    try { await install(temporary, path, fence, undefined, identity) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Deterministic conflict artifact; no-replace also protects an earlier artifact.
      for (let suffix = 0; ; suffix++) {
        try {
          await install(temporary, `${path}.conflict-${txid}${suffix ? `-${suffix}` : ''}`, fence, undefined, identity)
          break
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
    }
    conflict(path)
  }
  await fence(temporary)
  await assertOwned(temporary, identity, fence)
  await unlink(temporary)
  return true
}
async function writeAbsent(path: string, bytes: Uint8Array, fence: Fence, beforeInstall?: (temporary: string) => Promise<void>, published?: () => void) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await fence(temporary)
  const handle = await open(temporary, 'wx', 0o600)
  let identity: FileIdentity
  try {
    await fence(temporary)
    await handle.writeFile(bytes)
    await fence(temporary)
    await handle.sync()
    const stat = await handle.stat({ bigint: true })
    identity = { dev: stat.dev.toString(), ino: stat.ino.toString(), hash: byteHash(bytes) }
  } finally { await handle.close() }
  try {
    await beforeInstall?.(temporary)
    await install(temporary, path, fence, published, identity)
  } catch (error) {
    await fence(temporary)
    if (sameFile((await fileSnapshot(temporary))?.identity, identity)) await unlink(temporary)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict(path)
    throw error
  }
}
export async function dependencySnapshot(directory: string) {
  const guards: Record<string, string | null> = {}
  for (const name of ['package.json', 'bun.lock']) guards[name] = await dependencyHash(join(directory, name))
  return { digest: hash(guards), guards }
}
export class Store {
  private lockContext = new AsyncLocalStorage<{ dir: string; active: boolean }>()
  private owns(dir: string) { const held = this.lockContext.getStore(); return held?.active && held.dir === dir }
  private async withLock<T>(dir: string, fn: () => Promise<T>, recover = true): Promise<T> {
    if (this.owns(dir)) return fn()
    const release = await acquireInstanceLock(dir)
    const held = { dir, active: true }
    try {
      if (recover) await this.rollback(dir)
      return await this.lockContext.run(held, fn)
    } finally { held.active = false; await release() }
  }
  private configCache = new Map<string, { sourceHash: string; config: InstanceConfig; runtimeHash?: string; runtime?: InstanceConfig }>()
  private instanceDirectories = new Map<string, string>()
  private standalone = false
  public allowed: Set<string>
  constructor(public root: string, private requestedAllowed?: Set<string>) {
    this.allowed = requestedAllowed ?? new Set(devFixtures?.allowed ?? [])
  }
  async init(allowEmpty = false) {
    this.allowed = this.requestedAllowed ?? new Set(devFixtures?.allowed ?? [])
    this.standalone = false
    this.instanceDirectories.clear()
    const selectedRoot = resolve(this.root)
    await noLink(selectedRoot)
    const entry = join(selectedRoot, 'config.ts')
    await noLink(entry, true)
    let exists = false
    try { exists = (await lstat(entry)).isFile() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const pending = await this.hasJournal(selectedRoot)
    if (exists || pending) {
      // Config is executable: reject every protected path before evaluating its imports.
      await noLink(join(selectedRoot, 'migrations'))
      await noLink(join(selectedRoot, 'proposals'), true)
    }
    this.root = await realpath(selectedRoot)
    if (exists || pending) {
      this.standalone = true
      await mkdir(join(this.root, 'proposals'), { recursive: true, mode: 0o700 })
      await this.withLock(this.root, async () => {
        const configPath = join(this.root, 'config.ts')
        const config = await importConfig(configPath, hash(await readFile(configPath, 'utf8')))
        // Core IDs use SQL identifiers (underscores); MCP instance selectors use hyphens.
        const instance = instanceSelector(config.id)
        if (this.requestedAllowed && (this.requestedAllowed.size !== 1 || !this.requestedAllowed.has(instance))) fail('invalid_allowlist', 'Standalone allowlist must contain only the config id')
        this.allowed = new Set([instance])
      })
    }
    if (!exists && !pending && allowEmpty && !this.requestedAllowed) {
      const names = await readdir(this.root)
      if (!names.some(name => ['examples', 'instances', 'migrations'].includes(name))) {
        this.allowed = new Set()
        return
      }
    }
    for (const instance of this.allowed) {
      if (!/^[a-z][a-z0-9-]*$/.test(instance)) fail('invalid_allowlist', 'Invalid server allowlist')
      if (this.standalone) await this.directory(instance)
      else await this.locked(instance, async () => { await this.directory(instance) })
    }
  }
  private async hasJournal(dir: string) {
    await noLink(join(dir, 'proposals'), true)
    const journal = join(dir, 'proposals', '.promotion.json')
    await noLink(journal, true)
    try { return (await lstat(journal)).isFile() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  async directory(instance: string) {
    if (!this.allowed.has(instance)) fail('instance_not_allowed', 'Instance is not in the server allowlist', 403)
    await noLink(this.root)
    const directories: string[] = this.standalone ? [this.root] : []
    for (const parent of this.standalone ? [] : ['examples', 'instances']) {
      await noLink(join(this.root, parent), true)
      const candidate = join(this.root, parent, instance)
      try {
        await noLink(candidate)
        const entry = join(candidate, 'config.ts')
        await noLink(entry, true)
        const config = await lstat(entry).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (config?.isFile() || !config && await this.hasJournal(candidate)) directories.push(candidate)
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (directories.length !== 1) fail('invalid_instance_directory', 'Expected one configuration directory for the allowed instance')
    const dir = directories[0]
    await noLink(dir)
    const entry = join(dir, 'config.ts')
    await noLink(entry, true)
    const config = await lstat(entry).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!config?.isFile() && !(config === null && await this.hasJournal(dir))) fail('invalid_instance_directory', 'Expected one configuration directory for the allowed instance')
    await noLink(join(dir, 'migrations'))
    await noLink(join(dir, 'proposals'), true)
    await mkdir(join(dir, 'proposals'), { recursive: true, mode: 0o700 })
    this.instanceDirectories.set(instance, dir)
    return dir
  }
  /** Proposal access uses the canonical directory established at initialization,
   * independently of application files that may now be missing or unsafe. */
  async proposalDirectory(instance: string) {
    if (!this.allowed.has(instance)) fail('instance_not_allowed', 'Instance is not in the server allowlist', 403)
    const dir = this.standalone ? this.root : this.instanceDirectories.get(instance)
    if (!dir) return this.directory(instance)
    await noLink(this.root)
    if (dir !== this.root) await noLink(dirname(dir))
    await noLink(dir)
    if (!(await lstat(dir)).isDirectory()) fail('invalid_instance_directory', 'Expected one configuration directory for the allowed instance')
    await noLink(join(dir, 'proposals'), true)
    await mkdir(join(dir, 'proposals'), { recursive: true, mode: 0o700 })
    return dir
  }
  async dependencyDigest(instance: string): Promise<string | undefined> {
    const dir = await this.directory(instance)
    if (!this.owns(dir)) return this.withLock(dir, () => this.dependencyDigest(instance))
    return this.standalone ? (await dependencySnapshot(await this.directory(instance))).digest : undefined
  }
  async load(instance: string): Promise<Bundle> {
    const dir = await this.directory(instance)
    if (!this.owns(dir)) return this.withLock(dir, () => this.load(instance))
    const dependencies = this.standalone ? await dependencySnapshot(dir) : undefined
    const names = (await readdir(dir)).filter(n => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(n)).sort()
    const sources: Record<string, string> = {}
    for (const name of names) { await noLink(join(dir, name)); sources[name] = await readFile(join(dir, name), 'utf8') }
    const sourceHash = hash(sources)
    const cached = this.configCache.get(instance)
    // Reload tracked version sources when their content changes, including transitive config imports.
    let config = cached?.sourceHash === sourceHash ? cached.config
      : await importConfig(join(dir, 'config.ts'), sourceHash)
    let runtime: InstanceConfig | undefined, runtimeHash: string | undefined
    if (config.baseline === 'workbase-sdk') {
      const inputs = await replaySources(dir)
      for (const [path, bytes] of Object.entries(inputs)) sources[path] = bytes.toString('utf8')
      runtimeHash = hash(sources)
      if (cached && cached.runtimeHash !== runtimeHash && cached.sourceHash === sourceHash) config = await importConfig(join(dir, 'config.ts'), runtimeHash, Object.keys(inputs))
      if (inputs['runtime.ts']) {
        runtime = cached?.runtimeHash === runtimeHash ? cached.runtime : await importConfig(join(dir, 'runtime.ts'), runtimeHash, Object.keys(inputs))
        if (runtime?.id !== config.id || runtime.revision !== config.revision) fail('revision_mismatch', 'runtime.ts and config.ts disagree', 409)
      }
    }
    this.configCache.set(instance, { sourceHash, config, runtimeHash, runtime })
    const migrationNames = (await readdir(join(dir, 'migrations'))).filter(name => name !== '.gitkeep').sort()
    if (migrationNames.some(n => !/^\d{4}_[a-z0-9_]+\.sql$/.test(n))) fail('invalid_migrations', 'Unexpected migration filename')
    const migrations: Migration[] = []
    for (const name of migrationNames) { await noLink(join(dir, 'migrations', name)); migrations.push({ name, sql: await readFile(join(dir, 'migrations', name), 'utf8') }) }
    const indexes = sources['config.indexes.json'] ? z.array(z.strictObject({ entity: identifier, name: identifier, fields: z.array(identifier).min(1) })).parse(JSON.parse(sources['config.indexes.json'])) : []
    const guards = Object.fromEntries([
      ...Object.entries(dependencies?.guards ?? {}),
      ...Object.entries(sources).map(([name, source]) => [name, hash(source)]),
      ...migrations.map(m => [`migrations/${m.name}`, hash(m.sql)]),
    ])
    return { config, ...(runtime ? { runtime } : {}), indexes, migrations, ...(dependencies ? { dependencyDigest: dependencies.digest } : {}),
      fingerprint: hash({ sources, config, migrations, indexes, ...(dependencies ? { dependencyDigest: dependencies.digest } : {}) }), guards }
  }
  async find(id: string) {
    for (const instance of this.allowed) {
      const path = join(await this.proposalDirectory(instance), 'proposals', `${id}.json`)
      await noLink(path, true)
      try {
        const revoked = `${path}.sdk-revoked`
        await noLink(revoked, true)
        const pending = await readFile(revoked, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
        const proposal = JSON.parse(pending || await readFile(path, 'utf8'))
        const accepted = proposal?.kind !== 'sdk_upgrade' || proposal.evidence?.binding
          && await this.sdkAttemptMatches(instance, id, proposal.evidence.binding.attemptId)
        return { instance, path, proposal: pending !== undefined || unknownSdkEvidence.has(path) || !accepted ? revokedSdkRecord(proposal) : proposal }
      }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    return fail('proposal_not_found', 'Proposal not found in the allowlist', 404)
  }
  async locked<T>(instance: string, fn: () => Promise<T>) {
    const dir = await this.directory(instance)
    return this.withLock(dir, fn)
  }
  /** SDK revalidation must revoke evidence under the lock before recovery can
   * inspect application paths; the caller then recovers before any import. */
  async lockedProposal<T>(instance: string, fn: (recover: () => Promise<void>) => Promise<T>) {
    const dir = await this.proposalDirectory(instance)
    return this.withLock(dir, () => fn(() => this.rollback(dir)), false)
  }
  /** Only standalone servers execute SDK proposals and own exactly one Instance.
   * Open operations journal intent before discovery, acquisition, parsing, audit
   * or input reads, using the REQUEST id even for unreadable/forged metadata.
   * One append per start preserves ordering between competing MCP processes. */
  async startSdkAttempt(id: string, action?: string) {
    if (!this.standalone) return undefined
    await noLink(this.root); await noLink(join(this.root, 'proposals'))
    // Closed operations do not consume evidence. Peek only at canonical
    // metadata; unreadable/invalid records must still journal intent before
    // discovery fails. Workflow rechecks lifecycle under the Instance lock.
    if (action) {
      const proposal = await fileBytes(join(this.root, 'proposals', `${id}.json`))
        .then(bytes => bytes && JSON.parse(bytes.toString())).catch(() => undefined)
      if (proposal?.kind === 'sdk_upgrade' && (proposal.status === 'promoted' || proposal.status === 'discarded' && action !== 'discard')) return undefined
    }
    const attemptId = crypto.randomUUID()
    const handle = await open(join(this.root, 'proposals', `${id}.sdk-attempts.jsonl`),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      if (!(await handle.stat()).isFile()) fail('unsafe_path', 'SDK attempt journal must be a regular file', 403)
      await handle.writeFile(JSON.stringify({ event: 'attempt-started', proposalId: id, attemptId }) + '\n')
      await handle.sync()
    } finally { await handle.close() }
    await syncDirectory(join(this.root, 'proposals'))
    return attemptId
  }
  /** Intent must precede discovery even for an unknown proposal kind. Once it
   * is known to be a config proposal, retain its existing storage contract. */
  async clearNonSdkAttempt(id: string) {
    for (const instance of this.allowed) {
      await rm(join(await this.proposalDirectory(instance), 'proposals', `${id}.sdk-attempts.jsonl`), { force: true })
    }
  }
  /** A pending/unknown attempt never authorizes a proof. During revalidation,
   * compare the prior proof to the start immediately preceding OUR start; a
   * competing start also prevents publication from becoming consumable. */
  async sdkAttemptMatches(instance: string, id: string, accepted: string, current?: string) {
    try {
      const path = join(await this.proposalDirectory(instance), 'proposals', `${id}.sdk-attempts.jsonl`)
      const bytes = await fileBytes(path)
      if (!bytes || bytes.length > 4 * 1024 * 1024 || !bytes.toString().endsWith('\n')) return false
      // Older interrupted lines do not authorize anything. A later completed
      // verification can recover; only the latest start (and its predecessor
      // when consuming a prior proof during revalidation) matters.
      const entries = bytes.toString().trimEnd().split('\n').slice(current ? -2 : -1).map(line => JSON.parse(line))
      if (entries.some(entry => entry.event !== 'attempt-started' || entry.proposalId !== id || !z.uuid().safeParse(entry.attemptId).success)) return false
      if (current && entries.pop()?.attemptId !== current) return false
      return entries.at(-1)?.attemptId === accepted
    } catch { return false }
  }
  async sdkProposalSource(id: string) {
    const held = this.lockContext.getStore()
    if (!held?.active) fail('internal_error', 'SDK consumption requires the Instance lock', 500)
    const path = join(held.dir, 'proposals', `${id}.json`)
    if (unknownSdkEvidence.has(path) || await fileBytes(`${path}.sdk-revoked`) !== null) fail('validation_required', 'SDK evidence is revoked', 409)
    const bytes = await fileBytes(path)
    if (!bytes) fail('invalid_proposal', 'SDK proposal is unreadable', 409)
    return bytes
  }
  /** First fallible step under the canonical lock: publish revocation before
   * reading/parsing the proposal, audit, recovery or application inputs. The
   * hard link retains metadata across an interrupted rewrite, within proposals.
   * An existing marker means the previous proof's acceptance is unknown. */
  async revokeSdkProposal(id: string) {
    const held = this.lockContext.getStore()
    if (!held?.active) fail('internal_error', 'SDK revocation requires the Instance lock', 500)
    const path = join(held.dir, 'proposals', `${id}.json`), marker = `${path}.sdk-revoked`
    let previousAccepted = !unknownSdkEvidence.has(path)
    unknownSdkEvidence.add(path)
    try {
      try { await link(path, marker) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        previousAccepted = false
      }
      await noLink(marker)
      await syncDirectory(dirname(marker))
    } catch (error) {
      // A failed link must not leave a consumable canonical record. Even an
      // empty marker revokes it, without needing to read untrusted bytes.
      const marked = await writeFile(marker, '', { flag: 'wx', mode: 0o600 }).then(() => true, () => false)
      // The directory may reject BOTH marker publications while the existing
      // canonical file is writable. Invalidate that inode durably under the
      // lock; process-local revocation cannot protect a fresh MCP process.
      let tombstone = json({ kind: 'sdk_upgrade', proposalId: id, status: 'proposed' })
      try { tombstone = json(revokedSdkRecord(JSON.parse((await fileBytes(path))!.toString()))) }
      catch { /* Unreadable/invalid metadata cannot prevent durable invalidation. */ }
      const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW)
      try {
        if (!(await handle.stat()).isFile()) fail('unsafe_path', 'SDK proposal must be a regular file', 403)
        await handle.truncate(0)
        await handle.sync()
        await handle.writeFile(tombstone)
        await handle.sync()
      } finally { await handle.close() }
      if (marked) {
        const markerHandle = await open(marker, constants.O_WRONLY | constants.O_NOFOLLOW)
        try { await markerHandle.sync() } finally { await markerHandle.close() }
        await syncDirectory(dirname(marker))
      }
      throw error
    }
    const marked = await readFile(marker)
    const source = marked.length ? marked : await readFile(path)
    const proposal = JSON.parse(source.toString('utf8'))
    // Clear evidence before schema/identity validation can reject the record.
    await durableAtomic(path, json(revokedSdkRecord(proposal)))
    await unlink(marker)
    await syncDirectory(dirname(marker))
    unknownSdkEvidence.delete(path)
    return { proposal, source, previousAccepted }
  }
  // Startup and configuration operations call recovery while exclusively locked.
  async recover(dir: string) { await this.withLock(dir, async () => {}) }
  private async rollbackOwned(dir: string, journal: OwnedJournal, source: string, publicationFence?: Fence, expectedJournal?: FileIdentity) {
    const journalPath = join(dir, 'proposals/.promotion.json')
    const validated = await validatePaths(dir, journal.files.map(file => file.path), false)
    const fence = publicationFence ?? validated
    const marker = `${journalPath}.conflict-${hash(source).slice(0, 16)}`
    let journalFile: Awaited<ReturnType<typeof fileSnapshot>> = null
    let conflicted = false
    let failure: unknown
    const attempt = async (path: string, undo: () => Promise<void>) => {
      for (let retry = 0; retry < 2; retry++) {
        try { await undo(); return }
        catch (error) {
          // An ancestry change still stops recovery before touching another path.
          await fence(path)
          if (error instanceof TransactionConflict || (error as { code?: string }).code === 'unsafe_path') { conflicted = true; return }
          // Retry once, then leave the durable journal for a later recovery.
          if (retry === 1) failure ??= error
        }
      }
    }
    await attempt(journalPath, async () => {
      await fence(journalPath)
      journalFile = await fileSnapshot(journalPath)
      if (!journalFile || !journalFile.bytes.equals(Buffer.from(source)) || expectedJournal !== undefined && !sameFile(journalFile.identity, expectedJournal)) conflicted = true
    })
    await attempt(marker, async () => {
      await fence(marker)
      if (await lstat(marker).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })) conflicted = true
    })
    // Inspect and undo each publication independently. One bad retained capture
    // must never strand earlier manifest, lock, SQL or proposal publications.
    for (const file of journal.files) {
      const path = resolve(dir, file.path)
      await attempt(path, async () => {
        await fence(path)
        const temporary = file.capture && `${path}.${file.capture.token}.tmp`
        const saved = temporary ? await fileSnapshot(temporary) : null
        const validCapture = file.capture && sameFile(saved?.identity, file.capture.identity)
        if (saved && !validCapture) conflicted = true
        let current = await fileSnapshot(path)
        if (file.capture && sameFile(current?.identity, file.capture.identity) || file.before === null && current === null) return
        if (current !== null) {
          if (!sameFile(current.identity, file.after)) { conflicted = true; return }
          await removeOwned(path, file.after, fence)
          current = null
        }
        if (file.before !== null && current === null) {
          if (validCapture && temporary && file.capture) {
            await restoreRetained(temporary, path, file.capture.identity, fence)
          } else {
            // The durable original bytes still let us undo our publication if
            // its retained inode was lost. Preserve all evidence of that loss.
            conflicted = true
            await writeAbsent(path, Buffer.from(file.before, 'base64'), fence)
            if ((await fileSnapshot(path))?.identity.hash !== byteHash(Buffer.from(file.before, 'base64'))) conflict(path)
          }
        }
      })
    }
    for (const file of journal.files) {
      const stage = join(dir, 'proposals', `.promotion-${file.stage}.tmp`)
      await attempt(stage, async () => {
        await fence(stage)
        const staged = await fileSnapshot(stage)
        if (staged) {
          if (sameFile(staged.identity, file.after)) await unlink(stage)
          else conflicted = true
        }
      })
    }
    // An owned publication left by an I/O fault is pending rollback, not a
    // proven foreign identity. Finish it on retry before recording conflicts.
    if (failure) throw failure
    // Recheck every canonical result before disposing of any original. A later
    // restore may have raced an earlier file or its retained source.
    for (const file of journal.files) {
      const path = resolve(dir, file.path)
      await attempt(path, async () => {
        await fence(path)
        const current = await fileSnapshot(path)
        if (file.capture ? !sameFile(current?.identity, file.capture.identity) : current !== null) conflicted = true
        if (file.capture) {
          const saved = await fileSnapshot(`${path}.${file.capture.token}.tmp`)
          if (saved && !sameFile(saved.identity, file.capture.identity)) conflicted = true
        }
      })
    }
    if (failure) throw failure
    if (conflicted) {
      await fence(marker)
      try { await writeAbsent(marker, Buffer.from(source), fence) }
      catch (error) { if (!(error instanceof TransactionConflict)) throw error }
      await syncDirectory(dirname(marker))
      conflict(journalPath)
    }
    // Cleanup begins only after every canonical original has been verified.
    for (const directory of new Set(journal.files.map(file => dirname(resolve(dir, file.path))))) await syncDirectory(directory)
    for (const file of journal.files) if (file.capture) {
      const temporary = `${resolve(dir, file.path)}.${file.capture.token}.tmp`
      if (await fileSnapshot(temporary)) {
        await assertOwned(temporary, file.capture.identity, fence)
        await unlink(temporary)
      }
    }
    await removeOwned(journalPath, journalFile!.identity, fence)
    await syncDirectory(dirname(journalPath))
  }
  private async rollback(dir: string, publicationFence?: Fence) {
    const journalPath = join(dir, 'proposals', '.promotion.json')
    await publicationFence?.(journalPath)
    await noLink(dir); await noLink(dirname(journalPath)); await noLink(journalPath, true)
    let source: string
    try { source = await readFile(journalPath, 'utf8') }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    let parsed: unknown
    try { parsed = JSON.parse(source) } catch { fail('invalid_journal', 'Invalid promotion journal', 500) }
    const result = journalSchema.safeParse(parsed)
    if (!result.success) fail('invalid_journal', 'Invalid promotion journal', 500)
    const journal = result.data
    if ('version' in journal && journal.version === 3) return this.rollbackOwned(dir, journal, source, publicationFence)
    const validated = await validatePaths(dir, journal.files.map(file => file.path))
    const fence = publicationFence ?? validated
    // Compatibility for pre-identity journals. Their retained names cannot be
    // authenticated, even when their bytes match, and must remain untouched.
    for (const file of journal.files) if ('capture' in file && file.capture) {
      const temporary = `${resolve(dir, file.path)}.${file.capture}.tmp`
      await fence(temporary)
      if (await fileBytes(temporary) !== null) conflict(file.path)
    }
    const txid = hash(source).slice(0, 16)
    const marker = `${journalPath}.conflict-${txid}`
    await fence(marker)
    if (await fileBytes(marker) !== null) conflict(journalPath)
    let conflicted = false
    for (const file of journal.files) {
      const path = resolve(dir, file.path)
      await fence(path)
      const before = file.before === null ? null : Buffer.from(file.before, 'version' in journal ? 'base64' : 'utf8')
      const digestBytes = 'version' in journal ? byteHash : (bytes: Buffer) => hash(bytes.toString('utf8'))
      const current = await fileBytes(path)
      if (current === null && before === null || current !== null && before !== null && current.equals(before)) continue
      if (current !== null && file.afterHash !== undefined && digestBytes(current) !== file.afterHash) { conflicted = true; continue }
      try {
        if (current !== null) await capture(path, byteHash(current), byteHash, fence, txid)
        if (before !== null) await writeAbsent(path, before, fence)
      } catch (error) {
        await fence(path)
        if (!(error instanceof TransactionConflict)) throw error
        conflicted = true
      }
    }
    if (conflicted) {
      await fence(marker)
      try { await link(journalPath, marker) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await syncDirectory(dirname(marker))
      conflict(journalPath)
    }
    await capture(journalPath, byteHash(Buffer.from(source)), byteHash, fence, txid)
  }

  private async contentHash(path: string) {
    await noLink(path, true)
    try { return hash(await readFile(path, 'utf8')) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  }
  private publicationHash(path: string, bytes: Buffer) {
    return ['package.json', 'bun.lock'].includes(path) ? byteHash(bytes) : hash(bytes.toString('utf8'))
  }
  // Caller holds the instance lock across loading guards, staging, publication and rollback.
  async commit(instance: string, files: { path: string; data: string | Uint8Array; create?: boolean }[], guards: Bundle['guards'], verify?: () => Promise<void>): Promise<void> {
    const dir = await this.directory(instance)
    if (!this.owns(dir)) return this.withLock(dir, () => this.commit(instance, files, guards, verify))
    const expected: Record<string, string | null> = { ...guards }
    const expectedBytes = new Map<string, string | null>()
    const journal: OwnedJournal = { version: 3, transactionId: crypto.randomUUID(), files: [] }
    let source: string
    const staged = new Map<string, { path: string; identity: FileIdentity }>()
    const fence = await validatePaths(dir, files.map(file => file.path))
    const cleanupStaged = async () => {
      for (const file of staged.values()) {
        if (sameFile((await fileSnapshot(file.path))?.identity, file.identity)) {
          await fence(file.path); await unlink(file.path)
        }
      }
    }
    try {
      for (const f of files) {
        const path = join(dir, f.path)
        const before = await fileSnapshot(path)
        if (f.create && before !== null) fail('migration_exists', 'Migration file already exists', 409)
        if (!Object.hasOwn(expected, f.path)) expected[f.path] = before === null ? null : this.publicationHash(f.path, before.bytes)
        expectedBytes.set(f.path, before?.identity.hash ?? null)
        const stage = crypto.randomUUID(), temporary = join(dir, 'proposals', `.promotion-${stage}.tmp`)
        await fence(temporary)
        const handle = await open(temporary, 'wx', 0o600)
        let identity: FileIdentity
        try {
          await handle.writeFile(f.data)
          await handle.sync()
          const stat = await handle.stat({ bigint: true })
          identity = { dev: stat.dev.toString(), ino: stat.ino.toString(), hash: byteHash(Buffer.from(f.data)) }
        } finally { await handle.close() }
        staged.set(f.path, { path: temporary, identity })
        journal.files.push({ path: f.path, before: before?.bytes.toString('base64') ?? null, stage, after: identity,
          ...(before ? { capture: { token: crypto.randomUUID(), identity: before.identity } } : {}) })
      }
      source = json(journal)
      if (!journalSchema.safeParse(JSON.parse(source)).success) fail('invalid_journal', 'Invalid promotion journal', 500)
    } catch (error) { await cleanupStaged(); throw error }
    const internalPaths = new Set([
      ...[...staged.values()].map(file => file.path),
      ...journal.files.flatMap(file => file.capture ? [`${join(dir, file.path)}.${file.capture.token}.tmp`] : []),
    ])
    const check = async (temporary?: string, publishing?: string) => {
      const paths = new Set([
        ...Object.keys(expected),
        ...(await readdir(dir)).filter(n => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(n)),
        ...(await readdir(join(dir, 'migrations'))).map(n => `migrations/${n}`),
      ])
      // Read the destination last, immediately before capturing it for publication.
      if (publishing) { paths.delete(publishing); paths.add(publishing) }
      for (const path of paths) {
        if (join(dir, path) === temporary || internalPaths.has(join(dir, path))) continue
        if ((['package.json', 'bun.lock'].includes(path)
          ? await dependencyHash(join(dir, path)) : await this.contentHash(join(dir, path))) !== (expected[path] ?? null)
          || (expectedBytes.has(path) && await dependencyHash(join(dir, path)) !== expectedBytes.get(path))) {
          fail('concurrent_modification', `Instance files changed during promotion: ${path}`, 409)
        }
      }
    }
    const journalPath = join(dir, 'proposals/.promotion.json')
    let journalIdentity: FileIdentity | undefined
    try {
      await check()
      await writeAbsent(journalPath, Buffer.from(source), fence, async temporary => {
        journalIdentity = (await fileSnapshot(temporary))!.identity
      })
      // The immutable durable journal records original and staged inode identities
      // before capture or publication. Restart never infers ownership from bytes.
      await syncDirectory(dirname(journalPath))
      for (const f of files) {
        const path = join(dir, f.path), stage = staged.get(f.path)!
        await check(stage.path, f.path)
        const file = journal.files.find(file => file.path === f.path)!
        if (file.capture) await retain(path, `${path}.${file.capture.token}.tmp`, file.capture.identity, fence)
        await assertOwned(stage.path, stage.identity, fence)
        try { await install(stage.path, path, fence, undefined, stage.identity) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict(path); throw error }
        await assertOwned(path, stage.identity, fence)
        expected[f.path] = this.publicationHash(f.path, Buffer.from(f.data))
        expectedBytes.set(f.path, byteHash(Buffer.from(f.data)))
      }
      await check()
      await verify?.()
      await check()
      for (const file of journal.files) if (file.capture) {
        await assertOwned(`${join(dir, file.path)}.${file.capture.token}.tmp`, file.capture.identity, fence)
      }
      for (const directory of new Set(files.map(file => dirname(join(dir, file.path))))) await syncDirectory(directory)
      await removeOwned(journalPath, journalIdentity!, fence)
      await syncDirectory(dirname(journalPath))
    } catch (error) {
      // Only recover a journal this attempt actually installed. An occupied
      // journal destination belongs to somebody else even if its bytes match.
      if (journalIdentity) await this.rollbackOwned(dir, journal, source, fence, journalIdentity)
      throw error
    } finally { await cleanupStaged() }
    // Journal retirement is the durable commit point. Failed disposal can leave
    // harmless retained originals, but cannot revoke a completed publication.
    for (const file of journal.files) if (file.capture) {
      const temporary = `${join(dir, file.path)}.${file.capture.token}.tmp`
      try {
        await assertOwned(temporary, file.capture.identity, fence)
        await unlink(temporary)
      } catch { /* Leave an unverified or undisposable retained file untouched. */ }
    }
  }
}
