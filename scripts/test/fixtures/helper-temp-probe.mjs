import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTempDir, cleanupTempDir } from '../../lib/test-temp-dir.mjs'

const root = process.env.WORKBASE_TMP_PROBE_ROOT
const directory = join(root, 'work'), diagnostic = join(root, 'diagnostic.log')
mkdirSync(directory)
writeFileSync(diagnostic, 'diagnostic evidence')
registerTempDir(directory)
// Retention is captured when ownership is registered, even if the environment changes.
process.env.WORKBASE_KEEP_TMP = '0'
if (process.env.WORKBASE_TMP_PROBE_EXPLICIT === '1') {
  cleanupTempDir(directory); cleanupTempDir(directory)
  if (existsSync(directory)) throw new Error('explicit cleanup failed')
}
console.log(JSON.stringify({ directory }))
if (process.env.WORKBASE_TMP_PROBE_WAIT === '1') setInterval(() => {}, 1000)
