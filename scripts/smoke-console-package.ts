import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { checkConsolePublic } from './check-console-public'
import { stageConsoleAssets } from './stage-console-assets'
import { stageConsolePackage } from './lib/stage-console-package'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync('/tmp/workbase-console-packed-')
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_cache: join(scratch, 'npm-cache'), npm_config_userconfig: join(scratch, 'npmrc') }
const npm = (args: string[], cwd: string) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 180000, stdio: 'pipe' })
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])

try {
  assert(!realpathSync(scratch).startsWith(realpathSync(root) + '/'), 'Consumer must be outside the checkout')
  stageConsoleAssets(root)
  const archives: Record<string, string> = {}
  for (const name of ['core', 'plugins'] as const) {
    const stage = join(scratch, `stage-${name}`)
    stageConsolePackage(root, name, stage)
    const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts'], stage))
    archives[name] = join(stage, packed.filename)
    const extracted = join(scratch, `packed-${name}`)
    mkdirSync(extracted)
    execFileSync('tar', ['-xzf', archives[name], '-C', extracted])
    const directory = join(extracted, 'package')
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    assert(!/workspace:|file:|link:/.test(JSON.stringify(manifest)), 'Packed manifests must be registry-safe')
    assert(!manifest.devDependencies && !manifest.scripts, 'Producer dependencies/hooks must not ship')
    assert(!Object.hasOwn(manifest, 'private'))
    assert.equal(manifest.publishConfig.access, 'public')
    for (const entry of packed.files) {
      assert(!/(?:frontend-console|console-generated|(?:^|\/)ui)(?:\/|$)|(?:^|\/)(?:node_modules|fixtures|test|tests|__tests__)(?:\/|$)|\.map$/.test(entry.path), `Producer content in tarball: ${entry.path}`)
    }
    for (const legal of ['LICENSE', 'NOTICE']) assert(readFileSync(join(directory, legal), 'utf8').length > 0)
    for (const target of Object.values(manifest.exports) as (string | { default: string; types: string })[]) {
      for (const path of typeof target === 'string' ? [target] : Object.values(target)) assert(lstatSync(join(directory, path)).isFile(), `Missing packed export: ${path}`)
    }
    if (name === 'plugins') {
      const assets = join(directory, 'console/assets')
      console.log('Packed bytes:', checkConsolePublic(assets))
      for (const path of files(join(root, 'packages/plugins/console/assets'))) {
        assert.equal(digest(join(assets, relative(join(root, 'packages/plugins/console/assets'), path))), digest(path), 'Packed assets must equal staged bytes')
      }
      assert.equal(manifest.exports['./console/assets'].default, './console/src/assets.mjs')
      assert.equal(manifest.exports['./console/assets'].types, './console/src/assets.d.mts')
      assert(readFileSync(join(directory, manifest.exports['./console/assets'].types), 'utf8').includes('consoleAssetsDir(): string'))
    }
    console.log(`npm pack ${manifest.name}@${manifest.version}: ${packed.files.length} files; integrity=${packed.integrity}`)
  }
  const consumer = join(scratch, 'consumer')
  mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    '@workbasehq/core': `file:${archives.core}`, '@workbasehq/plugins': `file:${archives.plugins}`,
  } }))
  npm(['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], consumer)
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'))
  for (const name of ['core', 'plugins']) {
    const installed = join(consumer, 'node_modules/@workbasehq', name)
    assert(!lstatSync(installed).isSymbolicLink())
    assert(realpathSync(installed).startsWith(realpathSync(consumer) + '/'))
    const metadata = lock.packages[`node_modules/@workbasehq/${name}`]
    assert(metadata.resolved.includes(`stage-${name}/`), 'Candidate bytes must not resolve from npm')
    assert(metadata.integrity, 'Lockfile must record candidate integrity')
  }
  for (const path of files(join(consumer, 'node_modules'))) {
    assert(realpathSync(path).startsWith(realpathSync(consumer) + '/'), `Dependency escapes consumer: ${path}`)
    if (path.endsWith('/package.json')) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      assert(!['@workbasehq/frontend-console', '@workbasehq/ui', '@workbasehq/console-generated', 'vite'].includes(manifest.name), `Build dependency installed: ${manifest.name}`)
    }
  }
  // This check is plain Node, with no TS loader or build tool in the consumer.
  const check = join(consumer, 'check.mjs')
  writeFileSync(check, `import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consoleAssetsDir } from '@workbasehq/plugins/console/assets'
const assets = consoleAssetsDir()
assert(isAbsolute(assets))
assert(realpathSync(assets).startsWith(realpathSync(process.cwd()) + '/node_modules/@workbasehq/plugins/'))
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.resolve('@workbasehq/plugins/console/assets'))), 'utf8'))
const meta = JSON.parse(readFileSync(join(assets, 'build-meta.json'), 'utf8'))
assert.equal(meta.version, manifest.version)
assert(!meta.primitivesProof)
const html = readFileSync(join(assets, 'index.html'), 'utf8')
const references = [...html.matchAll(/(?:src|href)=["']([^"']+\\.(?:js|css)(?:[?#][^"']*)?)["']/g)].map(match => match[1])
assert(references.some(path => path.endsWith('.js')))
assert(references.some(path => path.endsWith('.css')))
for (const path of references) assert(existsSync(resolve(assets, '.' + path)), 'Missing browser asset: ' + path)
for (const legal of ['LICENSE', 'NOTICE']) assert(readFileSync(join(assets, legal), 'utf8').length > 0)
for (const locale of ['en', 'cs']) assert(Object.keys(JSON.parse(readFileSync(join(assets, 'locales', locale + '.json'), 'utf8'))).length > 0)
assert.equal(createHash('sha256').update(readFileSync(join(assets, 'NOTICE'))).digest('hex'), 'ae8536f05792991f988c900ba25351606d0a8a8ad67ed511c31c18dac19a4a87')
console.log('Node consumer: resolver, HTML, JS/CSS, version and legal notices passed')
`)
  console.log(execFileSync('node', [check], { cwd: consumer, env, encoding: 'utf8' }).trim())
  // SST bundles deployment helpers into .sst/platform: prove resolution survives it.
  const bundled = join(consumer, '.sst/platform/check.mjs')
  mkdirSync(dirname(bundled), { recursive: true })
  execFileSync('bun', ['build', check, '--target=node', '--outfile', bundled], { cwd: consumer, env, stdio: 'pipe' })
  console.log('SST-style bundle:', execFileSync('node', [bundled], { cwd: consumer, env, encoding: 'utf8' }).trim())
  console.log(`Packed consumer smoke passed; isolated npm cache; only core/plugins requested; lockfile sha256=${digest(join(consumer, 'package-lock.json'))}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
