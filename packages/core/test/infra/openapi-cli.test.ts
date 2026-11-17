import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { runOpenApiCli } from '../../src/openapi/cli'

const bytes = '{"openapi":"3.1.0"}\n'
vi.mock('../../src/schema/load', () => ({ loadConfig: vi.fn(async () => ({ config: {}, configHash: 'fixture' })) }))
vi.mock('../../src/kernel/registry', () => ({ KernelRegistry: class { config = {} } }))
vi.mock('../../src/openapi/generate', () => ({ generate: () => '{"openapi":"3.1.0"}\n' }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'openapi-diagnostics-')); roots.push(root)
  return { root, args: ['--root', root] }
}

it('keeps default standalone informational and error messages and exit codes', async () => {
  const { args, root } = await fixture()
  const info = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await runOpenApiCli(args)).toBe(1)
  expect(error).toHaveBeenLastCalledWith('check:openapi: missing openapi.json; run bun run openapi:write')
  expect(await runOpenApiCli([...args, '--write'])).toBe(0)
  expect(info).toHaveBeenLastCalledWith('openapi:write: regenerated openapi.json')
  expect(await runOpenApiCli(args)).toBe(0)
  expect(info).toHaveBeenLastCalledWith('check:openapi: openapi.json matches configuration and registered operations')
  await writeFile(join(root, 'openapi.json'), 'stale')
  expect(await runOpenApiCli(args)).toBe(1)
  expect(error).toHaveBeenLastCalledWith('check:openapi: stale openapi.json; run bun run openapi:write')
})

it('sends every diagnostic to the injected sink without writing stdout or stderr', async () => {
  const { args, root } = await fixture()
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const diagnostics = { info: vi.fn(), error: vi.fn() }
  const run = (extra: string[] = []) => runOpenApiCli([...args, ...extra], {}, diagnostics)
  expect(await run()).toBe(1)
  expect(await run(['--write'])).toBe(0)
  await writeFile(join(root, 'openapi.json'), 'stale')
  expect(await run()).toBe(1)
  expect(await run(['--write'])).toBe(0)
  expect(await run()).toBe(0)
  const hash = createHash('sha256').update(bytes).digest('hex')
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(url.pathname === '/openapi.json' ? bytes : JSON.stringify({ openapi: hash }))))
  expect(await run(['--live', 'https://example.test'])).toBe(0)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  expect(await run(['--live', 'https://example.test'])).toBe(1)
  expect(diagnostics.info.mock.calls.flat()).toEqual([
    'openapi:write: regenerated openapi.json', 'openapi:write: regenerated openapi.json',
    'check:openapi: openapi.json matches configuration and registered operations',
    'check:openapi: live bytes, build.json.openapi and committed file hashes match',
    'check:openapi: openapi.json matches configuration and registered operations',
  ])
  expect(diagnostics.error.mock.calls.flat()).toEqual([
    'check:openapi: missing openapi.json; run bun run openapi:write',
    'check:openapi: stale openapi.json; run bun run openapi:write',
    'check:openapi: live OpenAPI verification failed (served bytes, build.json.openapi and committed file must match)',
  ])
  await expect(run(['--live', 'https://example.test', '--write'])).rejects.toThrow('Usage')
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).not.toHaveBeenCalled()
})
