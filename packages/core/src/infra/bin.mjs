#!/usr/bin/env node
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Resolve both the TypeScript loader and CLI relative to this installed package.
const require = createRequire(import.meta.url)
let loader
try { loader = require.resolve('tsx/esm') }
catch {
  console.error('workbase-migrate requires tsx; install tsx@4.23.15')
  process.exit(1)
}
const result = spawnSync(process.execPath, [
  '--import', pathToFileURL(loader).href,
  fileURLToPath(new URL('./cli-main.ts', import.meta.url)), ...process.argv.slice(2),
], { stdio: 'inherit' })
if (result.error) console.error('migration_failed')
process.exitCode = result.status ?? 1
