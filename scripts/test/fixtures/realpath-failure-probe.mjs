import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

const allocated = new Set()
const report = directory => {
  allocated.add(directory)
  fs.appendFileSync(process.env.WORKBASE_TMP_PROBE_RECORD, JSON.stringify(directory) + '\n')
  return directory
}
for (const [module, name] of [[fs, 'mkdtempSync'], [promises, 'mkdtemp']]) {
  const original = module[name]
  module[name] = (prefix, ...args) => {
    if (!basename(prefix).startsWith(process.env.WORKBASE_TMP_PROBE_PREFIX)) return original(prefix, ...args)
    const result = original(join(process.env.WORKBASE_TMP_PROBE_ROOT, 'realpath-'), ...args)
    return name === 'mkdtemp' ? result.then(report) : report(result)
  }
}
for (const [module, name] of [[fs, 'realpathSync'], [promises, 'realpath']]) {
  const original = module[name]
  const fail = path => {
    if (allocated.has(path)) throw Object.assign(new Error('injected realpath EACCES'), { code: 'EACCES' })
  }
  module[name] = name === 'realpath' ? async (...args) => { fail(args[0]); return original(...args) }
    : Object.assign((...args) => { fail(args[0]); return original(...args) }, { native: original.native })
}
syncBuiltinESMExports()
