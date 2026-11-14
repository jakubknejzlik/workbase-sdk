import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { assertSmokeNetworkIsolation, isolateSmokeNetwork } from '../lib/smoke-network'

const scratch = mkdtempSync(join(tmpdir(), 'workbase-smoke-network-'))
const guard = join(scratch, 'offline.mjs')
const source = readFileSync(new URL('../smoke-template.ts', import.meta.url), 'utf8')
writeFileSync(guard, /writeFileSync\(guard, `([\s\S]*?)`\)/.exec(source)![1])
let requests = 0, port = 0
const server = createServer((_, response) => { requests++; response.end('unexpected network') })
it('Linux creates only a privileged network namespace and drops runner privileges before execution', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  try {
    const [command, args] = isolateSmokeNetwork('/runner/bin/bun', ['--eval', 'console.log(1)'], { PATH: '/runner/bin', NODE_OPTIONS: '--import=/runner/offline.mjs', NODE_PATH: '' })
    expect(command).toBe('sudo')
    expect(args).toContain('--non-interactive')
    expect(args).toContain('--net')
    expect(args).not.toContain('--user')
    expect(args).not.toContain('--map-root-user')
    expect(args).toContain('/usr/bin/setpriv')
    expect(args).toContain(`--reuid=${process.getuid!()}`)
    expect(args).toContain(`--regid=${process.getgid!()}`)
    expect(args).toContain('--no-new-privs')
    expect(args).toContain('--bounding-set=-all')
    expect(args).toContain('--inh-caps=-all')
    expect(args).toContain('--ambient-caps=-all')
    expect(args).toContain('PATH=/runner/bin')
    expect(args).toContain('NODE_OPTIONS=--import=/runner/offline.mjs')
    expect(args.slice(-3)).toEqual(['/runner/bin/bun', '--eval', 'console.log(1)'])
  } finally { platform.mockRestore() }
})
it('proves the isolation wrapper starts and fails loudly if it cannot execute', () => {
  expect(() => assertSmokeNetworkIsolation()).not.toThrow()
  expect(() => assertSmokeNetworkIsolation(process.env, join(scratch, 'missing-directory'))).toThrow('Packed smoke IP isolation unavailable; refusing post-install execution')
})
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
})
async function run(command: string, args: string[], isolated = false) {
  const [cmd, argv] = isolated ? isolateSmokeNetwork(command, args) : [command, args]
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(cmd, argv, { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10000 })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output }))
  })
}
for (const runtime of ['node', 'bun']) {
  it(`${runtime}: preload denies fetch, Socket.prototype.connect and UDP`, async () => {
    for (const code of [
      `await fetch('http://127.0.0.1:${port}/fetch')`,
      `import { Socket } from 'node:net'; new Socket().connect(${port}, '127.0.0.1')`,
      `import dgram from 'node:dgram'; dgram.createSocket('udp4').send('probe', ${port}, '127.0.0.1')`,
    ]) {
      const result = await run(runtime, [runtime === 'node' ? '--import' : '--preload', guard, '--input-type=module', '--eval', code])
      expect(result.code).not.toBe(0)
      expect(result.output).toContain('Packed smoke forbids network after install')
    }
  })
  it(`${runtime}: OS isolation denies sockets and descendants with cleared loader options`, async () => {
    // No preload: cover APIs that bypass JS patches. First prove reachability.
    const fetch = `await fetch('http://127.0.0.1:${port}/control')`
    expect((await run(runtime, ['--input-type=module', '--eval', fetch])).code).toBe(0)
    const before = requests
    const started = await run(runtime, ['--input-type=module', '--eval', `console.log('ISOLATED CHILD STARTED')`], true)
    expect(started.code, started.output).toBe(0)
    expect(started.output).toContain('ISOLATED CHILD STARTED')
    for (const code of [
      fetch,
      `import { Socket } from 'node:net'; new Socket().connect(${port}, '127.0.0.1', function () { this.write('GET /socket HTTP/1.0\\r\\n\\r\\n') })`,
      `import tls from 'node:tls'; tls.connect(${port}, '127.0.0.1')`,
      `import dgram from 'node:dgram'; const s = dgram.createSocket('udp4'); s.send('probe', ${port}, '127.0.0.1', error => { s.close(); if (error) throw error })`,
      `import { execFileSync } from 'node:child_process'; execFileSync(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(fetch)}], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' })`,
    ]) {
      const result = await run(runtime, ['--input-type=module', '--eval', `console.log('ISOLATED ATTEMPT STARTED'); ${code}`], true)
      expect(result.output).toContain('ISOLATED ATTEMPT STARTED')
      expect(result.code, result.output).not.toBe(0)
      // Bun can report a sandbox denial as ECONNREFUSED. The control above
      // reaches the same live listener, and its request count must stay fixed.
      expect(result.output).toMatch(/EPERM|EACCES|ENETUNREACH|ECONNREFUSED|Operation not permitted/)
    }
    expect(requests).toBe(before)
  })
}
