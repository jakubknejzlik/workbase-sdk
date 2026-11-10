import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { customerTerms, reviewDigest } from './lib/public-vocabulary'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type Job = { 'runs-on': string; if?: string; permissions?: Record<string, string>; steps: Step[]; needs?: unknown }
type Workflow = { on: Record<string, any>; permissions: Record<string, string>; jobs: Record<string, Job> }
let root = process.env.SDK_BOOTSTRAP_EXPORT ?? process.cwd()
let temporary: string | undefined
beforeAll(() => {
  if (!existsSync(join(root, 'scripts/export-sdk.ts'))) return
  // Run the procedure stored on the selected commit, including for the main baseline.
  const sha = process.env.SDK_BOOTSTRAP_SOURCE ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (process.env.SDK_BOOTSTRAP_SOURCE) {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'])
    temporary = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-bootstrap-policy-')))
    root = temporary
    // Project the baseline allowlist directly: main may contain newly unclassified
    // SDK files, but those cannot introduce workflows into the exported tree.
    const show = (path: string) => execFileSync('git', ['show', `${sha}:${path}`])
    const manifest = JSON.parse(show('scripts/sdk-export-manifest.json').toString())
    for (const file of manifest.files) {
      const destination = file.destination ?? file.path
      if (!/^(?:\.github\/|README\.md$|CONTRIBUTING\.md$|SECURITY\.md$|package\.json$|scripts\/sdk-publish\.ts$)/.test(destination)) continue
      mkdirSync(dirname(join(root, destination)), { recursive: true })
      writeFileSync(join(root, destination), show(file.path))
    }
    return
  }
  const output = execFileSync('bun', ['scripts/export-sdk.ts', sha, '--allow-unmerged'], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 5 * 1024 * 1024,
  })
  root = /Export directory: (.+)/.exec(output)![1]
  if (!process.env.SDK_BOOTSTRAP_EXPORT) registerTempDir(root)
}, 30000)
afterAll(() => {
  if (root !== process.cwd() && !process.env.SDK_BOOTSTRAP_EXPORT) cleanupTempDir(root)
  if (temporary) cleanupTempDir(temporary)
})
function workflow(name: string): { source: string; parsed: Workflow } {
  const source = readFileSync(join(root, `.github/workflows/${name}.yml`), 'utf8')
  return { source, parsed: JSON.parse(execFileSync('bun', ['--no-install', '--eval', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))'], { input: source, encoding: 'utf8' })) }
}
const ciCommands = ['bun install --frozen-lockfile', 'bun run lint', 'bun run typecheck', 'bun run check:ci-invariants', 'bun run test', 'bun run test:mcp', 'bash scripts/sdk-pack.sh', 'bun scripts/check-sdk-boundary.ts', 'bun scripts/scan-sdk-public.ts']
describe('exported public bootstrap workflow policy', () => {
  it('contains exactly the two public workflows and SDK root documentation', () => {
    expect(readdirSync(join(root, '.github'))).toEqual(['workflows'])
    expect(readdirSync(join(root, '.github/workflows')).sort()).toEqual(['ci.yml', 'release.yml'])
    for (const name of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
      const content = readFileSync(join(root, name), 'utf8')
      expect(customerTerms.test(content)).toBe(false)
      // Keep the retired source-repository check without publishing its identity.
      for (const [link] of content.matchAll(/github\.com\/[\w.-]+\/workbase(?=[/.#\s]|$)/g)) {
        expect(reviewDigest(link)).not.toBe('a915f740a2e57859628b44665cc483debddb0bd06df5ecddcab473db1b778734')
      }
    }
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).repository.url).toBe('git+https://github.com/jakubknejzlik/workbase-sdk.git')
  })
  it.each(['ci', 'release'])('%s uses hosted runners, immutable actions and credential-free checks', name => {
    const { source, parsed } = workflow(name)
    expect(parsed.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(parsed.on)).not.toContain('pull_request_target')
    expect(source.replaceAll('${{ secrets.WORKBASE_PRIVATE_TERMS }}', '')).not.toMatch(/secrets\s*[.\[]|self-hosted|CLOUDFLARE_|git clone|instances\/|upload-artifact|download-artifact/)
    for (const job of Object.values(parsed.jobs)) {
      expect(job['runs-on']).toBe('ubuntu-latest')
      expect(job.needs).toBeUndefined()
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/)
        expect(step.with?.repository).toBeUndefined()
        if (['bun run check:ci-invariants', 'bun run test', 'bash scripts/sdk-pack.sh', 'bun scripts/check-sdk-boundary.ts', 'bun scripts/scan-sdk-public.ts', 'bun scripts/smoke-mcp-template.ts --directory dist-sdk'].includes(step.run ?? '')) {
          expect(step.env).toEqual({ WORKBASE_PRIVATE_TERMS: '${{ secrets.WORKBASE_PRIVATE_TERMS }}' })
          expect(step.if).toBeUndefined()
        }
        for (const curl of step.run?.match(/curl[^\n]+/g) ?? []) {
          expect(curl).toMatch(/curl -fsSL --retry 5 --retry-all-errors /)
          expect(curl).toContain('/v8.24.3/')
        }
      }
      const download = job.steps.find(step => step.run?.includes('curl '))!.run!
      expect(download).toContain('9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c')
      expect(download).toContain('sha256sum -c -')
      expect(download.indexOf('sha256sum -c -')).toBeLessThan(download.indexOf('tar -xzf'))
      expect(job.steps.filter(step => step.run && ciCommands.includes(step.run)).map(step => step.run)).toEqual(ciCommands)
    }
  })
  it('runs read-only CI for every fork PR and pushes to main, without OIDC', () => {
    const { source, parsed } = workflow('ci')
    expect(Object.keys(parsed.on).sort()).toEqual(['pull_request', 'push'])
    expect(parsed.on.push).toEqual({ branches: ['main'] })
    expect(parsed.on.pull_request).toBeNull()
    expect(source).not.toContain('id-token')
    expect(Object.keys(parsed.jobs)).toEqual(['check'])
    expect(parsed.jobs.check.if).toBeUndefined()
    expect(parsed.jobs.check.permissions).toBeUndefined()
    expect(parsed.jobs.check.steps.every(step => !step.if)).toBe(true)
  })
  it('checks, builds, packs, rehearses and publishes the same archives in one non-PR release job', () => {
    const { source, parsed } = workflow('release')
    expect(Object.keys(parsed.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(parsed.on.push).toEqual({ tags: ['sdk-v*'] })
    expect(parsed.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true })
    expect(Object.keys(parsed.jobs)).toEqual(['release'])
    const job = parsed.jobs.release
    expect(job.if).toBe("github.event_name != 'pull_request' && github.event_name != 'pull_request_target'")
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    const commands = job.steps.map(step => step.run ?? '')
    const pack = commands.indexOf('bash scripts/sdk-pack.sh'), rehearse = commands.indexOf('bun scripts/smoke-mcp-template.ts --directory dist-sdk')
    const publish = commands.findIndex(command => command.includes('bun scripts/sdk-publish.ts'))
    expect(pack).toBeGreaterThan(commands.indexOf('bun run test:mcp'))
    expect(rehearse).toBeGreaterThan(pack)
    expect(publish).toBeGreaterThan(rehearse)
    expect(commands.filter(command => command === 'bash scripts/sdk-pack.sh')).toHaveLength(1)
    expect(commands[publish]).toContain('--directory dist-sdk')
    expect(commands[publish]).toContain('--dry-run')
    expect(commands[publish]).toContain('--expect-version')
    expect(job.steps[publish].env).toEqual({ RELEASE_EVENT: '${{ github.event_name }}', RELEASE_REF: '${{ github.ref }}', RELEASE_DRY_RUN: '${{ inputs.dry_run }}' })
    expect(source.replaceAll('${{ secrets.WORKBASE_PRIVATE_TERMS }}', '')).not.toMatch(/PR 6|secrets\s*[.\[]|(?:NPM|NODE_AUTH)_TOKEN/)
  })
  it('pins an OIDC-capable npm CLI before publishing', () => {
    const steps = workflow('release').parsed.jobs.release.steps
    const install = steps.findIndex(step => /npm install -g npm@/.test(step.run ?? ''))
    expect(install).toBeGreaterThanOrEqual(0)
    const version = /npm install -g npm@(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(steps[install].run!)
    expect(version).not.toBeNull()
    const [major, minor, patch] = version!.slice(1).map(Number)
    expect(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))).toBe(true)
    expect(install).toBeLessThan(steps.findIndex(step => step.run?.includes('bun scripts/sdk-publish.ts')))
  })
  it.each([
    ['tag push', 'push', 'refs/tags/sdk-v0.2.11', '', ['--directory', 'dist-sdk', '--expect-version', '0.2.11', '--provenance']],
    ['default dispatch', 'workflow_dispatch', 'refs/heads/main', '', ['--directory', 'dist-sdk', '--dry-run']],
    ['dry-run dispatch', 'workflow_dispatch', 'refs/heads/main', 'true', ['--directory', 'dist-sdk', '--dry-run']],
    ['real dispatch', 'workflow_dispatch', 'refs/heads/main', 'false', ['--directory', 'dist-sdk', '--provenance']],
  ])('passes the correct publisher arguments for %s', (_label, event, ref, dryRun, expected) => {
    const command = workflow('release').parsed.jobs.release.steps.find(step => step.run?.includes('bun scripts/sdk-publish.ts'))!.run!
    const directory = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-release-step-')))
    try {
      const capture = join(directory, 'args')
      writeFileSync(join(directory, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SDK_PUBLISH_CAPTURE"\n', { mode: 0o755 })
      execFileSync('bash', ['-euo', 'pipefail', '-c', command], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
        SDK_PUBLISH_CAPTURE: capture, RELEASE_EVENT: event as string, RELEASE_REF: ref as string, RELEASE_DRY_RUN: dryRun as string } })
      expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual(['scripts/sdk-publish.ts', ...expected])
    } finally { cleanupTempDir(directory) }
  })
  it.skipIf(!existsSync(join(process.cwd(), 'scripts/export-sdk.ts')))('keeps the private SDK release workflow absent', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/release.yml'))).toBe(false)
  })
})
