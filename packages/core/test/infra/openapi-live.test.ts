import { createServer } from 'node:http'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { runOpenApiCli } from '../../src/openapi/cli'
import { sha256 } from '../../src/infra/migration-files'
import type { RuntimeEnv } from '../../src/types'

it('verifies a local app over HTTP and rejects byte/hash/status mismatches and a stale bundle', async () => {
  const root = await mkdtemp(resolve('packages/core/test/fixtures/openapi-live-'))
  const server = createServer(async (req, res) => {
    const response = await handle(new Request(origin + req.url))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(new Uint8Array(await response.arrayBuffer()))
  })
  let origin = '', handle: (request: Request) => Promise<Response>
  try {
    await cp(resolve('packages/core/test/fixtures/worker-access'), root, { recursive: true })
    const args = ['--config', join(root, 'config.ts')]
    const original = await readFile(join(root, 'openapi.json'), 'utf8')
    const bundlePath = join(root, 'bundle.mjs')
    execFileSync('bun', ['build', join(root, 'config.ts'), '--target=browser', '--external=node:*', '--format=esm', '--outfile', bundlePath], { stdio: 'pipe' })
    const bundled = (await import(pathToFileURL(bundlePath).href)).default
    const app = (hash: string) => createApp(bundled, { DB: {}, OPENAPI_SHA256: hash } as RuntimeEnv)
    handle = async request => app(sha256(original)).request(request)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const live = [...args, '--live', origin]
    expect(await runOpenApiCli(live)).toBe(0)
    handle = async request => app('0'.repeat(64)).request(request)
    expect(await runOpenApiCli(live)).toBe(1)
    handle = async request => new URL(request.url).pathname === '/openapi.json' ? new Response(original + '\n') : app(sha256(original)).request(request)
    expect(await runOpenApiCli(live)).toBe(1)
    for (const response of [Response.json({ sha: 'unbuilt' }), new Response('', { status: 503 })]) {
      handle = async request => new URL(request.url).pathname === '/build.json' ? response.clone() : app(sha256(original)).request(request)
      expect(await runOpenApiCli(live)).toBe(1)
    }
    // Rebuild only the disk artifact; the running bundle still carries its original import.
    const field = join(root, 'schema/worker.ts')
    await writeFile(field, (await readFile(field, 'utf8')).replace("type: 'text'", "type: 'string'"))
    expect(await runOpenApiCli([...args, '--write'])).toBe(0)
    const updated = await readFile(join(root, 'openapi.json'), 'utf8')
    expect(updated).not.toBe(original)
    expect(await runOpenApiCli(args)).toBe(0)
    for (const hash of [sha256(original), sha256(updated)]) {
      handle = async request => app(hash).request(request)
      expect(await runOpenApiCli(live)).toBe(1)
    }
    expect(await readFile(join(root, 'openapi.json'), 'utf8')).toBe(updated)
    await expect(runOpenApiCli([...live, '--write'])).rejects.toThrow('Usage')
    await expect(runOpenApiCli([...args, '--live', origin + '/path'])).rejects.toThrow('Usage')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
})
