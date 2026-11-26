import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { customerTerms, reviewDigest } from './lib/public-vocabulary'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }
type Job = { env?: Record<string, string>; 'runs-on': string; if?: string; permissions?: Record<string, string>; steps: Step[]; needs?: unknown }
type Workflow = { env?: Record<string, string>; on: Record<string, any>; permissions: Record<string, string>; jobs: Record<string, Job> }
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
const ciCommands = ['bun install --frozen-lockfile', 'bun x --no-install playwright install --with-deps chromium', 'bun run lint', 'bun run typecheck', 'bun run check:ci-invariants', 'bun run test', 'bun run test:mcp', 'bash scripts/sdk-pack.sh', 'bun scripts/check-sdk-boundary.ts', 'bun scripts/scan-sdk-public.ts']

const diagnosticUploadName = 'Upload List v2 acceptance evidence'
const diagnosticUploadAction = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
const diagnosticUpload: Step = {
  name: diagnosticUploadName,
  if: 'always()',
  uses: diagnosticUploadAction,
  with: {
    name: 'list-v2-acceptance-${{ github.run_attempt }}',
    path: '${{ runner.temp }}/list-v2-acceptance/',
    'retention-days': 14,
    'if-no-files-found': 'warn',
  },
}
const completenessName = 'Verify List v2 evidence completeness'
const completenessCheck: Step = {
  name: completenessName,
  if: 'always()',
  run: 'bun scripts/check-list-v2-evidence.ts "${{ runner.temp }}/list-v2-acceptance"',
}
const privateTermsCommands = ['bun run check:ci-invariants', 'bun run test', 'bash scripts/sdk-pack.sh', 'bun scripts/check-sdk-boundary.ts', 'bun scripts/scan-sdk-public.ts', 'bun scripts/smoke-mcp-template.ts --directory dist-sdk']
function assertDiagnosticUploads(parsed: Workflow) {
  let uploads = 0
  for (const [jobName, job] of Object.entries(parsed.jobs)) {
    for (const step of job.steps) {
      if (step.name !== diagnosticUploadName && !/upload-artifact/i.test(step.uses ?? '')) continue
      uploads++
      expect(jobName).toBe('check')
      // Exact equality disallows extra inputs, env, permissions and alternative paths.
      expect(step).toEqual(diagnosticUpload)
    }
  }
  expect(uploads).toBeLessThanOrEqual(1)
}
function assertCommonWorkflowPolicy({ source, parsed }: { source: string; parsed: Workflow }) {
  assertDiagnosticUploads(parsed)
  expect(parsed.permissions).toEqual({ contents: 'read' })
  expect(Object.keys(parsed.on)).not.toContain('pull_request_target')
  expect(source.replaceAll('${{ secrets.WORKBASE_PRIVATE_TERMS }}', '').replace(diagnosticUploadAction, '')).not.toMatch(/secrets\s*[.\[]|self-hosted|CLOUDFLARE_|git clone|instances\/|upload-artifact|download-artifact/i)
  for (const job of Object.values(parsed.jobs)) {
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect(job.needs).toBeUndefined()
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/)
      expect(step.with?.repository).toBeUndefined()
      if (privateTermsCommands.includes(step.run ?? '')) {
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
}
function assertCiWorkflowPolicy(document: { source: string; parsed: Workflow }) {
  assertCommonWorkflowPolicy(document)
  const { source, parsed } = document
  expect(Object.keys(parsed.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
  expect(parsed.on.push).toEqual({ branches: ['main'] })
  expect(parsed.on.pull_request).toEqual({ branches: ['main'] })
  expect(parsed.on.workflow_dispatch).toBeNull()
  expect(source).not.toContain('id-token')
  expect(Object.keys(parsed.jobs)).toEqual(['check'])
  expect(parsed.jobs.check.if).toBeUndefined()
  expect(parsed.jobs.check.permissions).toBeUndefined()
  expect(parsed.env).toBeUndefined()
  expect(parsed.jobs.check.env).toBeUndefined()
  const steps = parsed.jobs.check.steps
  expect(steps.filter(step => step.name === completenessName)).toEqual([completenessCheck])
  const acceptance = steps.findIndex(step => step.run === 'bun run console:build && bun run test:list-v2-acceptance')
  expect(steps[acceptance + 1]).toEqual(completenessCheck)
  expect(steps[acceptance + 2]).toEqual(diagnosticUpload)
  for (const step of steps) {
    if (step.name === completenessName) expect(step).toEqual(completenessCheck)
    else if (step.name !== diagnosticUploadName) expect(step.if).toBeUndefined()
    const expectedEnv = step.run === 'bun run console:build && bun run test:list-v2-acceptance'
      ? { LIST_V2_OUTPUT: '${{ runner.temp }}/list-v2-acceptance', WORKBASE_PRIVATE_TERMS: '${{ secrets.WORKBASE_PRIVATE_TERMS }}' }
      : privateTermsCommands.includes(step.run ?? '')
        ? { WORKBASE_PRIVATE_TERMS: '${{ secrets.WORKBASE_PRIVATE_TERMS }}' }
        : undefined
    expect(step.env).toEqual(expectedEnv)
    // The existing vocabulary secret belongs only in the exact env maps above.
    expect(JSON.stringify({ ...step, env: undefined })).not.toMatch(/secrets\s*[.\[]/i)
  }
}

describe('exported public bootstrap workflow policy', () => {
  it('contains exactly the two public workflows and SDK root documentation', () => {
    expect(readdirSync(join(root, '.github')).sort()).toEqual(['pull_request_template.md', 'workflows'])
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
    assertCommonWorkflowPolicy({ source, parsed })
  })
  it('runs read-only CI for PRs into main, pushes to main and manual dispatch, without OIDC', () => {
    assertCiWorkflowPolicy(workflow('ci'))
  })
  it('checks, builds, packs, rehearses and publishes the same archives in one non-PR release job', () => {
    const { source, parsed } = workflow('release')
    expect(Object.keys(parsed.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(parsed.on.push).toEqual({ tags: ['sdk-v*'] })
    expect(parsed.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true })
    expect(parsed.on.workflow_dispatch.inputs.expected_version).toEqual({ required: true, type: 'string', description: 'Exact stable version to publish, e.g. 0.4.0' })
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
    expect(job.steps[publish].env).toEqual({ RELEASE_EVENT: '${{ github.event_name }}', RELEASE_REF: '${{ github.ref }}', RELEASE_DRY_RUN: '${{ inputs.dry_run }}', RELEASE_EXPECTED_VERSION: '${{ inputs.expected_version }}' })
    expect(commands[publish]).not.toContain('${{')
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
    ['tag push', 'push', 'refs/tags/sdk-v0.4.0', '', ['--directory', 'dist-sdk', '--expect-version', '0.4.0', '--provenance']],
    ['default dispatch', 'workflow_dispatch', 'refs/heads/main', '', ['--directory', 'dist-sdk', '--dry-run', '--expect-version', '0.4.0']],
    ['dry-run dispatch', 'workflow_dispatch', 'refs/heads/main', 'true', ['--directory', 'dist-sdk', '--dry-run', '--expect-version', '0.4.0']],
    ['real dispatch', 'workflow_dispatch', 'refs/heads/main', 'false', ['--directory', 'dist-sdk', '--expect-version', '0.4.0', '--provenance']],
  ])('passes the correct publisher arguments for %s', (_label, event, ref, dryRun, expected) => {
    const command = workflow('release').parsed.jobs.release.steps.find(step => step.run?.includes('bun scripts/sdk-publish.ts'))!.run!
    const directory = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-release-step-')))
    try {
      const capture = join(directory, 'args')
      writeFileSync(join(directory, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SDK_PUBLISH_CAPTURE"\n', { mode: 0o755 })
      execFileSync('bash', ['-euo', 'pipefail', '-c', command], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
        SDK_PUBLISH_CAPTURE: capture, RELEASE_EVENT: event as string, RELEASE_REF: ref as string, RELEASE_DRY_RUN: dryRun as string,
        RELEASE_EXPECTED_VERSION: event === 'push' ? 'invalid-and-ignored' : '0.4.0' } })
      expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual(['scripts/sdk-publish.ts', ...expected])
    } finally { cleanupTempDir(directory) }
  })
  it.each([
    ['push', 'refs/tags/sdk-v0.4.0-rc.1', '0.4.0'],
    ...[undefined, '', 'v0.4.0', '0.4.0-rc.1', '0.4.0; echo unsafe'].map(version => ['workflow_dispatch', 'refs/heads/main', version]),
  ])('rejects invalid release versions before publishing (%s, %s, %s)', (event, ref, version) => {
    const command = workflow('release').parsed.jobs.release.steps.find(step => step.run?.includes('bun scripts/sdk-publish.ts'))!.run!
    for (const dryRun of ['', 'true', 'false']) {
      const env = { ...process.env, RELEASE_EVENT: event, RELEASE_REF: ref, RELEASE_DRY_RUN: dryRun, RELEASE_EXPECTED_VERSION: version }
      if (version === undefined) delete env.RELEASE_EXPECTED_VERSION
      // A shell stub records any publisher invocation without touching npm or the registry.
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', 'bun() { echo PUBLISH_CALLED; };\n' + command], { env, encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(event === 'push' ? 'Invalid SDK release tag' : 'Invalid expected SDK release version')
    }
  })
  it.skipIf(!existsSync(join(process.cwd(), 'scripts/export-sdk.ts')))('keeps the private SDK release workflow absent', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/release.yml'))).toBe(false)
  })
})

it('CI reaches the single UI validator through root invariants', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  expect(manifest.scripts['check:ci-invariants']).toContain('&& bun run check:ui')
  expect(manifest.scripts['check:ui']).toBe('bun packages/plugins/console/ui/src/cli.ts')
  expect(workflow('ci').parsed.jobs.check.steps.some(step => step.run === 'bun run check:ci-invariants')).toBe(true)
})

it('CI checks the committed worker OpenAPI after the access lock', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const invariants = readFileSync(join(root, 'scripts/sdk-ci-invariants.ts'), 'utf8')
  expect(manifest.scripts['check:openapi']).toBe('bun scripts/check-openapi.ts')
  expect(manifest.scripts['openapi:write']).toBe('bun scripts/check-openapi.ts --write')
  expect(invariants.indexOf('await runOpenApiCli(')).toBeGreaterThan(invariants.indexOf('await runAccessCli('))
  expect(invariants).toContain("'packages/core/test/fixtures/worker-access/config.ts'")
  expect(JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).exports['./openapi/cli']).toBe('./src/openapi/cli.ts')
})

describe('CI diagnostic upload security regressions', () => {
  const upload = (document: Workflow) => document.jobs.check.steps.find(step => step.name === diagnosticUploadName)!
  const required = (document: Workflow) => document.jobs.check.steps.find(step => step.run === 'bun run test')!
  const cases: [string, (document: Workflow) => void][] = [
    ['completeness check removed', document => { document.jobs.check.steps = document.jobs.check.steps.filter(step => step.name !== completenessName) }],
    ['completeness check conditional', document => { document.jobs.check.steps.find(step => step.name === completenessName)!.if = 'success()' }],
    ['completeness check with extra env', document => { document.jobs.check.steps.find(step => step.name === completenessName)!.env = { TOKEN: 'credential' } }],
    ['unknown upload step', document => { delete upload(document).if; upload(document).name = 'Upload other files' }],
    ['additional upload step', document => { document.jobs.check.steps.push(structuredClone(upload(document))) }],
    ['upload with a tag', document => { upload(document).uses = 'actions/upload-artifact@v4' }],
    ['upload with a branch', document => { upload(document).uses = 'actions/upload-artifact@main' }],
    ['upload with a short SHA', document => { upload(document).uses = 'actions/upload-artifact@ea165f8' }],
    ['upload with an unknown full SHA', document => { upload(document).uses = 'actions/upload-artifact@' + 'a'.repeat(40) }],
    ['upload of workspace', document => { upload(document).with!.path = '${{ github.workspace }}/test-results/' }],
    ['upload of dot', document => { upload(document).with!.path = '.' }],
    ['upload with parent traversal', document => { upload(document).with!.path = '${{ runner.temp }}/list-v2-acceptance/../../**' }],
    ['upload with a broad glob', document => { upload(document).with!.path = '${{ runner.temp }}/**' }],
    ['upload of checkout directory', document => { upload(document).with!.path = './test-results/' }],
    ['upload with an extra path', document => { upload(document).with!.path += '\n${{ runner.temp }}/other-output/' }],
    ['upload with dynamic path', document => { upload(document).with!.path = '${{ env.LIST_V2_OUTPUT }}/results.json' }],
    ['upload without retention', document => { delete upload(document).with!['retention-days'] }],
    ['upload with unbounded retention', document => { upload(document).with!['retention-days'] = 90 }],
    ['upload with dynamic retention', document => { upload(document).with!['retention-days'] = '${{ inputs.days }}' }],
    ['upload with a secret', document => { upload(document).with!.name = '${{ secrets.ARTIFACT_NAME }}' }],
    ['upload with credential env', document => { upload(document).env = { TOKEN: 'credential' } }],
    ['upload with the existing check secret', document => { upload(document).env = { WORKBASE_PRIVATE_TERMS: '${{ secrets.WORKBASE_PRIVATE_TERMS }}' } }],
    ['upload with extra permissions', document => { Object.assign(upload(document), { permissions: { contents: 'write' } }) }],
    ['upload without always', document => { delete upload(document).if }],
    ['upload with a different condition', document => { upload(document).if = 'failure()' }],
    ['upload with extra inputs', document => { upload(document).with!['include-hidden-files'] = true }],
    ['download artifact', document => { document.jobs.check.steps.push({ uses: 'actions/download-artifact@' + 'a'.repeat(40) }) }],
    ['self-hosted runner', document => { document.jobs.check['runs-on'] = 'self-hosted' }],
    ['CI OIDC permission', document => { document.permissions['id-token'] = 'write' }],
    ['extra CI permission', document => { document.permissions.actions = 'write' }],
    ['extra job permission', document => { document.jobs.check.permissions = { contents: 'write' } }],
    ['workflow credential env', document => { document.env = { TOKEN: 'credential' } }],
    ['job credential env', document => { document.jobs.check.env = { TOKEN: 'credential' } }],
    ['check step credential env', document => { document.jobs.check.steps[0].env = { TOKEN: 'credential' } }],
    ['other action using the existing check secret', document => { document.jobs.check.steps[0].with!.token = '${{ secrets.WORKBASE_PRIVATE_TERMS }}' }],
    ['extra command using the existing check secret', document => { document.jobs.check.steps.push({ run: 'echo ${{ secrets.WORKBASE_PRIVATE_TERMS }}' }) }],
    ['required check condition', document => { required(document).if = 'always()' }],
    ['other step condition', document => { document.jobs.check.steps[0].if = 'always()' }],
    ['job condition', document => { document.jobs.check.if = 'always()' }],
  ]
  it('accepts the exact diagnostic step in otherwise unconditional read-only CI', () => {
    expect(workflow('ci').parsed.jobs.check.steps.filter(step => step.name === diagnosticUploadName)).toHaveLength(1)
    assertCiWorkflowPolicy(workflow('ci'))
  })
  it.each(cases)('rejects %s', (_name, mutate) => {
    const parsed = structuredClone(workflow('ci').parsed)
    mutate(parsed)
    expect(() => assertCiWorkflowPolicy({ parsed, source: JSON.stringify(parsed) })).toThrow()
  })
  it('rejects the diagnostic upload in the release workflow', () => {
    const parsed = structuredClone(workflow('release').parsed)
    parsed.jobs.release.steps.push(structuredClone(upload(workflow('ci').parsed)))
    expect(() => assertCommonWorkflowPolicy({ parsed, source: JSON.stringify(parsed) })).toThrow()
  })
})
