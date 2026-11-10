import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let allocated
const mkdtemp = fs.mkdtempSync
fs.mkdtempSync = (...args) => { allocated = mkdtemp(...args); return allocated }
childProcess.execFileSync = () => {
  if (process.env.WORKBASE_TMP_PROBE_FAIL === '1') throw new Error('injected dependency install failure')
  return Buffer.from('')
}
syncBuiltinESMExports()
const { prepareConsumerDependencies } = await import(pathToFileURL(resolve('scripts/lib/packed-consumer-dependencies.ts')))
try {
  const directory = prepareConsumerDependencies(process.env.WORKBASE_TMP_PROBE_ROOT)
  if (prepareConsumerDependencies(process.env.WORKBASE_TMP_PROBE_ROOT) !== directory) throw new Error('dependencies not reused within process')
  console.log(JSON.stringify({ directory }))
  if (process.env.WORKBASE_TMP_PROBE_WAIT === '1') setInterval(() => {}, 1000)
} catch (error) {
  console.log(JSON.stringify({ directory: allocated }))
  throw error
}
