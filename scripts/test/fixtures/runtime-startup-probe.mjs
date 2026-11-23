import fs from 'node:fs'
import childProcess from 'node:child_process'
import net from 'node:net'
import { EventEmitter, once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const mkdtemp = fs.mkdtempSync
fs.mkdtempSync = () => mkdtemp(join(process.env.WORKBASE_TMP_PROBE_ROOT, 'runtime-'))
childProcess.execFileSync = () => Buffer.alloc(0)
const spawn = childProcess.spawn
let started, closed
childProcess.spawn = (_command, _args, options) => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    // The IPC listener keeps the successful worker alive until setup terminates it.
    process.on('message', () => {})
    process.stdout.write('worker startup diagnostic\\n', () => {
      if (process.env.WORKBASE_TMP_PROBE_FAIL === '1') {
        process.exitCode = 1
        process.disconnect()
      }
    })
  `], { ...options, stdio: [...options.stdio, 'ipc'] })
  started = once(child.stdout, 'data')
  closed = once(child, 'close')
  return child
}
globalThis.fetch = async () => {
  await started
  if (process.env.WORKBASE_TMP_PROBE_FAIL === '1') {
    await closed
    return { ok: false }
  }
  return { ok: true }
}
net.createConnection = () => {
  const socket = new EventEmitter()
  socket.setTimeout = () => socket
  process.nextTick(() => socket.emit('error', Object.assign(new Error('unused test port'), { code: 'ECONNREFUSED' })))
  return socket
}
syncBuiltinESMExports()
const { default: setup } = await import(pathToFileURL(resolve('packages/frontend-console/e2e/runtime/setup.ts')))
try {
  const stop = await setup()
  await stop()
  await closed
} catch (error) {
  const log = error.message.match(/; (.+\/worker\.log)$/)?.[1]
  console.log(JSON.stringify({ log, existsAfterThrow: log && fs.existsSync(log) }))
  throw error
}
