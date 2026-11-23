import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { assertNoJobPaths } from './check-job-paths'

let root: string
beforeEach(() => {
  root = registerTempDir(mkdtempSync(join(tmpdir(), 'job-paths-')))
  execFileSync('git', ['init', '-q', root])
})
afterEach(() => cleanupTempDir(root))
function track(file: string, content: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
  execFileSync('git', ['add', '--', file], { cwd: root })
}

it.each(['scripts/probe.ts', 'packages/console/e2e/probe.ts', 'docs/harness.md', '.github/workflows/ci.yml'])('rejects job paths in %s', file => {
  track(file, '/tmp/' + ['codex', 'scratch'].join('-') + '/another-job/output')
  expect(() => assertNoJobPaths(root)).toThrow(file)
})
it('rejects a job identifier even without the scratch prefix', () => {
  track('docs/harness.md', '/somewhere/wr-' + 'deadbeef/output')
  expect(() => assertNoJobPaths(root)).toThrow('docs/harness.md')
})
it('checks working tree content and tracked file names', () => {
  track('docs/harness.md', 'neutral')
  writeFileSync(join(root, 'docs/harness.md'), 'wr-' + '1234abcd')
  expect(() => assertNoJobPaths(root)).toThrow('docs/harness.md')
  writeFileSync(join(root, 'docs/harness.md'), 'neutral')
  track('wr-' + 'abcdef12/probe.txt', 'neutral')
  expect(() => assertNoJobPaths(root)).toThrow('probe.txt')
})
it('allows neutral paths and ignores untracked local evidence', () => {
  track('docs/harness.md', "join(tmpdir(), 'list-v2-acceptance')")
  writeFileSync(join(root, 'untracked.log'), 'wr-' + 'deadbeef')
  expect(() => assertNoJobPaths(root)).not.toThrow()
})
