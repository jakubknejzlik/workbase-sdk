import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { registerTempDir, cleanupTempDir } from '../lib/test-temp-dir.mjs'

let root: string
beforeEach(() => { root = registerTempDir(mkdtempSync(join(tmpdir(), 'list-evidence-'))) })
afterEach(() => cleanupTempDir(root))
function probe(env: NodeJS.ProcessEnv, record = false) {
  const source = `import { tmpdir } from 'node:os';
    import { scratchRoot, output, record } from './packages/frontend-console/e2e/list-v2-evidence.ts';
    ${record ? "record('isolation', 'probe', true);" : ''}
    console.log(JSON.stringify({ scratchRoot, output, osTemp: tmpdir() }));`
  return JSON.parse(execFileSync('bun', ['--no-install', '--eval', source], { cwd: resolve('.'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
}
function environment() {
  const env = { ...process.env }
  delete env.LIST_V2_OUTPUT
  return env
}

it('defaults evidence to the exported TMPDIR, including spaces', () => {
  const temporary = join(root, 'caller temp')
  mkdirSync(temporary)
  const actual = probe({ ...environment(), TMPDIR: temporary })
  expect(actual.scratchRoot).toBe(temporary)
  expect(actual.output).toBe(join(temporary, 'list-v2-acceptance'))
  expect(existsSync(actual.output)).toBe(false)
})
it('uses the OS temp directory when TMPDIR is absent without creating evidence', () => {
  const env = environment()
  delete env.TMPDIR
  const actual = probe(env)
  expect(actual.scratchRoot).toBe(actual.osTemp)
  expect(actual.output).toBe(join(actual.osTemp, 'list-v2-acceptance'))
})
it('writes evidence only to LIST_V2_OUTPUT when both overrides are exported', () => {
  const temporary = join(root, 'caller temp')
  const output = join(root, 'caller evidence')
  mkdirSync(temporary)
  const actual = probe({ ...environment(), TMPDIR: temporary, LIST_V2_OUTPUT: output }, true)
  expect(actual.output).toBe(output)
  expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))).toEqual({ isolation: { probe: true } })
  expect(existsSync(join(temporary, 'list-v2-acceptance'))).toBe(false)
})
it('still rejects evidence inside the repository', () => {
  expect(() => probe({ ...environment(), LIST_V2_OUTPUT: resolve('test-results') })).toThrow(/LIST_V2_OUTPUT must be outside the repository/)
})
