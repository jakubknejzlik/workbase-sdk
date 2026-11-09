import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, opendir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { verifySdkInstalled, type SdkVerification } from './sdk-integrity'

// SemVer 2.0, with no coercion, range, tag or trailing newline acceptance.
export const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
export const isExactVersion = (version: string) => exactVersion.test(version) && !/\s/.test(version)
export type RegistryPackage = { name: string; version: string; tarball: string; integrity: string; lockIntegrity?: string }
export type RegistrySdk = { source: 'registry'; version: string; registry: string; packages: RegistryPackage[] }
export type RegistryErrorCode = 'registry_selection' | 'registry_metadata' | 'registry_install' | 'registry_integrity' | 'registry_guard'
export class RegistrySdkError extends Error {
  constructor(public readonly code: RegistryErrorCode, message: string, options?: ErrorOptions) {
    super(`Registry SDK: ${message}`, options); this.name = 'RegistrySdkError'
  }
}
export const sdkNames = ['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp']
function httpUrl(value: string) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Očekávána HTTP(S) URL bez přihlašovacích údajů.')
  return url.href.replace(/\/$/, '')
}
export type RegistryOptions = { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }
async function fetchRegistry(url: string, options: RegistryOptions, maxBytes: number) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await fetch(url, { signal })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}: ${url}`) }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body!.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > (options.maxBytes ?? maxBytes)) throw new Error('Registry response exceeds byte bound')
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  return Buffer.concat(chunks)
}
export async function resolveRegistrySdk(version: string, registry = 'https://registry.npmjs.org', options: RegistryOptions = {}): Promise<RegistrySdk> {
  if (!isExactVersion(version)) throw new RegistrySdkError('registry_selection', 'verze musí být přesný SemVer.')
  try {
    registry = httpUrl(registry)
    const packages = await Promise.all(sdkNames.map(async name => {
      const metadata = JSON.parse((await fetchRegistry(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, options, 1024 * 1024)).toString('utf8')) as RegistryPackage & { dist?: { tarball?: string; integrity?: string } }
      const dist = metadata.dist
      if (metadata.name !== name || metadata.version !== version || !dist || typeof dist.tarball !== 'string'
        || typeof dist.integrity !== 'string' || !validIntegrity(dist.integrity)) {
        throw new Error(`${name}@${version}: chybí shodná verze nebo dist.integrity/tarball.`)
      }
      return { name, version, tarball: httpUrl(dist.tarball), integrity: dist.integrity }
    }))
    return { source: 'registry', version, registry, packages }
  } catch (cause) { throw new RegistrySdkError('registry_metadata', `nelze ověřit všechny tři balíčky @${version}: ${cause instanceof Error ? cause.message : cause}`, { cause }) }
}
function parseLock(text: string) {
  // Bun's text lock is JSONC. Preserve strings verbatim while skipping comments
  // and trailing commas; do not depend on a Bun global in the Node MCP process.
  const tokens = (text.match(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\s+|./gs) ?? [])
    .filter(token => !token.startsWith('//') && !token.startsWith('/*'))
  return JSON.parse(tokens.filter((token, index) => token !== ',' || !/^[}\]]$/.test(tokens.slice(index + 1).find(next => next.trim()) ?? '')).join(''))
}
export class RegistryDependencyError extends RegistrySdkError {
  constructor(public readonly packageName: string, public readonly field: string) {
    // Never echo a source specification: URLs can contain credentials or tokens.
    super('registry_guard', `${packageName}: ${field}: expected registry semver or a resolved source from the configured registry.`)
    this.name = 'RegistryDependencyError'
  }
}
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions']
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
// Syntax only: Bun resolves these exact/range requirements through our registry.
// A positive grammar excludes tags, paths and every source protocol.
const part = '(?:0|[1-9]\\d*|[xX*])'
const partial = new RegExp(`^${part}(?:\\.${part}(?:\\.${part})?)?$`)
const tarballSuffix = /\.(?:tgz|tar(?:\.(?:gz|bz2|xz|zst))?)$/i
function registryRange(value: unknown): value is string {
  // Bun 1.4.3 (c6da4a4d3), src/install/dependency.rs:705, trims only
  // space/tab/CR/LF before classification. JS-only whitespace can become a tag.
  if (typeof value !== 'string' || !/^[\x20-\x7e\t\r\n]+$/.test(value)) return false
  const requirement = value.replace(/^[ \t\r\n]+/, '')
  // Bun's x/X branch is npm only for a single byte or a following dot;
  // other continuations fall through to a tag unless a union contains '|'.
  if ((requirement[0] === 'x' || requirement[0] === 'X') && requirement.length !== 1
    && requirement[1] !== '.' && !requirement.includes('|')) return false
  // A SemVer-looking prerelease can be a local tarball to Bun. Check every
  // bound/comparator, including inside unions; never coerce prefixes or builds.
  const version = (text: string) => !text.includes('+') && !tarballSuffix.test(text)
    && (partial.test(text) || isExactVersion(text))
  return requirement.trim().split('||').every(range => {
    const hyphen = range.trim().split(/\s+-\s+/)
    if (hyphen.length === 2) return hyphen.every(version)
    // Comparator whitespace is allowed; a bare operator is never a range.
    return range.trim().replace(/(<=|>=|[<>=~^])\s+/g, '$1').split(/\s+/)
      .every(comparator => version(comparator.replace(/^(?:<=|>=|[<>=~^])/, '')))
  })
}
function registryAlias(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('npm:')) return
  const separator = value.lastIndexOf('@'), name = value.slice(4, separator)
  // New npm names are lowercase, URL-safe and at most 214 bytes. Never
  // interpret path components, escaped separators or source protocols as names.
  if (name.length > 214 || name.includes('..') || /\s/.test(name) || name === 'node_modules' || name === 'favicon.ico'
    || !/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name)) return
  if (registryRange(value.slice(separator + 1))) return name
}
type RegistryAliases = Map<string, Set<string>>
function dependencyMap(entries: unknown, field: string, nested: boolean, parent = '<manifest>', aliases?: RegistryAliases) {
  if (!record(entries)) throw new RegistryDependencyError(parent, field)
  for (const [name, value] of Object.entries(entries)) {
    const path = `${field}.${name}`, packageName = name === '.' ? parent : name
    if (nested && record(value)) dependencyMap(value, path, true, packageName, aliases)
    else if (!registryRange(value)) {
      const target = registryAlias(value)
      if (!target) throw new RegistryDependencyError(packageName, path)
      if (aliases) {
        const targets = aliases.get(packageName) ?? new Set<string>()
        targets.add(target); aliases.set(packageName, targets)
      }
    }
  }
}
function inspectRegistryManifest(manifest: Record<string, any>, field: string, aliases?: RegistryAliases) {
  for (const key of dependencyFields) if (manifest[key] !== undefined) dependencyMap(manifest[key], `${field}.${key}`, key === 'overrides' || key === 'resolutions', '<manifest>', aliases)
}
export function assertRegistryManifest(manifest: Record<string, any>, field = 'package.json') {
  inspectRegistryManifest(manifest, field)
}
/** Inspect captured lock metadata before any target installation is allowed. */
export function assertRegistryLock(text: string, registry = 'https://registry.npmjs.org') {
  const lock = parseLock(text)
  const origin = new URL(httpUrl(registry)).origin
  if (!record(lock) || !record(lock.workspaces) || !record(lock.packages)) throw new RegistryDependencyError('<lockfile>', 'bun.lock')
  const aliases: RegistryAliases = new Map()
  inspectRegistryManifest(lock, 'bun.lock', aliases)
  for (const [key, workspace] of Object.entries(lock.workspaces)) {
    if (!record(workspace)) throw new RegistryDependencyError('<workspace>', `bun.lock.workspaces.${key}`)
    inspectRegistryManifest(workspace, `bun.lock.workspaces.${key}`, aliases)
  }
  // Collect transitive aliases before checking resolutions: a target's tuple
  // may sort before the package that declares its alias.
  for (const [key, tuple] of Object.entries(lock.packages)) {
    if (Array.isArray(tuple) && record(tuple[2])) inspectRegistryManifest(tuple[2], `bun.lock.packages.${key}.metadata`, aliases)
  }
  for (const [key, tuple] of Object.entries(lock.packages)) {
    const field = `bun.lock.packages.${key}`
    // Registry tuples contain an exact name/version, registry URL (empty means
    // the configured registry), dependency metadata and integrity. Other Bun
    // source types have different tuples and must fail closed before installation.
    if (!Array.isArray(tuple) || typeof tuple[0] !== 'string') throw new RegistryDependencyError(key, `${field}.resolution`)
    const resolution = /^(?:@[^/@]+\/)?[^/@]+@(.+)$/.exec(tuple[0])
    const packageName = resolution ? tuple[0].slice(0, -(resolution[1].length + 1)) : key
    const alias = /(?:^|\/)((?:@[^/]+\/)?[^/]+)$/.exec(key)?.[1]
    if (!resolution || !isExactVersion(resolution[1]) || (key !== packageName && !key.endsWith('/' + packageName)
      && !aliases.get(alias ?? '')?.has(packageName))) throw new RegistryDependencyError(packageName, `${field}.resolution`)
    if (tuple.length !== 4 || !record(tuple[2]) || typeof tuple[3] !== 'string') throw new RegistryDependencyError(packageName, `${field}.metadata`)
    if (tuple[1] !== '') {
      try {
        if (typeof tuple[1] !== 'string' || new URL(httpUrl(tuple[1])).origin !== origin) throw new Error('Foreign registry')
      } catch { throw new RegistryDependencyError(packageName, `${field}.registry`) }
    }
    // Dependency metadata was checked above; bin paths and integrity encodings
    // are not dependency specifications.
  }
  return lock as Record<string, unknown> & {
    workspaces: Record<string, Record<string, unknown>>
    packages: Record<string, [string, string, Record<string, unknown>, string]>
  }
}
async function assertSdkLayout(root: string) {
  const modules = resolve(root, 'node_modules'), scope = join(modules, '@workbasehq')
  const fold = (name: string) => name.normalize('NFC').replace(/[A-Z]/g, letter => letter.toLowerCase())
  const maxDepth = 64, maxEntries = 100000
  let entries = 0
  const guard = (path: string, reason: string) => new RegistrySdkError('registry_guard', `${relative(root, path)}: ${reason}.`)
  const count = (path: string) => { if (++entries > maxEntries) throw guard(path, `SDK layout entry limit exceeded (${maxEntries})`) }
  const binLink = async (path: string) => {
    // Only package-manager bin links to ordinary files are permitted. Inspect
    // every target component with lstat; never follow a link or a link chain.
    const target = resolve(dirname(path), await readlink(path)), rel = relative(modules, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw guard(path, 'odkaz mimo instalaci není povolen')
    const parts = rel.split(sep)
    if (parts.length > maxDepth) throw guard(path, `SDK layout depth limit exceeded (${maxDepth})`)
    let current = modules
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]); count(path)
      const stat = await lstat(current)
      if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw guard(path, 'očekáván odkaz na běžný soubor bez dalších odkazů')
    }
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    // Stream entries so a wide directory cannot allocate an unbounded listing.
    for await (const entry of await opendir(directory)) {
      const path = join(directory, entry.name); count(path)
      // Detect aliases independently of filesystem case/normalization behavior.
      // Only the byte-identical top-level scope is exempt; reject every child
      // of other matching scopes, regardless of the package name's spelling.
      if (fold(basename(directory)) === '@workbasehq' && fold(basename(dirname(directory))) === 'node_modules' && directory !== scope) {
        throw new RegistrySdkError('registry_integrity', `neočekávané vnořené SDK: ${relative(root, path)}.`)
      }
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        if (basename(directory) !== '.bin' || basename(dirname(directory)) !== 'node_modules') throw guard(path, 'odkaz není povolen')
        await binLink(path)
      } else if (stat.isDirectory()) {
        if (depth + 1 > maxDepth) throw guard(path, `SDK layout depth limit exceeded (${maxDepth})`)
        await walk(path, depth + 1)
      } else if (!stat.isFile()) throw guard(path, 'očekáván běžný soubor nebo adresář')
    }
  }
  await walk(modules, 0)
}
/** Check both the installed lock graph and manifest. SDK duplicates are refused,
 * so an import cannot silently resolve a nested, differently published SDK. */
export async function verifyRegistryConsumer(root: string, sdk: RegistrySdk, archiveDirectory: string, env = process.env, options: RegistryOptions = {}): Promise<SdkVerification> {
  try {
    assertCoordinatedSdk(sdk)
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assertRegistryManifest(manifest)
    const lock = assertRegistryLock(await readFile(join(root, 'bun.lock'), 'utf8'), sdk.registry)
    for (const path of ['node_modules', 'node_modules/@workbasehq']) {
      if (!(await lstat(join(root, path))).isDirectory()) throw new RegistrySdkError('registry_guard', `${path}: odkaz není povolen.`)
    }
    await assertSdkLayout(root)
    for (const [key, tuple] of Object.entries(lock.packages) as [string, unknown[]][]) {
      const name = sdkNames.find(name => key === name || key.endsWith('/' + name) || tuple[0]?.toString().startsWith(name + '@'))
      if (name && (key !== name || tuple[0] !== `${name}@${sdk.version}`)) throw new RegistrySdkError('registry_integrity', `neočekávané SDK rozlišení ${key}: ${tuple[0]}.`)
    }
    for (const pkg of sdk.packages) {
      const tuple = lock.packages[pkg.name]
      if (manifest.dependencies?.[pkg.name] !== sdk.version || manifest.overrides?.[pkg.name] !== sdk.version
        || tuple?.[0] !== `${pkg.name}@${sdk.version}` || tuple[3] !== pkg.integrity) {
        throw new RegistrySdkError('registry_integrity', `${pkg.name}: verze nebo integrita lockfile neodpovídá registru.`)
      }
      pkg.lockIntegrity = tuple[3]
      const directory = join(root, 'node_modules', pkg.name)
      if (!(await lstat(directory)).isDirectory()) throw new RegistrySdkError('registry_guard', `${pkg.name}: instalace není samostatný adresář.`)
      const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      assertRegistryManifest(installed)
      if (installed.name !== pkg.name || installed.version !== sdk.version) throw new RegistrySdkError('registry_integrity', `${pkg.name}: nesouhlasí instalovaná verze.`)
    }
    // These archives are downloaded solely as byte witnesses. They are never
    // supplied to the package manager; every install resolves registry versions.
    // Rebind local archives to registry integrity on every verification. A
    // matching installed tree is insufficient if both archive and tree changed.
    for (const pkg of sdk.packages) await archiveWitness(join(archiveDirectory, `${pkg.name.split('/')[1]}.tgz`), pkg, options)
    const verification = await verifySdkInstalled(root, env, archiveDirectory, true, { signal: options.signal, timeoutMs: options.timeoutMs ?? 30000 })
    return verification
  } catch (cause) {
    if (cause instanceof RegistrySdkError) throw cause
    throw new RegistrySdkError('registry_integrity', `instalované bajty nelze ověřit: ${cause instanceof Error ? cause.message : cause}`, { cause })
  }
}

function validIntegrity(integrity: string) {
  const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
  return !!match && Buffer.from(match[2], 'base64').length === { sha512: 64, sha384: 48, sha256: 32, sha1: 20 }[match[1]]
    && Buffer.from(match[2], 'base64').toString('base64') === match[2]
}
function assertCoordinatedSdk(sdk: RegistrySdk) {
  if (!isExactVersion(sdk.version) || sdk.packages.length !== sdkNames.length || sdkNames.some(name => sdk.packages.filter(pkg => pkg.name === name && pkg.version === sdk.version && validIntegrity(pkg.integrity)).length !== 1)) {
    throw new RegistrySdkError('registry_integrity', 'očekávány tři koordinované balíčky s platnou integritou.')
  }
}
export type ArchiveWitness = { name: string; archive: string; sha256: string; sha512: string }
function witness(bytes: Buffer, pkg: RegistryPackage, archive: string): ArchiveWitness {
  if (!validIntegrity(pkg.integrity)) throw new RegistrySdkError('registry_integrity', `${pkg.name}: neplatná dist.integrity.`)
  const [algorithm, expected] = pkg.integrity.split('-')
  if (createHash(algorithm).update(bytes).digest('base64') !== expected) throw new RegistrySdkError('registry_integrity', `${pkg.name}: stažené bajty neodpovídají dist.integrity.`)
  return { name: pkg.name, archive, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('hex') }
}
async function archiveWitness(path: string, pkg: RegistryPackage, options: RegistryOptions) {
  if (!(await lstat(path)).isFile()) throw new RegistrySdkError('registry_guard', `${pkg.name}: archiv není běžný soubor.`)
  const [algorithm, expected] = pkg.integrity.split('-')
  const integrity = createHash(algorithm), sha256 = createHash('sha256'), sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(path, { signal: options.signal })) {
    size += chunk.length
    if (size > (options.maxBytes ?? 128 * 1024 * 1024)) throw new RegistrySdkError('registry_integrity', `${pkg.name}: archiv překročil limit bajtů.`)
    integrity.update(chunk); sha256.update(chunk); sha512.update(chunk)
  }
  if (integrity.digest('base64') !== expected) throw new RegistrySdkError('registry_integrity', `${pkg.name}: archiv neodpovídá dist.integrity.`)
  return { name: pkg.name, archive: path, sha256: sha256.digest('hex'), sha512: sha512.digest('hex') }
}
/** Download witnesses only; these files are never package-manager inputs. */
export async function downloadRegistryArchives(sdk: RegistrySdk, directory: string, options: RegistryOptions = {}): Promise<ArchiveWitness[]> {
  assertCoordinatedSdk(sdk)
  await mkdir(directory, { recursive: true })
  const written: string[] = []
  try {
    const witnesses: ArchiveWitness[] = []
    for (const pkg of sdk.packages) {
      const path = join(directory, `${pkg.name.split('/')[1]}.tgz`)
      const bytes = await fetchRegistry(httpUrl(pkg.tarball), options, 128 * 1024 * 1024)
      const result = witness(bytes, pkg, path)
      await writeFile(path, bytes); written.push(path); witnesses.push(result)
    }
    return witnesses
  } catch (cause) {
    for (const path of written) await rm(path, { force: true })
    if (cause instanceof RegistrySdkError) throw cause
    throw new RegistrySdkError('registry_integrity', `archivy nelze ověřit: ${cause instanceof Error ? cause.message : cause}`, { cause })
  }
}
