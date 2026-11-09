import { join, resolve } from 'node:path'
import { bridgeDigest, BRIDGE_VERSION, digestBytes, type UpgradeResult } from '../../src/sdk-upgrade-protocol.ts'
import type { TargetOptions } from '../../src/sdk-target.ts'

/** Synthetic D2 boundary for lifecycle/dispatch tests, never installed-target proof. */
export async function targetProof(options: TargetOptions) {
  const manifest = JSON.parse(options.inputs['package.json'].toString())
  const names = ['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp'] as const
  manifest.dependencies = Object.fromEntries(names.map(name => [name, options.targetVersion]))
  const inputs: Record<string, Buffer> = { ...options.inputs, 'package.json': Buffer.from(JSON.stringify(manifest)), 'bun.lock': Buffer.from('target fixture lock\n') }
  const inputHashes = Object.fromEntries(Object.keys(inputs).sort().map(path => [path, digestBytes(inputs[path])]))
  const path = `migrations/${String(Object.keys(inputs).filter(path => path.startsWith('migrations/')).length + 1).padStart(4, '0')}_sdk_upgrade.sql`
  const marker = Buffer.from(`-- target ${options.targetVersion} at revision ${options.base.baseRevision}\nUPDATE instance_meta SET core_version = '${options.targetVersion}' WHERE revision = ${options.base.baseRevision};\n`)
  const result: UpgradeResult = {
    kind: 'verified', identity: { ...options.base, targetVersion: options.targetVersion, runId: crypto.randomUUID(), bridgeVersion: BRIDGE_VERSION,
      bridgeDigest: await bridgeDigest(resolve('packages/mcp/src')) }, inputHashes,
    stage: { marker: { path, sha256: digestBytes(marker) }, replaySha256: digestBytes('replay') },
    coreVersion: options.targetVersion,
    packages: names.map(name => ({ name, version: options.targetVersion, directory: join('/removed-consumer/node_modules', name) })),
    resolutions: { '@workbasehq/core/config': '/removed-consumer/node_modules/@workbasehq/core/config.ts' },
    schema: { status: 'pass', expected: 'c'.repeat(64), applied: 'c'.repeat(64) },
    plugins: { expected: 'd'.repeat(64), applied: 'd'.repeat(64) }, marker: { version: options.targetVersion, revision: options.base.baseRevision },
  }
  return { result, artifacts: Object.fromEntries(['package.json', 'bun.lock', path].map(file => [file, {
    bytes: file === path ? marker : inputs[file], sha256: file === path ? digestBytes(marker) : inputHashes[file],
  }])), targetDependencyDigest: digestBytes(JSON.stringify(Object.fromEntries(['package.json', 'bun.lock'].map(path => [path, inputHashes[path]])))),
  archives: names.map(name => ({ name, sha256: 'e'.repeat(64), sha512: 'f'.repeat(128) })), installed: names.map(name => ({ name, sha256: '1'.repeat(64) })) }
}
