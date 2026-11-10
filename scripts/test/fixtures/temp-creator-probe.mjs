import fs from 'node:fs'
import promises from 'node:fs/promises'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const readdir = fs.readdirSync
fs.readdirSync = (path, ...args) => String(path).endsWith('/dist-sdk') ? ['workbasehq-core-0.0.0.tgz'] : readdir(path, ...args)

let allocated
const syncTemp = fs.mkdtempSync, asyncTemp = promises.mkdtemp
const report = directory => {
  allocated = directory
  console.log(JSON.stringify({ directory }))
  return directory
}
fs.mkdtempSync = () => report(syncTemp(join(process.env.WORKBASE_TMP_PROBE_ROOT, 'creator-')))
promises.mkdtemp = async () => report(await asyncTemp(join(process.env.WORKBASE_TMP_PROBE_ROOT, 'creator-')))
for (const [module, name] of [[fs, 'writeFileSync'], [fs, 'mkdirSync'], [promises, 'mkdir']]) {
  const original = module[name]
  module[name] = (...args) => {
    if (allocated) throw new Error('injected scratch setup failure')
    return original(...args)
  }
}
const exec = childProcess.execFileSync
childProcess.execFileSync = (...args) => {
  if (allocated) throw new Error('injected scratch setup failure')
  return exec(...args)
}
syncBuiltinESMExports()
const entry = await import(pathToFileURL(resolve(process.env.WORKBASE_TMP_PROBE_MODULE)))
if (entry.startFixture) await entry.startFixture()
else if (entry.default) await entry.default()
