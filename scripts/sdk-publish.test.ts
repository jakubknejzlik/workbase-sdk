import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { sdkWorkspaceDirectories } from './lib/sdk-workspaces'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { assertNpmVersion, publishSdk, readArchives, run, validateArchives, type Runner } from './sdk-publish'
import { sdkPackageNames } from './sdk-provenance'

let directory: string
function fixture(change?: (manifest: ReturnType<typeof readArchives>[number]['manifest']) => void, license = true) {
  for (const name of sdkPackageNames) {
    const stage = join(directory, name), pkg = join(stage, 'package')
    mkdirSync(pkg, { recursive: true })
    const manifest = { name: `@workbasehq/${name}`, version: '0.1.0', license: 'Apache-2.0', publishConfig: { access: 'public' },
      dependencies: name === 'core' ? { zod: '4.6.7' } : name === 'mcp' ? { '@workbasehq/core': '0.1.0', '@workbasehq/plugins': '0.1.0' } : {},
      ...(name === 'plugins' ? { peerDependencies: { '@workbasehq/core': '0.1.0' } } : {}) } as ReturnType<typeof readArchives>[number]['manifest']
    change?.(manifest)
    writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest))
    if (license) writeFileSync(join(pkg, 'LICENSE'), 'fixture')
    execFileSync('tar', ['-czf', join(directory, `${name}.tgz`), '-C', stage, 'package'])
  }
}
function fakeNpm(options: { existing?: boolean; placeholder?: boolean; failure?: boolean; npm?: string; failPublish?: number } = {}) {
  const calls: string[][] = [], published: string[] = []
  const runner: Runner = (command, args) => {
    if (command !== 'npm') return run(command, args)
    calls.push(args)
    if (args[0] === '--version') return { status: 0, stdout: options.npm ?? '11.5.1', stderr: '' }
    if (args[0] === 'publish') {
      if (options.failPublish === published.length + 1) return { status: 1, stdout: '', stderr: 'simulated publish failure' }
      published.push(args[1]); return { status: 0, stdout: '', stderr: '' }
    }
    if (options.failure) return { status: 1, stdout: '', stderr: 'network failure' }
    if (!args[1].startsWith('@workbasehq/')) return { status: 0, stdout: '"4.6.7"', stderr: '' }
    if (options.placeholder) return { status: 0, stdout: '"0.0.0"', stderr: '' }
    if (options.existing && args[1] === '@workbasehq/core@0.1.0') return { status: 0, stdout: '"0.1.0"', stderr: '' }
    return { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' }
  }
  return { runner, calls, published }
}
beforeEach(() => { directory = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-publish-test-'))); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { cleanupTempDir(directory); vi.restoreAllMocks() })
describe('SDK release validation and publishing', () => {
  it('publishes exactly core, plugins and mcp across workspace manifests', () => {
    expect(sdkPackageNames).toEqual(['core', 'plugins', 'mcp'])
    const published = sdkWorkspaceDirectories(process.cwd()).flatMap(directory => {
        const path = join(directory, 'package.json')
        if (!existsSync(path)) return []
        const manifest = JSON.parse(readFileSync(path, 'utf8'))
        return manifest.private === true ? [] : [manifest.name]
      })
    expect(published.sort()).toEqual(['@workbasehq/core', '@workbasehq/mcp', '@workbasehq/plugins'])
  })
  it('dry-runs all three archives with core first and dependencies before dependents', async () => {
    fixture(); const npm = fakeNpm()
    const result = await publishSdk(['--directory', directory, '--dry-run', '--expect-version', '0.1.0'], {}, npm.runner)
    expect(result).toHaveLength(3); expect(result.map(row => row.name)).toEqual(['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp'])
    expect(result.every(row => row.action === 'dry-run')).toBe(true)
    expect(npm.published).toHaveLength(3)
    expect(npm.calls.filter(args => args[0] === 'publish').every(args => args.includes('--dry-run') && args.includes('--provenance=false'))).toBe(true)
  })
  it('skips only the exact existing version and leaves missing versions publishable', async () => {
    fixture(); const npm = fakeNpm({ existing: true })
    const result = await publishSdk(['--directory', directory], { SDK_PUBLISH_DRY_RUN: '1' }, npm.runner)
    expect(result.filter(row => row.action === 'skip').map(row => row.name)).toEqual(['@workbasehq/core'])
    expect(npm.published).toHaveLength(2)
    expect(npm.calls.filter(args => args[0] === 'view' && args[1].startsWith('@workbasehq/')).every(args => args[1].endsWith('@0.1.0'))).toBe(true)
  })
  it('does not skip 0.1.0 because a placeholder exists', async () => {
    fixture(); const npm = fakeNpm({ placeholder: true })
    const result = await publishSdk(['--directory', directory, '--dry-run'], {}, npm.runner)
    expect(result.every(row => row.action === 'dry-run')).toBe(true)
    expect(npm.published).toHaveLength(3)
  })
  it.each(['private', 'dependency', 'workspace', 'registry', 'access', 'license', 'version'] as const)('rejects invalid %s before publishing', async kind => {
    fixture(m => {
      if (m.name !== '@workbasehq/core') return
      if (kind === 'private') m.private = true
      if (kind === 'dependency') m.dependencies!['@workbasehq/ui'] = '0.1.0'
      if (kind === 'workspace') m.dependencies!.zod = 'workspace:*'
      if (kind === 'registry') Object.assign(m.publishConfig!, { registry: 'https://registry.invalid/' })
      if (kind === 'access') m.publishConfig!.access = 'restricted'
      if (kind === 'license') delete m.license
      if (kind === 'version') m.version = '0.2.0'
    })
    const npm = fakeNpm()
    await expect(publishSdk(['--directory', directory, '--dry-run'], {}, npm.runner)).rejects.toThrow()
    expect(npm.published).toHaveLength(0)
  })
  it('rejects a missing LICENSE', () => { fixture(undefined, false); expect(() => readArchives(directory)).toThrow('missing package/LICENSE') })
  it('rejects a mismatched tag version', async () => {
    fixture(); const npm = fakeNpm()
    await expect(publishSdk(['--directory', directory, '--dry-run', '--expect-version', '0.2.0'], {}, npm.runner)).rejects.toThrow('expected version 0.2.0')
    expect(npm.published).toHaveLength(0)
  })
  it('blocks local real publication before any publish', async () => {
    const npm = fakeNpm()
    await expect(publishSdk(['--directory', directory], {}, npm.runner)).rejects.toThrow('requires GitHub Actions OIDC')
    expect(npm.calls).toEqual([['--version']]); expect(npm.published).toHaveLength(0)
  })
  it('allows explicit local publishing only with a supported npm CLI (mocked)', async () => {
    fixture(); const npm = fakeNpm()
    await publishSdk(['--directory', directory], { SDK_PUBLISH_ALLOW_LOCAL: '1' }, npm.runner)
    expect(npm.published).toHaveLength(3)
    expect(npm.calls.filter(args => args[0] === 'publish').every(args => !args.includes('--dry-run'))).toBe(true)
    expect(npm.calls.filter(args => args[0] === 'publish').every(args => args.includes('--provenance=false'))).toBe(true)
  })
  const oidc = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'mock', GITHUB_REPOSITORY: 'jakubknejzlik/workbase-sdk' }
  it.each([
    ['missing Actions', { ...oidc, GITHUB_ACTIONS: undefined }],
    ['outside Actions', { ...oidc, GITHUB_ACTIONS: 'false' }],
    ['missing OIDC', { ...oidc, ACTIONS_ID_TOKEN_REQUEST_URL: undefined }],
    ['missing repository', { ...oidc, GITHUB_REPOSITORY: undefined }],
    ['different repository', { ...oidc, GITHUB_REPOSITORY: 'another-owner/another-repository' }],
    ['local override', { SDK_PUBLISH_ALLOW_LOCAL: '1' }],
  ] as [string, NodeJS.ProcessEnv][])('rejects provenance with %s before calling npm, even for dry runs', async (_label, env) => {
    for (const extra of [[], ['--dry-run']]) {
      const npm = fakeNpm()
      await expect(publishSdk(['--directory', directory, '--provenance', ...extra], env, npm.runner)).rejects.toThrow(
        'Provenance requires GITHUB_ACTIONS=true, ACTIONS_ID_TOKEN_REQUEST_URL, and GITHUB_REPOSITORY=jakubknejzlik/workbase-sdk',
      )
      expect(npm.calls).toEqual([])
    }
  })
  it('exits non-zero from the CLI before calling npm when provenance lacks OIDC', () => {
    const called = join(directory, 'npm-called')
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\ntouch "$SDK_TEST_NPM_CALLED"\nexit 99\n', { mode: 0o755 })
    const result = spawnSync('bun', [join(import.meta.dirname, 'sdk-publish.ts'), '--provenance'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SDK_TEST_NPM_CALLED: called,
        GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: '', GITHUB_REPOSITORY: oidc.GITHUB_REPOSITORY },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Provenance requires GITHUB_ACTIONS=true, ACTIONS_ID_TOKEN_REQUEST_URL, and GITHUB_REPOSITORY=jakubknejzlik/workbase-sdk')
    expect(existsSync(called)).toBe(false)
  })
  it.each([false, true])('opts in to provenance with the public OIDC environment (dry run: %s)', async dryRun => {
    fixture(); const npm = fakeNpm()
    await publishSdk(['--directory', directory, '--provenance', ...(dryRun ? ['--dry-run'] : [])], oidc, npm.runner)
    expect(npm.published).toHaveLength(3)
    for (const args of npm.calls.filter(args => args[0] === 'publish')) {
      expect(args).toContain('--provenance')
      expect(args).not.toContain('--provenance=false')
      expect(args.includes('--dry-run')).toBe(dryRun)
    }
  })
  it('rejects an old npm CLI even in Actions before publishing', async () => {
    const npm = fakeNpm({ npm: '11.5.0' })
    await expect(publishSdk([], { ACTIONS_ID_TOKEN_REQUEST_URL: 'mock' }, npm.runner)).rejects.toThrow('npm >= 11.5.1')
    expect(npm.published).toHaveLength(0)
  })
  it.each(['11.5.1', '11.6.0', '12.0.0'])('accepts OIDC-capable npm %s', version => { expect(() => assertNpmVersion(version)).not.toThrow() })
  it('fails closed on registry/network errors', async () => {
    fixture(); const npm = fakeNpm({ failure: true })
    await expect(publishSdk(['--directory', directory, '--dry-run'], {}, npm.runner)).rejects.toThrow('network failure')
    expect(npm.published).toHaveLength(0)
  })
  it('stops after a failed publish so a later rerun can skip completed versions', async () => {
    fixture(); const npm = fakeNpm({ failPublish: 2 })
    await expect(publishSdk(['--directory', directory], { ACTIONS_ID_TOKEN_REQUEST_URL: 'mock' }, npm.runner)).rejects.toThrow('simulated publish failure')
    expect(npm.published).toHaveLength(1)
  })
  it('derives dependency order and rejects cycles, duplicates and missing packages', () => {
    fixture(); const archives = readArchives(directory)
    const core = archives.find(a => a.manifest.name === '@workbasehq/core')!
    const mcp = archives.find(a => a.manifest.name === '@workbasehq/mcp')!
    const sorted = validateArchives(archives)
    const plugins = sorted.find(a => a.manifest.name === '@workbasehq/plugins')!
    expect(plugins.manifest.peerDependencies).toEqual({ '@workbasehq/core': '0.1.0' })
    expect(sorted.map(a => a.manifest.name)).toEqual(['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp'])
    expect(sorted.indexOf(mcp)).toBeGreaterThan(sorted.indexOf(plugins))
    expect(() => validateArchives(archives.slice(1))).toThrow('Expected exactly')
    expect(() => validateArchives([...archives, core])).toThrow('duplicate')
    core.manifest.dependencies!['@workbasehq/mcp'] = '0.1.0'
    expect(() => validateArchives(archives)).toThrow('cycle')
  })
})
