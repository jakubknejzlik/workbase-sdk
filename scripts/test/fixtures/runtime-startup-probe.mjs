import fs from 'node:fs'
import childProcess from 'node:child_process'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const mkdtemp = fs.mkdtempSync
fs.mkdtempSync = () => mkdtemp(join(process.env.WORKBASE_TMP_PROBE_ROOT, 'runtime-'))
childProcess.execFileSync = () => Buffer.alloc(0)
const child = { exitCode: process.env.WORKBASE_TMP_PROBE_FAIL === '1' ? 1 : null }
childProcess.spawn = (_command, _args, options) => {
  fs.writeSync(options.stdio[1], 'worker startup diagnostic\n')
  return child
}
globalThis.fetch = async () => ({ ok: true })
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
  child.exitCode = 0
  await stop()
} catch (error) {
  const log = error.message.match(/; (.+\/worker\.log)$/)?.[1]
  console.log(JSON.stringify({ log, existsAfterThrow: log && fs.existsSync(log) }))
  throw error
}
