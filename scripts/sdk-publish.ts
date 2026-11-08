#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { sdkPackageNames } from './sdk-provenance'

type Manifest = {
  name: string; version: string; private?: boolean; license?: string
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>
}
export type Archive = { path: string; manifest: Manifest }
export type Result = { status: number | null; stdout: string; stderr: string }
export type Runner = (command: string, args: string[]) => Result
const registry = 'https://registry.npmjs.org'
export const run: Runner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  return result
}
const dependencies = (manifest: Manifest) => ({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })
const sdk = new Set(sdkPackageNames.map(name => `@workbasehq/${name}`))
function checked(command: string, args: string[], runner: Runner): string {
  const result = runner(command, args)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}
export function readArchives(directory: string, runner = run): Archive[] {
  return readdirSync(directory).filter(name => name.endsWith('.tgz')).sort().map(name => {
    const path = resolve(directory, name)
    const entries = checked('tar', ['-tzf', path], runner).trim().split('\n')
    if (!entries.includes('package/LICENSE')) throw new Error(`${name}: missing package/LICENSE`)
    return { path, manifest: JSON.parse(checked('tar', ['-xOf', path, 'package/package.json'], runner)) as Manifest }
  })
}
export function validateArchives(archives: Archive[], expectVersion?: string): Archive[] {
  const byName = new Map<string, Archive>()
  for (const archive of archives) {
    const manifest = archive.manifest, label = `${manifest.name}@${manifest.version}`
    if (!sdk.has(manifest.name)) throw new Error(`${label}: not an SDK package`)
    if (byName.has(manifest.name)) throw new Error(`${label}: duplicate package`)
    if ('private' in manifest) throw new Error(`${label}: private field is forbidden`)
    if (/workspace:|registry\.invalid/.test(JSON.stringify(manifest))) throw new Error(`${label}: unresolved workspace or invalid registry`)
    if (manifest.publishConfig?.access !== 'public') throw new Error(`${label}: publishConfig.access must be public`)
    if (!manifest.license?.trim()) throw new Error(`${label}: missing license`)
    if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(manifest.version)) throw new Error(`${label}: invalid version`)
    if (expectVersion && manifest.version !== expectVersion) throw new Error(`${label}: expected version ${expectVersion}`)
    for (const kind of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      for (const [name, spec] of Object.entries(kind ?? {})) {
        if (name.startsWith('@workbasehq/') && !sdk.has(name)) throw new Error(`${label}: private dependency ${name}`)
        // Restrict published dependencies to registry versions/ranges, never local paths, URLs or aliases.
        if (typeof spec !== 'string' || !spec.trim() || /[:/\\]/.test(spec)) {
          throw new Error(`${label}: non-registry dependency ${name}@${spec}`)
        }
        if (sdk.has(name) && spec !== manifest.version) throw new Error(`${label}: SDK dependency ${name} must match release version`)
      }
    }
    byName.set(manifest.name, archive)
  }
  if (byName.size !== sdk.size || [...sdk].some(name => !byName.has(name))) throw new Error(`Expected exactly ${sdk.size} SDK packages; found ${byName.size}`)
  if (new Set(archives.map(({ manifest }) => manifest.version)).size !== 1) throw new Error('SDK versions must all match')
  // Stable Kahn traversal: source package order only breaks ties between ready nodes.
  const ordered: Archive[] = [], pending = new Map([...sdk].map(name => [name, byName.get(name)!]))
  while (pending.size) {
    const next = [...pending.values()].find(({ manifest }) => Object.keys(dependencies(manifest)).every(name => !pending.has(name)))
    if (!next) throw new Error('SDK dependency cycle')
    ordered.push(next); pending.delete(next.manifest.name)
  }
  return ordered
}
export function assertNpmVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match || !(Number(match[1]) > 11 || (Number(match[1]) === 11 && (Number(match[2]) > 5 || (Number(match[2]) === 5 && Number(match[3]) >= 1))))) {
    throw new Error(`npm >= 11.5.1 is required for Trusted Publishing; found ${version.trim()}`)
  }
}
function view(spec: string, runner: Runner): string[] | null {
  const result = runner('npm', ['view', spec, 'version', '--json', '--registry', registry])
  if (result.status === 0) {
    const value: unknown = JSON.parse(result.stdout)
    if (typeof value === 'string') return [value]
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
    throw new Error(`Unexpected npm view response for ${spec}`)
  }
  // Only an explicit registry 404 means absent; auth, network and CLI errors must stop the release.
  let code: unknown
  try { code = JSON.parse(result.stdout || result.stderr).error?.code } catch { /* npm can prepend diagnostics */ }
  if (code === 'E404' || /\bnpm (?:ERR!|error) code E404\b/.test(result.stderr)) return null
  throw new Error(`npm view ${spec} failed: ${result.stderr || result.stdout}`)
}
export async function publishSdk(args: string[], env: NodeJS.ProcessEnv = process.env, runner = run) {
  let dryRun = env.SDK_PUBLISH_DRY_RUN === '1', provenance = false, expectVersion: string | undefined, directory = 'dist-sdk'
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--dry-run') dryRun = true
    else if (args[index] === '--provenance') provenance = true
    else if (['--expect-version', '--directory'].includes(args[index])) {
      const option = args[index], value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
      if (option === '--expect-version') expectVersion = value
      else directory = value
    } else throw new Error(`Unknown argument: ${args[index]}`)
  }
  if (provenance && (env.GITHUB_ACTIONS !== 'true' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || env.GITHUB_REPOSITORY !== 'jakubknejzlik/workbase-sdk')) {
    throw new Error('Provenance requires GITHUB_ACTIONS=true, ACTIONS_ID_TOKEN_REQUEST_URL, and GITHUB_REPOSITORY=jakubknejzlik/workbase-sdk')
  }
  if (!dryRun) {
    assertNpmVersion(checked('npm', ['--version'], runner))
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL && env.SDK_PUBLISH_ALLOW_LOCAL !== '1') {
      throw new Error('Publishing requires GitHub Actions OIDC or SDK_PUBLISH_ALLOW_LOCAL=1; use --dry-run locally')
    }
  }
  const ordered = validateArchives(readArchives(directory, runner), expectVersion)
  // Verify every external runtime dependency is readable on the public registry before publishing anything.
  const external = new Set(ordered.flatMap(({ manifest }) => [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].flatMap(kind => Object.entries(kind ?? {}))
    .filter(([name]) => !sdk.has(name)).map(([name, spec]) => `${name}@${spec}`)))
  for (const spec of external) if (!view(spec, runner)?.length) throw new Error(`Dependency is not public on npm: ${spec}`)
  const actions = ordered.map(archive => {
    const { name, version } = archive.manifest
    const exists = view(`${name}@${version}`, runner)?.includes(version) ?? false
    return { archive, action: exists ? 'skip' : dryRun ? 'dry-run' : 'publish' }
  })
  console.log('package | version | action')
  for (const { archive, action } of actions) {
    const { name, version } = archive.manifest
    if (action !== 'skip') {
      const output = checked('npm', ['publish', archive.path, '--access', 'public', provenance ? '--provenance' : '--provenance=false', '--ignore-scripts',
        '--registry', registry, ...(dryRun ? ['--dry-run'] : [])], runner)
      if (output.trim()) console.error(output.trim())
    }
    console.log(`${name} | ${version} | ${action}`)
  }
  return actions.map(({ archive: { manifest: { name, version } }, action }) => ({ name, version, action }))
}
if (import.meta.main) publishSdk(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
