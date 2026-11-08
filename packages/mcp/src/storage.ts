import { AsyncLocalStorage } from 'node:async_hooks'
import { acquireInstanceLock } from './instance-lock.ts'
import { devFixtures } from './dev-support.ts'
import { noLink } from './paths.ts'
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
export type Bundle = { config: InstanceConfig; migrations: Migration[]; indexes: Index[]; fingerprint: string; dependencyDigest?: string; guards: Record<string, string | null> }
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
const require = createRequire(import.meta.url)
async function importConfig(path: string, sourceHash: string) {
  if (process.versions.bun) {
    // Reload sibling version sources and history JSON as well as the entrypoint.
    // Keep SDK/plugin modules cached so canonical plugin provenance is preserved.
    for (const name of (await readdir(dirname(path))).filter(n => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(n))) {
      const source = join(dirname(path), name)
      await noLink(source)
      delete require.cache[source]
    }
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
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!(await handle.stat()).isFile()) fail('unsafe_path', 'Transaction paths must be regular files', 403)
    return await handle.readFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('unsafe_path', 'Symlinks are forbidden', 403)
    throw error
  } finally { await handle?.close() }
}
const byteHash = (bytes: Uint8Array) => hash(Buffer.from(bytes).toString('base64'))
async function dependencyHash(path: string) {
  const bytes = await fileBytes(path)
  return bytes === null ? null : byteHash(bytes)
}
const transactionPath = z.string().regex(/^(package\.json|bun\.lock|config(?:\.v[1-9][0-9]*)?\.ts|config\.(?:indexes|versions)\.json|migrations\/\d{4}_[a-z0-9_]+\.sql|proposals\/[a-f0-9-]+\.json)$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const base64 = z.string().refine(value => Buffer.from(value, 'base64').toString('base64') === value)
const journalSchema = z.union([
  z.strictObject({ version: z.literal(2), files: z.array(z.strictObject({ path: transactionPath, before: base64.nullable(), afterHash: digest })) }),
  z.strictObject({ files: z.array(z.strictObject({ path: transactionPath, before: z.string().nullable(), afterHash: digest.optional() })) }),
])
// Validate all destinations before either publication or recovery can mutate anything.
async function validatePaths(dir: string, paths: string[]) {
  dir = resolve(dir)
  const seen = new Set<string>()
  await noLink(dir)
  const directories = new Map<string, { dev: number; ino: number }>()
  for (const parent of [resolve(dir), join(dir, 'proposals')]) {
    const stat = await lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_path', 'Transaction ancestors must be real directories', 403)
    directories.set(parent, { dev: stat.dev, ino: stat.ino })
  }
  for (const path of paths) {
    if (!transactionPath.safeParse(path).success || seen.has(path)) fail('invalid_journal', 'Invalid promotion journal path', 500)
    seen.add(path)
    const destination = resolve(dir, path)
    await noLink(dirname(destination)); await noLink(destination, true)
    for (let parent = dirname(destination); ; parent = dirname(parent)) {
      const stat = await lstat(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_path', 'Transaction ancestors must be real directories', 403)
      const previous = directories.get(parent)
      if (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) conflict(path)
      directories.set(parent, { dev: stat.dev, ino: stat.ino })
      if (parent === resolve(dir)) break
    }
    // Reject directories and other special files as well as symlinks.
    await fileBytes(destination)
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
      const stat = await lstat(parent).catch(() => conflict(path))
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
// Never overwrite an unchecked destination, including while returning a capture.
async function install(captured: string, path: string, fence: Fence, published?: () => void) {
  await fence(path)
  try { await link(captured, path) }
  catch (error) {
    // A syscall wrapper may fail after the link completed. Only the staged inode,
    // never matching planned bytes, can prove publication in that case.
    if (published) {
      await fence(path)
      const staged = await lstat(captured)
      const installed = await lstat(path).catch(() => undefined)
      if (installed?.dev === staged.dev && installed.ino === staged.ino) published()
    }
    throw error
  }
  published?.()
  await fence(captured)
  await unlink(captured)
}
async function capture(path: string, expected: string, digestBytes: (bytes: Buffer) => string, fence: Fence, txid: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await fence(path)
  try { await rename(path, temporary) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  await fence(temporary)
  let bytes: Buffer | null
  try { bytes = await fileBytes(temporary) }
  catch (error) {
    if ((error as { code?: string }).code !== 'unsafe_path') throw error
    bytes = null
  }
  if (bytes === null || digestBytes(bytes) !== expected) {
    try { await install(temporary, path, fence) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Deterministic conflict artifact; no-replace also protects an earlier artifact.
      for (let suffix = 0; ; suffix++) {
        try {
          await install(temporary, `${path}.conflict-${txid}${suffix ? `-${suffix}` : ''}`, fence)
          break
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
    }
    conflict(path)
  }
  await fence(temporary)
  await unlink(temporary)
  return true
}
async function writeAbsent(path: string, bytes: Uint8Array, fence: Fence, beforeInstall?: (temporary: string) => Promise<void>, published?: () => void) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await fence(temporary)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await fence(temporary)
    await handle.writeFile(bytes)
    await fence(temporary)
    await handle.sync()
  } finally { await handle.close() }
  try {
    await beforeInstall?.(temporary)
    await install(temporary, path, fence, published)
  } catch (error) {
    await fence(temporary)
    await unlink(temporary).catch(cleanupError => { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError })
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
  private async withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    if (this.owns(dir)) return fn()
    const release = await acquireInstanceLock(dir)
    const held = { dir, active: true }
    try {
      await this.rollback(dir)
      return await this.lockContext.run(held, fn)
    } finally { held.active = false; await release() }
  }
  private configCache = new Map<string, { sourceHash: string; config: InstanceConfig }>()
  private standalone = false
  public allowed: Set<string>
  constructor(public root: string, private requestedAllowed?: Set<string>) {
    this.allowed = requestedAllowed ?? new Set(devFixtures?.allowed ?? [])
  }
  async init(allowEmpty = false) {
    this.allowed = this.requestedAllowed ?? new Set(devFixtures?.allowed ?? [])
    this.standalone = false
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
    const config = cached?.sourceHash === sourceHash ? cached.config
      : await importConfig(join(dir, 'config.ts'), sourceHash)
    this.configCache.set(instance, { sourceHash, config })
    const migrationNames = (await readdir(join(dir, 'migrations'))).sort()
    if (migrationNames.some(n => !/^\d{4}_[a-z0-9_]+\.sql$/.test(n))) fail('invalid_migrations', 'Unexpected migration filename')
    const migrations: Migration[] = []
    for (const name of migrationNames) { await noLink(join(dir, 'migrations', name)); migrations.push({ name, sql: await readFile(join(dir, 'migrations', name), 'utf8') }) }
    const indexes = sources['config.indexes.json'] ? z.array(z.strictObject({ entity: identifier, name: identifier, fields: z.array(identifier).min(1) })).parse(JSON.parse(sources['config.indexes.json'])) : []
    const guards = Object.fromEntries([
      ...Object.entries(dependencies?.guards ?? {}),
      ...Object.entries(sources).map(([name, source]) => [name, hash(source)]),
      ...migrations.map(m => [`migrations/${m.name}`, hash(m.sql)]),
    ])
    return { config, indexes, migrations, ...(dependencies ? { dependencyDigest: dependencies.digest } : {}),
      fingerprint: hash({ sources, config, migrations, indexes, ...(dependencies ? { dependencyDigest: dependencies.digest } : {}) }), guards }
  }
  async find(id: string) {
    for (const instance of this.allowed) {
      const path = join(await this.directory(instance), 'proposals', `${id}.json`)
      await noLink(path, true)
      try { return { instance, path, proposal: JSON.parse(await readFile(path, 'utf8')) } }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    return fail('proposal_not_found', 'Proposal not found in the allowlist', 404)
  }
  async locked<T>(instance: string, fn: () => Promise<T>) {
    const dir = await this.directory(instance)
    return this.withLock(dir, fn)
  }
  // Startup and configuration operations call recovery while exclusively locked.
  async recover(dir: string) { await this.withLock(dir, async () => {}) }
  private async rollback(dir: string, conflictPath?: string, publicationFence?: Fence, published?: Set<string>, captured?: Set<string>) {
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
    const validated = await validatePaths(dir, journal.files.map(file => file.path))
    const fence = publicationFence ?? validated
    const txid = hash(source).slice(0, 16)
    const marker = `${journalPath}.conflict-${txid}`
    await fence(marker)
    if (await fileBytes(marker) !== null) conflict(journalPath)
    const retainConflict = async () => {
      // Persist known conflicts: a later retry must not mistake an external
      // creator's identical bytes for our publication and delete them.
      await fence(marker)
      try { await link(journalPath, marker) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    // For unpublished captures, the no-replace restore below decides whether
    // an external occupant still exists, even if publication failed with EEXIST.
    if (conflictPath !== undefined && captured?.has(conflictPath) && !published?.has(conflictPath)) conflictPath = undefined
    if (conflictPath !== undefined) await retainConflict()
    let conflicted = conflictPath !== undefined
    for (const file of journal.files) {
      const path = resolve(dir, file.path)
      // A failed no-replace install/capture is known to be external even when
      // its bytes happen to equal our before/after snapshot.
      const unpublishedCapture = captured?.has(path) && !published?.has(path)
      if (path === conflictPath && !unpublishedCapture) continue
      await fence(path)
      const before = file.before === null ? null : Buffer.from(file.before, 'version' in journal ? 'base64' : 'utf8')
      const digestBytes = 'version' in journal ? byteHash : (bytes: Buffer) => hash(bytes.toString('utf8'))
      const current = await fileBytes(path)
      if (unpublishedCapture && before !== null) {
        // Capture removed our original, but no replacement was published. Return
        // its exact journal bytes without claiming any new occupant of the path.
        try { await writeAbsent(path, before, fence) }
        catch (error) {
          await fence(path)
          if ((error as { code?: string }).code !== 'concurrent_modification') throw error
          for (let suffix = 0; ; suffix++) {
            try {
              await writeAbsent(`${path}.conflict-${txid}${suffix ? `-${suffix}` : ''}`, before, fence)
              break
            } catch (artifactError) {
              if ((artifactError as { code?: string }).code !== 'concurrent_modification') throw artifactError
            }
          }
          conflicted = true
        }
        continue
      }
      // Already restored entries are safe to retry. Other bytes are a conflict.
      if (current === null && before === null || current !== null && before !== null && current.equals(before)) continue
      // Forward rollback owns only completed publications. Startup recovery has no
      // progress record and remains hash-based: identical external bytes after a
      // crash are indistinguishable from transaction bytes.
      if (published && !published.has(path)) { conflicted = true; continue }
      if (current !== null && file.afterHash !== undefined && digestBytes(current) !== file.afterHash) { conflicted = true; continue }
      try {
        // Even legacy UTF-8 ownership hashes must capture the exact bytes just observed.
        if (current !== null) await capture(path, byteHash(current), byteHash, fence, txid)
        if (before !== null) await writeAbsent(path, before, fence)
      } catch (error) {
        // An ancestry change must stop immediately, including before any cleanup.
        await fence(path)
        if ((error as { code?: string }).code !== 'concurrent_modification') throw error
        conflicted = true
      }
    }
    if (conflicted) { await retainConflict(); conflict(journalPath) }
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
  async commit(instance: string, files: { path: string; data: string; create?: boolean }[], guards: Bundle['guards']): Promise<void> {
    const dir = await this.directory(instance)
    if (!this.owns(dir)) return this.withLock(dir, () => this.commit(instance, files, guards))
    const expected: Record<string, string | null> = { ...guards }
    const expectedBytes = new Map<string, string | null>()
    const journal: { version: 2; files: { path: string; before: string | null; afterHash: string }[] } = { version: 2, files: [] }
    const fence = await validatePaths(dir, files.map(file => file.path))
    for (const f of files) {
      const path = join(dir, f.path)
      await noLink(path, true)
      const before = await fileBytes(path)
      if (f.create && before !== null) fail('migration_exists', 'Migration file already exists', 409)
      if (!Object.hasOwn(expected, f.path)) expected[f.path] = before === null ? null : this.publicationHash(f.path, before)
      expectedBytes.set(f.path, before === null ? null : byteHash(before))
      journal.files.push({ path: f.path, before: before?.toString('base64') ?? null, afterHash: byteHash(Buffer.from(f.data)) })
    }
    const check = async (temporary?: string, publishing?: string) => {
      const paths = new Set([
        ...Object.keys(expected),
        ...(await readdir(dir)).filter(n => /^config(?:\.[a-z0-9_-]+)?\.(ts|json)$/.test(n)),
        ...(await readdir(join(dir, 'migrations'))).map(n => `migrations/${n}`),
      ])
      // Read the destination last, immediately before capturing it for publication.
      if (publishing) { paths.delete(publishing); paths.add(publishing) }
      for (const path of paths) {
        if (join(dir, path) === temporary) continue
        if ((['package.json', 'bun.lock'].includes(path)
          ? await dependencyHash(join(dir, path)) : await this.contentHash(join(dir, path))) !== (expected[path] ?? null)
          || (expectedBytes.has(path) && await dependencyHash(join(dir, path)) !== expectedBytes.get(path))) {
          fail('concurrent_modification', `Instance files changed during promotion: ${path}`, 409)
        }
      }
    }
    const published = new Set<string>()
    const captured = new Set<string>()
    await check()
    try {
      await writeAbsent(join(dir, 'proposals', '.promotion.json'), Buffer.from(json(journal)), fence)
      for (const f of files) {
        const path = join(dir, f.path)
        await writeAbsent(path, Buffer.from(f.data), fence, async temporary => {
          await check(temporary, f.path)
          const owned = expectedBytes.get(f.path)
          if (owned != null && await capture(path, owned, byteHash, fence, hash(json(journal)).slice(0, 16))) captured.add(path)
        }, () => { published.add(path) })
        expected[f.path] = this.publicationHash(f.path, Buffer.from(f.data))
        expectedBytes.set(f.path, byteHash(Buffer.from(f.data)))
      }
      await check()
      await capture(join(dir, 'proposals', '.promotion.json'), byteHash(Buffer.from(json(journal))), byteHash, fence, hash(json(journal)).slice(0, 16))
    } catch (e) {
      // Keep the original ancestry identities across forward rollback too.
      for (const f of files) await fence(join(dir, f.path))
      if (e instanceof TransactionConflict && e.path === join(dir, 'proposals', '.promotion.json')) throw e
      await this.rollback(dir, e instanceof TransactionConflict ? e.path : undefined, fence, published, captured)
      throw e
    }
  }
}
