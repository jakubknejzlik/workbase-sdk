import { registerTempDir, cleanupTempDir } from '../../../../scripts/lib/test-temp-dir.mjs'
import { createServer, type Socket } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execute } from '../../src/sdk-process.ts'
import { captureSdkInputs, type TargetOptions } from '../../src/sdk-target.ts'
import { targetProof } from './sdk-upgrade-evidence.ts'

// Test adapter at the D2 boundary. The MCP stdio server, Workflow, Store and
// process-group runner are real. D2's install/bridge contract has its own tests.
export { captureSdkInputs }
export async function runSdkTarget(options: TargetOptions) {
  const workDir = registerTempDir(await mkdtemp(join(tmpdir(), 'i')))
  let scratch: string | undefined
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let text = ''
    socket.on('data', bytes => {
      text += bytes
      for (let index; (index = text.indexOf('\n')) >= 0;) {
        const event = JSON.parse(text.slice(0, index)); text = text.slice(index + 1)
        process.send?.({ ...event, scratch })
      }
    })
  })
  const command = (message: unknown) => {
    for (const socket of sockets) socket.write(JSON.stringify(message) + '\n')
  }
  try {
    // Darwin's Unix socket limit includes the whole path, independently of TMPDIR.
    scratch = registerTempDir(await mkdtemp('/tmp/wbs-'))
    const socketPath = join(scratch, 'barrier.sock')
    const socketBytes = Buffer.byteLength(socketPath)
    if (socketBytes > 100) throw new Error(`Test IPC socket path exceeds 100 bytes (${socketBytes} bytes)`)
    process.on('message', command)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve() })
    })
    for (const phase of ['install', 'verify']) {
      const descendant = `
        const net = require('node:net');
        const socket = net.connect(${JSON.stringify(socketPath)});
        socket.on('connect', () => socket.write(JSON.stringify({event:${JSON.stringify(phase)},descendant:process.pid})+'\\n'));
        process.on('SIGTERM', () => socket.write(JSON.stringify({event:'cleanup',descendant:process.pid})+'\\n'));
        socket.on('data', bytes => { if (bytes.toString().includes('continue')) process.exit(0) });
      `
      const launcher = `
        process.on('SIGTERM',()=>{});
        const child = require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
        child.on('exit',()=>process.exit(0));
      `
      const result = await execute([process.execPath, '-e', launcher], workDir, { signal: options.signal, timeoutMs: 30000, killGraceMs: 30000 })
      options.signal?.throwIfAborted()
      if (result.rc !== 0) throw new Error('Controlled target failed')
    }
    return await targetProof(options)
  } finally {
    process.removeListener('message', command)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (scratch) cleanupTempDir(scratch)
    cleanupTempDir(workDir)
    process.send?.({ event: 'cleaned', scratch })
  }
}
