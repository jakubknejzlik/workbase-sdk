import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { execute } from '../src/sdk-process'

const groups = new Set<number>()
afterEach(() => { for (const pid of groups) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } } groups.clear() })
it('preserves command output and exit status', async () => {
  expect(await execute([process.execPath, '-e', "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7"], process.cwd())).toEqual({ rc: 7, stdout: 'out', stderr: 'err', timedOut: false })
})
it.each(['stdout', 'stderr'])('bounds captured %s before returning', async stream => {
  await expect(execute([process.execPath, '-e', `process.${stream}.write('x'.repeat(100000))`], process.cwd(), { maxOutputBytes: 1024 })).rejects.toThrow(/output/i)
})
it.each(['stdout', 'stderr'] as const)('bounds streaming %s and cleans the process group before rejecting', async stream => {
  const server = createServer()
  const ready = new Promise<{ leader: number; descendant: number }>(resolve => {
    server.once('connection', socket => { socket.once('data', bytes => { socket.end('emit'); resolve(JSON.parse(bytes.toString())) }) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const descendant = `process.on('SIGTERM',()=>{}); require('node:net').connect(${port},'127.0.0.1',function(){this.write(JSON.stringify({leader:process.ppid,descendant:process.pid}))}).on('data',()=>process.send?.('ready')); setInterval(()=>{},1000)`
  const launcher = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']}); child.on('message',()=>process.${stream}.write(Buffer.alloc(4096),()=>process.exit(0)));`
  let bytes = 0
  const controller = new AbortController()
  const pending = execute([process.execPath, '-e', launcher], process.cwd(), {
    signal: controller.signal, timeoutMs: 3000, killGraceMs: 50, maxOutputBytes: 1,
    [stream === 'stdout' ? 'onStdout' : 'onStderr']: (chunk: Buffer) => { bytes += chunk.length },
  }).then(result => ({ result, error: undefined }), (error: Error) => ({ result: undefined, error }))
  try {
    const { leader, descendant } = await Promise.race([ready, pending.then(() => { throw new Error('Command ended before descendant readiness') })])
    groups.add(leader)
    const outcome = await pending
    expect(() => process.kill(descendant, 0)).toThrow()
    expect(() => process.kill(-leader, 0)).toThrow()
    groups.delete(leader)
    expect(bytes).toBeLessThanOrEqual(1)
    expect(bytes).toBe(1)
    expect(outcome.error?.message).toBe(`Command ${stream} output exceeds 1 bytes`)
    expect(outcome.result).toBeUndefined()
  } finally { controller.abort(); await pending; await new Promise<void>(resolve => server.close(() => resolve())) }
})
it.each(['stdout', 'stderr'] as const)('accepts exactly the per-stream budget with streaming %s', async stream => {
  const chunks: Buffer[] = []
  const result = await execute([process.execPath, '-e', "process.stdout.write(Buffer.alloc(4, 255)); process.stderr.write(Buffer.alloc(4, 254))"], process.cwd(), {
    maxOutputBytes: 4, [stream === 'stdout' ? 'onStdout' : 'onStderr']: (chunk: Buffer) => { chunks.push(chunk) },
  })
  expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(4, stream === 'stdout' ? 255 : 254))
  expect(result.rc).toBe(0)
  expect(result[stream]).toBe('')
})
it.each(['stdout', 'stderr'] as const)('delivers no streaming %s bytes with a zero budget', async stream => {
  let bytes = 0
  await expect(execute([process.execPath, '-e', `process.${stream}.write(Buffer.alloc(4096))`], process.cwd(), {
    maxOutputBytes: 0, [stream === 'stdout' ? 'onStdout' : 'onStderr']: (chunk: Buffer) => { bytes += chunk.length },
  })).rejects.toThrow(`Command ${stream} output exceeds 0 bytes`)
  expect(bytes).toBe(0)
})
it('does not spawn for an already cancelled operation', async () => {
  const controller = new AbortController(); controller.abort()
  const result = await execute([process.execPath, '-e', "process.stdout.write('spawned')"], process.cwd(), { signal: controller.signal })
  expect(result).toMatchObject({ rc: 124, stdout: '', timedOut: true })
})
it.each(['cancel', 'timeout', 'launcher-exit'])('kills a resistant descendant before returning: %s', async mode => {
  const server = createServer(), controller = new AbortController()
  const ready = new Promise<{ leader: number; descendant: number }>(resolve => {
    server.once('connection', socket => { socket.once('data', bytes => { socket.end('exit'); resolve(JSON.parse(bytes.toString())) }) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  // The descendant closes stdio and ignores SIGTERM. The launcher exits on
  // SIGTERM, so its close event alone cannot authorize completion.
  const descendant = `process.on('SIGTERM',()=>{}); require('node:net').connect(${port},'127.0.0.1',function(){this.write(JSON.stringify({leader:process.ppid,descendant:process.pid}))}).on('data',()=>process.send?.('ready')); setInterval(()=>{},1000)`
  const launcher = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']}); process.on('SIGTERM',()=>process.exit(0)); ${mode === 'launcher-exit' ? "child.on('message',()=>process.exit(0))" : 'setInterval(()=>{},1000)'};`
  const pending = execute([process.execPath, '-e', launcher], process.cwd(), { signal: controller.signal, timeoutMs: mode === 'timeout' ? 1000 : 3000, killGraceMs: 100 })
  try {
    const { leader, descendant } = await Promise.race([ready, pending.then(() => { throw new Error('Command ended before descendant readiness') })])
    groups.add(leader)
    if (mode === 'cancel') controller.abort()
    const result = await pending
    expect(result.timedOut).toBe(mode !== 'launcher-exit')
    expect(() => process.kill(descendant, 0)).toThrow()
    expect(() => process.kill(-leader, 0)).toThrow()
    groups.delete(leader)
  } finally { controller.abort(); try { await pending } finally { await new Promise<void>(resolve => server.close(() => resolve())) } }
})
it('reports spawn failure and releases signal handlers', async () => {
  const listeners = process.listenerCount('SIGTERM')
  await expect(execute(['/nonexistent-sdk-command'], process.cwd())).rejects.toThrow()
  expect(process.listenerCount('SIGTERM')).toBe(listeners)
})
