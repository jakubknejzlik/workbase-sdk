import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { registerTempDir, cleanupTempDir } from '../lib/test-temp-dir.mjs'

let root: string
beforeEach(() => { root = registerTempDir(mkdtempSync(join(tmpdir(), 'list-evidence-'))) })
afterEach(() => cleanupTempDir(root))
function run(source: string, env: NodeJS.ProcessEnv) {
  const stdout = execFileSync('bun', ['--no-install', '--eval', source], { cwd: resolve('.'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(stdout.trim().split('\n').at(-1)!)
}
function probe(env: NodeJS.ProcessEnv, marker = 'probe') {
  return run(`import { scratchRoot, output, record } from './packages/frontend-console/e2e/list-v2-evidence.ts';
    record('isolation', 'probe', ${JSON.stringify(marker)});
    console.log(JSON.stringify({ scratchRoot, output }));`, env)
}
function environment() {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root }
  delete env.LIST_V2_OUTPUT
  return env
}

it('gives independent runs fresh evidence directories under the same TMPDIR, including spaces', () => {
  const temporary = join(root, 'caller temp')
  mkdirSync(temporary)
  const env = { ...environment(), TMPDIR: temporary }
  const first = probe(env, 'first')
  const second = probe(env, 'second')
  expect(first.scratchRoot).toBe(temporary)
  expect(second.output).not.toBe(first.output)
  for (const [actual, marker] of [[first, 'first'], [second, 'second']] as const) {
    expect(dirname(actual.output)).toBe(temporary)
    expect(JSON.parse(readFileSync(join(actual.output, 'manifest.json'), 'utf8'))).toEqual({ isolation: { probe: marker } })
  }
  expect(readdirSync(temporary).sort()).toEqual([first.output, second.output].map(path => path.split('/').at(-1)).sort())
})
it('exports one coordinator directory to a spawned worker, including merged evidence and reporter paths', () => {
  const child = `import config from './packages/frontend-console/playwright.list-v2.config.ts';
    import { output, record } from './packages/frontend-console/e2e/list-v2-evidence.ts';
    record('shared', 'worker', true);
    console.log(JSON.stringify({ output, inherited: process.env.LIST_V2_OUTPUT, results: config.outputDir }));`
  const actual = run(`import config from './packages/frontend-console/playwright.list-v2.config.ts';
    import { execFileSync } from 'node:child_process';
    import { output, record } from './packages/frontend-console/e2e/list-v2-evidence.ts';
    record('shared', 'coordinator', true);
    const stdout = execFileSync(process.execPath, ['--no-install', '--eval', ${JSON.stringify(child)}], { encoding: 'utf8' });
    console.log(JSON.stringify({ output, inherited: process.env.LIST_V2_OUTPUT, results: config.outputDir, child: JSON.parse(stdout.trim().split('\\n').at(-1)) }));`, environment())
  expect(actual.inherited).toBe(actual.output)
  expect(actual.results).toBe(join(actual.output, 'test-results'))
  expect(actual.child).toEqual({ output: actual.output, inherited: actual.output, results: actual.results })
  expect(JSON.parse(readFileSync(join(actual.output, 'manifest.json'), 'utf8'))).toEqual({ shared: { coordinator: true, worker: true } })
  expect(readdirSync(root)).toHaveLength(1)
})
it('writes evidence only to the exact LIST_V2_OUTPUT when both overrides are exported', () => {
  const temporary = join(root, 'caller temp')
  const output = join(root, 'caller evidence')
  mkdirSync(temporary)
  const actual = probe({ ...environment(), TMPDIR: temporary, LIST_V2_OUTPUT: output })
  expect(actual.output).toBe(output)
  expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))).toEqual({ isolation: { probe: 'probe' } })
  expect(readdirSync(temporary)).toEqual([])
  expect(existsSync(join(temporary, 'list-v2-acceptance'))).toBe(false)
})
it('still rejects evidence inside the repository', () => {
  expect(() => probe({ ...environment(), LIST_V2_OUTPUT: resolve('test-results') })).toThrow(/LIST_V2_OUTPUT must be outside the repository/)
})
