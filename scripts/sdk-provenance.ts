import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sdkWorkspaceDirectories } from './lib/sdk-workspaces'
import { consoleBuildInputs } from './console-build-inputs'

export const sdkPackageNames = ['core', 'plugins', 'mcp']
export type SdkArchive = { name: string; sha512: string }
export type SdkSource = { sourceCommit: string; dirty: boolean; contentHash: string; inputFiles: string[] }
export type PackedSdkProvenance = SdkSource & { version: 1; archives: SdkArchive[] }
const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

/** Shared by the existing pack path and the harness; always reads working tree bytes. */
export function sdkSource(root: string): SdkSource {
  const files = new Set(git(root, ['ls-files', '-z', '--', 'packages/', 'LICENSE', 'package.json', 'bun.lock', ':(top,glob)tsconfig*.json',
    'scripts/console-build-inputs.ts', 'scripts/sdk-pack.sh', 'scripts/sdk-provenance.ts', 'scripts/build-console.ts', 'scripts/check-terminology.ts', 'patches/',
    'scripts/stage-console-assets.ts', 'scripts/lib/stage-console-package.ts', 'scripts/lib/sdk-workspaces.ts', 'scripts/check-console-public.ts',
    ':(top,glob)examples/*/package.json', ':(top,glob)instances/*/package.json', ':(top,glob)apps/*/package.json']).split('\0').filter(Boolean))
  files.add('LICENSE') // The packer always copies the root license, including before it is staged.
  // Follow the producer build's current import graph rather than retaining an
  // inventory of historical private generator dependencies.
  for (const file of consoleBuildInputs(root)) files.add(file)
  // The packer also reads live workspace manifests and generated/ignored payloads.
  // Include exactly the source trees copied to staging (including console dist).
  const walk = (relative: string) => {
    const path = join(root, relative), stat = lstatSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) if (!['node_modules', '.wrangler'].includes(name)) walk(`${relative}/${name}`)
    } else files.add(relative)
  }
  for (const directory of sdkWorkspaceDirectories(root)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) files.add(relative(root, manifest))
  }
  for (const name of sdkPackageNames) {
    const directory = join(root, 'packages', name)
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory)) {
      if (['src', 'plugins', 'dist'].includes(entry) || /^(config.*\.(ts|json)|readme.*|license.*|notice)$/i.test(entry)) walk(`packages/${name}/${entry}`)
      else if (name === 'plugins' && existsSync(join(directory, entry, 'src'))) {
        walk(`packages/plugins/${entry}/src`)
        if (entry === 'console' && existsSync(join(directory, entry, 'assets'))) walk('packages/plugins/console/assets')
      }
      else if (name === 'mcp' && entry === 'templates') walk('packages/mcp/templates/standalone')
    }
  }
  // Retain the producer dist's integrity boundary as well as the staged payload.
  if (existsSync(join(root, 'packages/frontend-console/dist'))) walk('packages/frontend-console/dist')
  const inputFiles = [...files].sort(), hash = createHash('sha256')
  for (const file of inputFiles) {
    hash.update(`${Buffer.byteLength(file)}:${file}\0`)
    const path = join(root, file)
    try {
      const link = lstatSync(path).isSymbolicLink()
      const bytes = link ? Buffer.from(readlinkSync(path)) : readFileSync(path)
      hash.update(`${link ? 'link' : 'file'}:${bytes.length}:`).update(bytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      hash.update('missing:')
    }
  }
  return { sourceCommit: git(root, ['rev-parse', 'HEAD']).trim(), dirty: !!git(root, ['status', '--porcelain', '--untracked-files=all']).trim(),
    contentHash: 'sha256-' + hash.digest('hex'), inputFiles }
}
export function sdkArchives(directory: string): SdkArchive[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.endsWith('.tgz')).sort().map(name => ({ name,
    sha512: 'sha512-' + createHash('sha512').update(readFileSync(join(directory, name))).digest('base64') }))
}
/** Compare manifest identities, including duplicates, rather than archive filenames. */
export function assertSdkPackageNames(names: string[]): void {
  const expected = sdkPackageNames.map(name => `@workbasehq/${name}`).sort()
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
    throw new Error(`expected exactly SDK packages ${expected.join(', ')}; found ${names.join(', ') || '(none)'}`)
  }
}
export function assertSdkArchives(directory: string): void {
  const names = sdkArchives(directory).map(({ name }) => JSON.parse(execFileSync('tar', ['-xOf', join(directory, name), 'package/package.json'], { encoding: 'utf8' })).name)
  assertSdkPackageNames(names)
}
export function writeSdkProvenance(root: string, source = sdkSource(root)) {
  if (sdkSource(root).contentHash !== source.contentHash) throw new Error('Vstupy SDK se během balení změnily; spusťte bash scripts/sdk-pack.sh znovu.')
  const directory = join(root, 'dist-sdk')
  const provenance: PackedSdkProvenance = { version: 1, ...source, archives: sdkArchives(directory) }
  writeFileSync(join(directory, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n')
  return provenance
}
