#!/usr/bin/env bash
set -euo pipefail
# The isolated proof packs and scans without the consumer smoke's bun install.
pack_only=false
if [[ "${1:-}" == "--pack-only" && "$#" == 1 ]]; then
  pack_only=true
elif [[ "$#" != 0 ]]; then
  echo "Usage: bash scripts/sdk-pack.sh [--pack-only]" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bun "$root/scripts/stage-console-assets.ts"
mkdir -p "$root/dist-sdk"

# Pack staged manifests: Bun otherwise resolves even development-only workspace
# dependencies, including unversioned example packages. Never edit the workspaces.
bun - "$root" <<'JS'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const [root] = process.argv.slice(2)
const { registerTempDir } = await import(pathToFileURL(join(root, 'scripts/lib/test-temp-dir.mjs')).href)
const stage = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-sdk-pack-')))
const { assertSdkArchives, sdkPackageNames, sdkSource, writeSdkProvenance } = await import(pathToFileURL(join(root, 'scripts/sdk-provenance.ts')).href)
const { sdkWorkspaceDirectories } = await import(pathToFileURL(join(root, 'scripts/lib/sdk-workspaces.ts')).href)
const { stageConsolePackage } = await import(pathToFileURL(join(root, 'scripts/lib/stage-console-package.ts')).href)
const source = sdkSource(root)
// dist-sdk is a generated release set; remove stale archives from earlier layouts.
for (const file of readdirSync(join(root, 'dist-sdk'))) if (file.endsWith('.tgz')) rmSync(join(root, 'dist-sdk', file))
const packages = new Map()
for (const dir of sdkWorkspaceDirectories(root)) {
  const file = join(dir, 'package.json')
  if (existsSync(file)) { const manifest = JSON.parse(readFileSync(file, 'utf8')); packages.set(manifest.name, { dir, manifest }) }
}
const sdk = sdkPackageNames.map(name => `@workbasehq/${name}`)
// Ship exactly core, plugins and mcp; generic console bytes live inside plugins.
const selected = new Set(sdk)
const auditVersion = packages.get('@workbasehq/core').manifest.version
for (const name of selected) {
  const { dir, manifest } = packages.get(name)
  const destination = join(stage, name.replace('@workbasehq/', ''))
  if (name === '@workbasehq/core' || name === '@workbasehq/plugins') {
    stageConsolePackage(root, name.slice('@workbasehq/'.length), destination)
    const result = spawnSync('bun', ['pm', 'pack', '--destination', join(root, 'dist-sdk'), '--quiet'], { cwd: destination, encoding: 'utf8' })
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1) }
    process.stdout.write(result.stdout)
    continue
  }
  mkdirSync(destination)
  const packed = { ...manifest, version: manifest.version ?? auditVersion }
  delete packed.devDependencies
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!packed[kind]) continue
    packed[kind] = Object.fromEntries(Object.entries(packed[kind]).map(([dependency, spec]) =>
      [dependency, String(spec).startsWith('workspace:') ? (packages.get(dependency)?.manifest.version ?? auditVersion) : spec]))
  }
  packed.files ??= ['config*.ts', 'config*.json', 'src', 'plugins', '!**/test/**', '!**/tests/**', '!**/fixtures/**', '!**/*.test.*', '!**/*.spec.*']
  for (const entry of readdirSync(dir)) {
    if (name === '@workbasehq/plugins' && existsSync(join(dir, entry, 'src'))) {
      cpSync(join(dir, entry, 'src'), join(destination, entry, 'src'), { recursive: true })
      continue
    }
    if (!['src', 'plugins', 'dist'].includes(entry) && !(name === '@workbasehq/mcp' && entry === 'templates') && !/^(config.*\.(ts|json)|readme.*|license.*|notice)$/i.test(entry)) continue
    cpSync(join(dir, entry === 'templates' ? 'templates/standalone' : entry), join(destination, entry === 'templates' ? 'templates/standalone' : entry), { recursive: true, filter: path => !/(^|\/)(node_modules|\.wrangler)(\/|$)/.test(path) })
  }
  cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'))
  writeFileSync(join(destination, 'package.json'), JSON.stringify(packed, null, 2) + '\n')
  // Bun 1.4.3 emits a duplicate member when two bin aliases share a target.
  // npm preserves both aliases and writes that regular file exactly once.
  process.stderr.write(`Packing ${name} with npm pack --ignore-scripts --offline\n`)
  const result = spawnSync('npm', ['pack', '--pack-destination', join(root, 'dist-sdk'), '--ignore-scripts', '--offline', '--quiet'], { cwd: destination, encoding: 'utf8' })
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1) }
  process.stdout.write(result.stdout)
}
assertSdkArchives(join(root, 'dist-sdk'))
writeSdkProvenance(root, source)
JS

bun "$root/scripts/check-sdk-boundary.ts"
if [[ "$pack_only" == false ]]; then bun "$root/scripts/sdk-smoke.ts"; fi
