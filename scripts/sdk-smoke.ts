import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { usePreparedConsumerDependencies } from './lib/packed-consumer-dependencies'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const archive = readdirSync(join(root, 'dist-sdk')).find(name => /^workbasehq-core-.*\.tgz$/.test(name))
if (!archive) throw new Error('Pack core before running the core-only smoke')
const scratch = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-core-only-')))
try {
  const tarball = join(root, 'dist-sdk', archive)
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@workbasehq/core': `file:${tarball}` } }))
  if (!usePreparedConsumerDependencies(scratch, 'migration', { core: tarball })) execFileSync('bun', ['install'], { cwd: scratch, stdio: 'pipe' })
  const paths = Object.keys(manifest.exports).map(key => key === '.' ? '@workbasehq/core' : `@workbasehq/core${key.slice(1)}`)
  execFileSync('bun', ['--no-install', '--eval', `for (const path of ${JSON.stringify(paths)}) await import(path)`], { cwd: scratch, stdio: 'pipe' })
  console.log(`Core-only tarball smoke: ${paths.length}/${paths.length} exports imported; plugins absent`)
} finally { cleanupTempDir(scratch) }
