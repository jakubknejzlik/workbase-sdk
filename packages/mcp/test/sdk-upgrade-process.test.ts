import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CORE_VERSION } from '@workbasehq/core/config'
import { copyHistoricalInstances } from './fixtures.ts'
import { captureSdkInputs } from '../src/sdk-target.ts'

class Peer {
  child: ChildProcess
  private next = 0
  private responses = new Map<number, (value: any) => void>()
  private events: any[] = []
  private waiter?: (event: any) => void
  readonly closed: Promise<unknown>
  stderr = ''
  constructor(entry: string, root: string) {
    this.child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), entry, '--root', root], {
      env: { ...process.env, WORKBASE_MCP_DEV_MODULE: resolve('packages/mcp/test/fixtures/dev-module.ts') }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    this.closed = once(this.child, 'close')
    this.child.stderr!.on('data', bytes => { this.stderr += bytes })
    createInterface({ input: this.child.stdout! }).on('line', line => {
      const response = JSON.parse(line)
      this.responses.get(response.id)?.(response); this.responses.delete(response.id)
    })
    this.child.on('message', event => {
      if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve(event) }
      else this.events.push(event)
    })
  }
  event(): Promise<any> { return this.events.length ? Promise.resolve(this.events.shift()) : new Promise(resolve => { this.waiter = resolve }) }
  send(method: string, params: unknown, id?: number) { this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params, ...(id !== undefined ? { id } : {}) }) + '\n') }
  request(method: string, params: unknown) {
    const id = ++this.next
    const result = new Promise<any>(resolve => this.responses.set(id, resolve))
    this.send(method, params, id)
    return { id, result: Promise.race([result, this.closed.then(() => { throw new Error(`MCP exited: ${this.stderr}`) })]) }
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sdk-contention', version: '1' } }).result
    this.send('notifications/initialized', {})
  }
  async call(name: string, args: unknown) { return (await this.request('tools/call', { name, arguments: args }).result).result.structuredContent }
  release() { this.child.send('continue') }
}
let scratch: string, root: string, entry: string, peers: Peer[]
beforeEach(async () => {
  scratch = registerTempDir(await mkdtemp(join(tmpdir(), 'wb-sdk-mcp-process-')))
  await writeFile(join(scratch, 'package.json'), '{"type":"module"}\n')
  await symlink(resolve('node_modules'), join(scratch, 'node_modules'))
  await copyHistoricalInstances(scratch)
  root = join(scratch, 'examples/sample')
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'bun.lock'), 'historical fixture lock\n')
  const sql = join(root, 'migrations/0001_initial.sql')
  await writeFile(sql, (await readFile(sql, 'utf8')).replaceAll(`'${CORE_VERSION}'`, "'0.2.1'"))
  const runtime = join(scratch, 'packages/mcp')
  await cp(resolve('packages/mcp/src'), join(runtime, 'src'), { recursive: true })
  await cp(resolve('packages/mcp/package.json'), join(runtime, 'package.json'))
  await symlink(resolve('packages/mcp/node_modules'), join(runtime, 'node_modules'))
  await writeFile(join(runtime, 'src/sdk-target.ts'), `export { captureSdkInputs, runSdkTarget } from ${JSON.stringify(resolve('packages/mcp/test/fixtures/sdk-upgrade-process.ts'))}\n`)
  entry = join(runtime, 'src/stdio.ts'); peers = []
  await writeFile(entry, (await readFile(entry, 'utf8')).replace('process.exitCode = 0', 'process.disconnect?.(); process.exitCode = 0').replace('const { server, idle } = await createServer({ root, allowed })', `const { server, idle } = await createServer({ root, allowed })
  process.on('message', async message => { if (message === 'idle') { await idle(); process.send?.({ event: 'idle' }) } })`))
})
afterEach(async () => {
  for (const peer of peers) {
    if (peer.child.exitCode === null && peer.child.signalCode === null) {
      peer.child.kill('SIGTERM')
      peer.release()
    }
    await peer.closed
  }
  cleanupTempDir(scratch)
})
it.each([['request cancellation', 'verify'], ['stdin EOF', 'verify'], ['SIGTERM', 'verify'], ['request cancellation', 'install']] as const)('keeps a second actual MCP process busy across install, verification and group cleanup on %s at %s', async (cancellation, phase) => {
  const owner = new Peer(entry, root); peers.push(owner); await owner.init()
  const competitor = new Peer(entry, root); peers.push(competitor); await competitor.init()
  const proposed = await owner.call('upgrade_sdk', { instance: 'sample', baseRevision: 2, targetVersion: '0.2.10' })
  expect(proposed.ok).toBe(true)
  const proposalId = proposed.proposalId, before = await captureSdkInputs(root)
  const running = owner.request('tools/call', { name: 'apply_to_disposable', arguments: { proposalId, keep: true } })
  const install = await owner.event(); expect(install.event).toBe('install')
  expect(await competitor.call('validate', { instance: 'sample' })).toMatchObject({ error: { code: 'instance_busy' } })
  let verify = install
  if (phase === 'verify') {
    owner.release()
    verify = await owner.event(); expect(verify.event).toBe('verify')
    expect(await competitor.call('validate', { instance: 'sample' })).toMatchObject({ error: { code: 'instance_busy' } })
  }
  // Consume rejection on EOF/shutdown; MCP may close before returning the tool result.
  void running.result.catch(() => undefined)
  if (cancellation === 'request cancellation') owner.send('notifications/cancelled', { requestId: running.id, reason: 'test cancellation' })
  else if (cancellation === 'stdin EOF') owner.child.stdin!.end()
  else owner.child.kill('SIGTERM')
  const cleanup = await owner.event(); expect(cleanup.event).toBe('cleanup')
  expect(() => process.kill(verify.descendant, 0)).not.toThrow()
  // Cleanup is held by IPC with a living descendant, not a timed sleep.
  expect(await competitor.call('validate', { instance: 'sample' })).toMatchObject({ error: { code: 'instance_busy' } })
  owner.release()
  expect((await owner.event()).event).toBe('cleaned')
  if (cancellation !== 'request cancellation') { await owner.closed; expect(owner.child.exitCode, owner.stderr).toBe(0) }
  else {
    owner.child.send('idle')
    expect((await owner.event()).event).toBe('idle')
    expect((await owner.call('inspect_schema', { instance: 'sample' })).ok).toBe(true)
  }
  expect(() => process.kill(verify.descendant, 0)).toThrow()
  await expect(readFile(join(verify.scratch, 'barrier.sock'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await competitor.call('validate', { instance: 'sample' })).ok).toBe(true)
  const saved = JSON.parse(await readFile(join(root, 'proposals', `${proposalId}.json`), 'utf8'))
  expect(saved.status).toBe('proposed'); expect(saved.evidence).toBeUndefined()
  expect(await captureSdkInputs(root)).toEqual(before)
})
