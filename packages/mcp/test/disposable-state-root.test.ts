import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const repo = resolve('.')
async function probe(value: string | undefined, mode = 'paths') {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'disposable-state-root-')))
  try {
    const launch = join(parent, 'launch')
    await mkdir(launch)
    const env = { ...process.env }
    if (value === undefined) delete env.WORKBASE_MCP_STATE_ROOT
    else env.WORKBASE_MCP_STATE_ROOT = value === 'absolute' ? join(parent, 'absolute-state') : value
    const { stdout } = await run(process.execPath, ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'),
      join(repo, 'packages/mcp/test/fixtures/disposable-state-root.mjs'), repo, mode], { cwd: launch, env })
    return JSON.parse(stdout.trim().split('\n').at(-1)!)
  } finally { await rm(parent, { recursive: true, force: true }) }
}
function paths(result: Awaited<ReturnType<typeof probe>>) {
  expect(result.stateRoot).toBe(result.expectedRoot)
  expect(isAbsolute(result.stateRoot)).toBe(true)
  expect(result.existsAfterImport).toBe(result.existedBeforeImport)
  expect(result.calls).toHaveLength(2)
  for (const call of result.calls) {
    expect(isAbsolute(call.cwd)).toBe(true)
    expect(dirname(call.cwd)).toBe(result.stateRoot)
    for (const [key, leaf] of [['config', 'wrangler.json'], ['persistence', 'persist'], ['log', 'wrangler.log']]) {
      expect(isAbsolute(call[key])).toBe(true)
      expect(call[key]).toBe(join(call.cwd, leaf))
      // Resolving from Wrangler's cwd must not repeat the state/proposal prefix.
      expect(resolve(call.cwd, call[key])).toBe(call[key])
    }
  }
  expect(result.removedExists).toBe(false)
  expect(result.keptExists).toBe(true)
  expect(result.kept.directory).toBe(result.calls[1].cwd)
  expect(result.entries.filter((entry: string) => /(^|\/)proposal-[^/]+$/.test(entry))).toEqual([
    result.calls[1].cwd.slice(result.stateRoot.length + 1),
  ])
}
it.each(['./.inbox/mcp-state', '.', '../state', 'absolute'])('anchors %s and all Wrangler paths to one scratch directory', async value => {
  const result = await probe(value)
  paths(result)
  expect(result.removed).toEqual({ verified: false, diffs: [{ code: 'disposable_apply_failed', message: 'Wrangler rejected the disposable migration' }] })
  expect(JSON.stringify(result.kept)).not.toContain('PRIVATE_WRANGLER_OUTPUT')
})
it('keeps a relative root anchored after cwd changes following module initialization', async () => {
  paths(await probe('./.inbox/mcp-state', 'anchored'))
})
it('preserves the unset default without creating state there', async () => {
  const result = await probe(undefined, 'default')
  expect(result.stateRoot).toBe('/tmp/codex/mcp-state')
  expect(result.existsAfterImport).toBe(result.existedBeforeImport)
})
it('validates a real proposal and applies it with real Wrangler using a relative root', async () => {
  const result = await probe('./.inbox/mcp-state', 'real')
  expect(result.removed).toEqual({ ok: true, verified: true, diffs: [] })
  expect(result.kept).toMatchObject({ ok: true, verified: true, diffs: [] })
  paths(result)
})
