import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { isolateSmokeNetwork } from './lib/smoke-network'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Only archives enter this non-git consumer; all post-install commands run offline.
const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--directory' || !args[1])) throw new Error('Usage: bun scripts/smoke-template.ts [--directory dist-sdk]')
const directory = resolve(args[1] ?? join(root, 'dist-sdk'))
const rawScratch = registerTempDir(mkdtempSync('/tmp/workbase-mcp-packed-')), scratch = realpathSync(rawScratch)
const consumer = join(scratch, 'instance'), id = 'packed_template_smoke'
const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_cache: join(scratch, 'npm-cache'), npm_config_userconfig: join(scratch, 'npmrc'),
  CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_DEFAULT_ACCOUNT_ID: '0'.repeat(32),
  WORKBASE_RESOURCE_PREFIX: 'neutral-smoke', AUTH_BASE_URL: 'https://neutral.example.test',
  EMAIL_FROM: 'login@example.test', BETTER_AUTH_SECRET: 'synthetic-access-secret-at-least-32',
  WORKBASE_DOMAIN: 'neutral.example.test', SST_TELEMETRY_DISABLED: '1', WORKBASE_BUILD_SHA: '0'.repeat(40),
}
let offline = false
const guard = join(scratch, 'offline.mjs')
writeFileSync(guard, `import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'
const denied = () => { throw Error('Packed smoke forbids network after install') }
globalThis.fetch = denied
http.request = http.get = https.request = https.get = denied
net.connect = net.createConnection = tls.connect = denied
net.Socket.prototype.connect = denied
dgram.createSocket = dgram.Socket.prototype.connect = dgram.Socket.prototype.send = denied
syncBuiltinESMExports()
`)
const run = (cmd: string, args: string[], cwd = consumer, childEnv = env) => {
  const guardedArgs = cmd === 'bun' && offline ? ['--preload=' + guard, ...args] : args
  const [executable, isolatedArgs] = offline ? isolateSmokeNetwork(cmd, guardedArgs) : [cmd, guardedArgs]
  return execFileSync(executable, isolatedArgs, { cwd, env: childEnv, encoding: 'utf8', timeout: 240000, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 })
}
const npm = (args: string[], cwd = consumer) => run('npm', [...args, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], cwd)
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const put = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
type Report = { ok: true; files: { path: string; status: string }[] }

try {
  assert(!realpathSync(scratch).startsWith(realpathSync(root) + '/'))
  const archives: Record<string, string> = {}, versions: Record<string, string> = {}
  for (const name of ['core', 'plugins', 'mcp']) {
    const matches = readdirSync(directory).filter(file => file.startsWith(`workbasehq-${name}-`) && file.endsWith('.tgz'))
    assert.equal(matches.length, 1, `Expected one ${name} archive`)
    const archive = join(directory, matches[0])
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
    assert.equal(manifest.name, `@workbasehq/${name}`)
    versions[name] = manifest.version
    archives[name] = archive
  }
  assert.equal(versions.core, versions.plugins)
  assert.equal(versions.core, versions.mcp)
  const candidates = Object.fromEntries(Object.entries(archives).map(([name, archive]) => [`@workbasehq/${name}`, `file:${archive}`]))
  const bootstrap = join(scratch, 'bootstrap')
  mkdirSync(bootstrap)
  put(join(bootstrap, 'package.json'), { private: true, type: 'module', dependencies: candidates, overrides: candidates })
  npm(['install', '--ignore-scripts'], bootstrap)
  const init = (): Report => JSON.parse(run('bun', [join(bootstrap, 'node_modules/.bin/workbase'), 'init', '--root', consumer, '--id', id, '--target', 'cloudflare-github'], bootstrap))
  const report = init()
  assert(report.ok && report.files.every(file => file.status === 'created'))
  assert(!existsSync(join(consumer, '.git')))
  for (const path of files(consumer)) assert(!/\{\{(?:SDK_VERSION|INSTANCE_ID|INSTANCE_SELECTOR)\}\}/.test(readFileSync(path, 'utf8')), `Unresolved placeholder: ${path}`)
  const generated = ['schema.lock.json', 'migrations/0001_r1.sql', 'access.lock.json', 'access.lock.md', 'openapi.json']
  for (const path of generated) assert(!existsSync(join(consumer, path)), `Init must not copy generated ${path}`)
  console.log(`Step 1: packed init created ${report.files.length} files; no placeholders or generated artifacts`)

  const vendor = join(consumer, 'vendor/sdk')
  mkdirSync(vendor, { recursive: true })
  const localCandidates = Object.fromEntries(Object.entries(archives).map(([name, archive]) => {
    const filename = `workbasehq-${name}-${versions[name]}.tgz`
    cpSync(archive, join(vendor, filename))
    return [`@workbasehq/${name}`, `file:vendor/sdk/${filename}`]
  }))
  const manifestPath = join(consumer, 'package.json'), manifest = json(manifestPath)
  for (const name of ['core', 'plugins', 'mcp']) assert.equal(manifest.dependencies[`@workbasehq/${name}`], versions[name])
  assert(!manifest.overrides)
  assert(!/workspace:|link:/.test(JSON.stringify(manifest)))
  assert(!json(join(consumer, 'tsconfig.json')).compilerOptions.paths)
  Object.assign(manifest.dependencies, localCandidates)
  manifest.overrides = localCandidates
  put(manifestPath, manifest)
  npm(['install', '--ignore-scripts'])
  const lockHash = digest(join(consumer, 'package-lock.json'))
  npm(['ci', '--ignore-scripts'])
  assert.equal(digest(join(consumer, 'package-lock.json')), lockHash)
  const lock = json(join(consumer, 'package-lock.json'))
  for (const name of ['core', 'plugins', 'mcp']) {
    const paths = Object.keys(lock.packages).filter(path => path.endsWith(`node_modules/@workbasehq/${name}`))
    assert.deepEqual(paths, [`node_modules/@workbasehq/${name}`], `Single ${name} copy`)
    const installed = join(consumer, paths[0])
    assert(!lstatSync(installed).isSymbolicLink())
    const metadata = lock.packages[paths[0]]
    assert.equal(metadata.resolved, localCandidates[`@workbasehq/${name}`])
    assert.equal(metadata.integrity, 'sha512-' + createHash('sha512').update(readFileSync(archives[name])).digest('base64'))
    assert.equal(json(join(installed, 'package.json')).version, versions[name])
  }
  for (const path of files(join(consumer, 'node_modules'))) assert(realpathSync(path).startsWith(realpathSync(consumer) + '/'), `Dependency escapes consumer: ${path}`)
  console.log('Step 2: npm install + npm ci; identical lock, single SDK copies, candidate integrity, no directory symlinks')
  writeFileSync(join(consumer, 'bunfig.toml'), 'preload = [' + JSON.stringify(guard) + ']\n')
  offline = true
  env.NODE_OPTIONS = '--import=' + guard
  env.npm_config_offline = 'true'

  const generate = () => {
    console.log(run('bun', ['run', 'migrate:plan', '--init']).trim())
    console.log(run('bun', ['run', 'access:lock']).trim())
    console.log(run('bun', ['run', 'openapi:write']).trim())
  }
  generate()
  const artifacts = Object.fromEntries(generated.map(path => [path, readFileSync(join(consumer, path))]))
  // Regenerate the fresh-domain plan from identical inputs without introducing git.
  const { rmSync } = await import('node:fs')
  rmSync(join(consumer, 'schema.lock.json'))
  rmSync(join(consumer, 'migrations/0001_r1.sql'))
  generate()
  for (const path of generated) assert.deepEqual(readFileSync(join(consumer, path)), artifacts[path], `Nondeterministic ${path}`)
  // Lock formats deliberately contain no Instance id. Verify their schema/policy
  // against this runtime and bind its identity to the spec without changing bytes.
  assert.equal(json(join(consumer, 'openapi.json')).info.title, id)
  assert.equal(json(join(consumer, 'schema.lock.json')).revision, 1)
  assert.deepEqual(json(join(consumer, 'schema.lock.json')).tables.map((table: { name: string }) => table.name), ['worker'])
  assert(json(join(consumer, 'access.lock.json')).enforcementInputs.plugins.length > 0)
  console.log(run('bun', ['--eval', `import assert from 'node:assert/strict'; import config from './runtime'; import { loadConfig } from '@workbasehq/core/schema/load'; import spec from './openapi.json'; assert.equal(config.id, ${JSON.stringify(id)}); assert.equal(config.revision, 1); assert(config.interactive); const loaded = await loadConfig('./config.ts'); assert.equal(spec['x-workbase-config-hash'], loaded.configHash); console.log('Runtime identity, lock revision and OpenAPI configHash match')`]).trim())
  console.log(run('bun', ['--eval', `import assert from 'node:assert/strict'; import { createApp } from '@workbasehq/core/app'; import config from './runtime'; const app = createApp(config, { DB: { prepare() { throw Error('unexpected DB access') } }, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET, AUTH_BASE_URL: process.env.AUTH_BASE_URL }); const response = await app.request('https://neutral.example.test/schema'); assert.equal(response.status, 200); const schema = await response.json(); assert.equal(schema.instance, ${JSON.stringify(id)}); assert(schema.commands.some(command => command.name === 'worker/access_invite')); console.log('Packed runtime GET /schema: 200 + valid JSON with account-link commands')`]).trim())
  console.log('Step 3: schema → access → OpenAPI generated twice; all bytes match; identity verified via runtime/spec')
  console.log(run('bun', ['run', 'check']).trim())
  console.log(run('bun', ['run', 'typecheck']).trim())
  console.log(run('bun', ['run', 'build:console']).trim())
  assert.equal(json(join(consumer, 'dist/build-meta.json')).sha, '0'.repeat(40))
  const html = readFileSync(join(consumer, 'dist/index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  assert(scripts.length > 0 && scripts.every(([, attrs, body]) => /\bsrc=/.test(attrs) && !body.trim()), 'Console has only external scripts')
  console.log('Step 4: check + typecheck + console build; 40-zero build SHA; external scripts only')
  mkdirSync(join(consumer, '.smoke'))
  writeFileSync(join(consumer, '.smoke/worker.mjs'), `import { build } from 'esbuild'
await build({ entryPoints: ['src/index.ts'], outfile: '.smoke/worker/index.mjs', platform: 'browser', format: 'esm', bundle: true, conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2022' })
console.log('Generated Worker bundled from installed SDK packages')
`)
  console.log(run('node', ['.smoke/worker.mjs']).trim())
  assert(lstatSync(join(consumer, '.smoke/worker/index.mjs')).isFile())
  // The HTTP CLI requires UUID punctuation around the 32 all-zero hex digits.
  const database = '0'.repeat(32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
  const migrationFixture = join(scratch, 'd1-fixture.mjs')
  writeFileSync(migrationFixture, `import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.WORKBASE_SMOKE_DATABASE)
globalThis.fetch = async (url, init) => {
  if (url !== 'https://api.cloudflare.com/client/v4/accounts/' + '0'.repeat(32) + '/d1/database/' + ${JSON.stringify(database)} + '/query') throw Error('unexpected_url')
  if (init.headers.Authorization !== 'Bearer synthetic-access-secret-at-least-32') throw Error('unexpected_auth')
  const { sql } = JSON.parse(init.body)
  if (/^(SELECT|PRAGMA)/.test(sql)) return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all() }] })
  db.exec('BEGIN')
  try { db.exec(sql); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  return Response.json({ success: true, result: [{ success: true, results: [] }] })
}
`)
  const migrate = () => JSON.parse(run(join(consumer, 'node_modules/.bin/workbase-migrate'), ['migrate', database, './migrations', '--config', './runtime.ts'], consumer,
    { ...env, NODE_OPTIONS: env.NODE_OPTIONS + ' --import=' + migrationFixture, WORKBASE_SMOKE_DATABASE: join(scratch, 'd1.sqlite'), CLOUDFLARE_API_TOKEN: 'synthetic-access-secret-at-least-32' }))
  const applied = migrate(), reapplied = migrate()
  assert.equal(applied.event, 'infra.migrations.applied')
  assert.equal(applied.applied, 1)
  assert.equal(reapplied.applied, 0)
  console.log(`Packaged workbase-migrate: ${JSON.stringify(applied)}; idempotent reapply=${JSON.stringify(reapplied)}`)
  console.log(run('node', ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(join(scratch, 'd1.sqlite'))});
assert.equal(db.prepare('SELECT revision FROM instance_meta').get().revision, 1);
assert.equal(db.prepare('SELECT filename FROM _migrations').get().filename, '0001_r1.sql');
assert(db.prepare('SELECT COUNT(*) AS n FROM _plugin_migrations').get().n > 0);
assert(db.prepare("SELECT name FROM sqlite_master WHERE name='worker'").get());
console.log('SDK → plugins → 0001_r1.sql applied; revision and ledgers verified');`]).trim())
  console.log('Step 5: Worker bundle + SQLite-backed workbase-migrate; initial=1, repeated=0')
  writeFileSync(join(consumer, '.smoke/bundle.mjs'), `import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const globals = resolve('.smoke/globals.mjs')
await build({ entryPoints: ['sst.config.ts'], outfile: '.sst/platform/sst.config.smoke.mjs', platform: 'node', format: 'esm', bundle: true, external: ['@pulumi/*'], banner: { js: "import { createRequire as topLevelCreateRequire } from 'node:module'; const require = topLevelCreateRequire(import.meta.url);" }, plugins: [{ name: 'SstInjectGlobals', setup(builder) {
  builder.onLoad({ filter: /\\.(js|ts|jsx|tsx)$/ }, args => ({ contents: 'import { sst, cloudflare, $util } from ' + JSON.stringify(globals) + ';\\n' + readFileSync(args.path, 'utf8'), loader: args.path.endsWith('.ts') ? 'ts' : 'js' }))
} }] })
console.log('Generated SST config bundled with installed provisioner')
`)
  writeFileSync(join(consumer, '.smoke/globals.mjs'), 'export const sst = {}; export const cloudflare = {}; export const $util = {};\n')
  console.log(run('node', ['.smoke/bundle.mjs']).trim())
  // Import the actual bundled config. run() is never invoked (it registers resources).
  // Dry plan verifies installed tools/assets/schema without contacting Cloudflare.
  writeFileSync(join(consumer, '.smoke/plan.ts'), `import assert from 'node:assert/strict'
import { createProvisionPlan } from '@workbasehq/core/infra/provision'
globalThis.$config = value => value
const { default: config } = await import('../.sst/platform/sst.config.smoke.mjs')
assert.equal(config['app']({ stage: 'production' }).protect, true)
assert.equal(config['app']({ stage: 'trial' }).removal, 'remove')
const assets = process.cwd() + '/dist'
const plan = await createProvisionPlan({ configPath: './runtime.ts', handler: './src/index.ts', migrationsDir: './migrations', resourcePrefix: process.env.WORKBASE_RESOURCE_PREFIX, stage: 'trial', authSecret: process.env.BETTER_AUTH_SECRET, authBaseUrl: process.env.AUTH_BASE_URL, domain: process.env.WORKBASE_DOMAIN, email: { from: process.env.EMAIL_FROM }, assetsDir: assets })
for (const binding of ['DB', 'AUDIT_KV', 'EVENTS_QUEUE', 'ASSETS', 'EMAIL', 'EMAIL_FROM', 'SCHEMA_EXPECTED']) assert(plan.bindingNames.includes(binding))
assert.equal(plan.assetsDir, assets)
assert(plan.migration.bin.startsWith(process.cwd() + '/node_modules/@workbasehq/core/'))
assert(plan.schema.pluginMigrations)
assert.equal(plan.schema.coreVersion, ${JSON.stringify(versions.core)})
assert((await import('node:fs')).existsSync(assets + '/index.html'))
assert.equal(plan.schema.revision, 1)
console.log('Bundled SST config imported; packaged assets/migration tool and bindings verified offline')
`)
  console.log(run('node', ['--import', './node_modules/tsx/dist/esm/index.mjs', '.smoke/plan.ts']).trim())
  console.log('Step 6: SST bundle imported and createProvisionPlan verified offline; no resources registered')
  const edited = join(consumer, 'schema/worker.ts')
  writeFileSync(edited, readFileSync(edited, 'utf8') + '\n// Authored Instance bytes must survive init.\n')
  const preserved = Object.fromEntries(['package.json', 'schema/worker.ts', ...generated, 'package-lock.json'].map(path => [path, readFileSync(join(consumer, path))]))
  const second = init()
  assert(second.ok)
  assert.deepEqual(second.files, report.files.map(file => ({ path: file.path, status: ['package.json', 'schema/worker.ts'].includes(file.path) ? 'conflict' : 'unchanged' })))
  for (const [path, bytes] of Object.entries(preserved)) assert.deepEqual(readFileSync(join(consumer, path)), bytes, `Init changed ${path}`)
  console.log(`Step 7: second init: ${second.files.length - 2} unchanged, 2 documented conflicts; all edited/generated bytes intact`)
  // The data MCP starts and lists tools without loading or editing the V3 config.
  writeFileSync(join(consumer, '.smoke/data.ts'), `import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const client = new Client({ name: 'packed-data', version: '1' })
const transport = new StdioClientTransport({ command: 'bun', args: ['--preload=' + ${JSON.stringify(guard)}, 'node_modules/@workbasehq/mcp/src/bin.ts', 'data'], stderr: 'pipe', env: { ...process.env, WORKBASE_BASE_URL: 'http://127.0.0.1:9', WORKBASE_TOKEN: 'synthetic-access-secret-at-least-32', WORKBASE_ORG_ID: 'neutral', WORKBASE_READ_ONLY: 'true' } })
transport.stderr?.on('data', () => {})
try { await client.connect(transport); assert.equal(client.getServerVersion()?.version, ${JSON.stringify(versions.mcp)}); const tools = (await client.listTools()).tools; assert(tools.some(t => t.name === 'list_records')); console.log('Packed data MCP starts and lists tools with V3 files present') }
finally { await client.close(); await transport.close() }
`)
  console.log(run('bun', ['.smoke/data.ts']).trim())
  console.log(`V3 packed template smoke passed: 7/7 steps; SDK ${versions.mcp}; lock sha256=${lockHash}; post-install IP network blocked by OS isolation for commands and descendants; JS fetch/http/https/net/tls/dgram guarded; no deploy`)
} catch (error) {
  if (error && typeof error === 'object' && 'stderr' in error) console.error(String(error.stderr))
  throw error
} finally { cleanupTempDir(rawScratch) }
