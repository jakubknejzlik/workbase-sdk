import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import assert from 'node:assert/strict'
import { assertGeneratedMcpContent } from './lib/check-generated-mcp'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stageConsoleAssets } from './stage-console-assets'
import { stageConsolePackage } from './lib/stage-console-package'
import { readArchives, validateArchives } from './sdk-publish'

// Producer-only acceptance. Only packed artifacts enter the outside-checkout consumer.
const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--directory' || !args[1])) throw new Error('Usage: bun scripts/smoke-mcp-template.ts [--directory dist-sdk]')
const releaseDirectory = args.length ? resolve(args[1]) : undefined
const scratch = registerTempDir(realpathSync(mkdtempSync('/tmp/workbase-mcp-packed-')))
const consumer = join(scratch, 'instance')
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_cache: join(scratch, 'npm-cache'), npm_config_userconfig: join(scratch, 'npmrc'),
  CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'a'.repeat(32),
  WORKBASE_RESOURCE_PREFIX: 'neutral-smoke', AUTH_BASE_URL: 'https://neutral.example.test',
  EMAIL_FROM: 'login@example.test', BETTER_AUTH_SECRET: 'synthetic-stable-auth-secret-at-least-32-characters',
  WORKBASE_DOMAIN: 'neutral.example.test', WORKBASE_MCP_STATE_ROOT: join(scratch, 'mcp-state'), SST_TELEMETRY_DISABLED: '1',
}
const run = (cmd: string, args: string[], cwd = consumer) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 240000, stdio: 'pipe' })
const npm = (args: string[], cwd = consumer) => run('npm', [...args, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], cwd)
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const put = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')

try {
  assert(!realpathSync(scratch).startsWith(realpathSync(root) + '/'))
  if (!releaseDirectory) stageConsoleAssets(root)
  const archives: Record<string, string> = {}
  const versions = Object.fromEntries(['core', 'plugins', 'mcp'].map(name => [name, json(join(root, 'packages', name, 'package.json')).version]))
  assert.equal(versions.core, versions.mcp, 'Release versions must match')
  assert.equal(versions.plugins, versions.mcp, 'Release versions must match')
  if (releaseDirectory) {
    for (const { path, manifest } of validateArchives(readArchives(releaseDirectory), versions.mcp)) {
      const name = manifest.name.slice('@workbasehq/'.length)
      archives[name] = path
      console.log(`Release archive ${manifest.name}@${manifest.version} integrity=sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`)
    }
  } else for (const name of ['core', 'plugins', 'mcp'] as const) {
    const stage = join(scratch, `stage-${name}`)
    if (name !== 'mcp') stageConsolePackage(root, name, stage)
    else {
      mkdirSync(stage)
      const source = join(root, 'packages/mcp')
      for (const path of ['src', 'templates/standalone', 'NOTICE']) cpSync(join(source, path), join(stage, path), { recursive: true })
      cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
      const manifest = json(join(source, 'package.json'))
      delete manifest.devDependencies
      delete manifest.scripts
      for (const dependency of ['core', 'plugins']) manifest.dependencies[`@workbasehq/${dependency}`] = versions[dependency]
      put(join(stage, 'package.json'), manifest)
    }
    const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts'], stage))
    archives[name] = join(stage, packed.filename)
    console.log(`npm pack ${name}@${versions[name]} integrity=${packed.integrity}`)
  }
  const candidates = Object.fromEntries(Object.entries(archives).map(([name, archive]) => [`@workbasehq/${name}`, `file:${archive}`]))
  const bootstrap = join(scratch, 'bootstrap')
  mkdirSync(bootstrap)
  put(join(bootstrap, 'package.json'), { private: true, type: 'module', dependencies: candidates, overrides: candidates })
  npm(['install', '--ignore-scripts'], bootstrap)
  const checkCandidateResolution = (directory: string) => {
    const lock = json(join(directory, 'package-lock.json'))
    const resolvedPackages = new Set<string>()
    for (const [path, metadata] of Object.entries(lock.packages) as [string, { resolved?: string; integrity?: string }][]) {
      const name = /(?:^|\/)node_modules\/@workbasehq\/(core|plugins|mcp)$/.exec(path)?.[1]
      if (!name) continue
      const resolvedArchive = metadata.resolved
      assert(resolvedArchive && resolvedArchive.startsWith('file:'), `SDK dependency ${path} must resolve to a tarball`)
      assert.equal(realpathSync(resolve(directory, resolvedArchive.slice(5))), realpathSync(archives[name]), `SDK dependency ${path} must resolve to the candidate tarball`)
      assert.equal(metadata.integrity, 'sha512-' + createHash('sha512').update(readFileSync(archives[name])).digest('base64'), `SDK dependency ${path} must use candidate integrity`)
      resolvedPackages.add(name)
      console.log(`Candidate ${path}@${versions[name]} resolved=${metadata.resolved}`)
    }
    assert.deepEqual([...resolvedPackages].sort(), ['core', 'mcp', 'plugins'])
    console.log(`Candidate SDK resolution (${directory === bootstrap ? 'bootstrap' : 'consumer'}): all direct/transitive SDK packages use tarball paths and integrity`)
  }
  checkCandidateResolution(bootstrap)
  // Init uses the packed CLI, not a source import or monorepo executable.
  const report = JSON.parse(run('bun', [join(bootstrap, 'node_modules/.bin/workbase'), 'init', '--root', consumer, '--id', 'unfamiliar_neutral', '--target', 'cloudflare-github'], bootstrap))
  assert(report.ok && report.files.every((file: { status: string }) => file.status === 'created'))
  for (const path of ['sst.config.ts', 'deploy.env.example', 'scripts/typecheck.ts']) assert(report.files.some((file: { path: string }) => file.path === path), `Missing packaged template: ${path}`)
  const generatedFiles = files(consumer)
  for (const path of generatedFiles) assertGeneratedMcpContent(path, readFileSync(path, 'utf8'))
  const manifestPath = join(consumer, 'package.json')
  const generatedManifest = readFileSync(manifestPath, 'utf8')
  const manifest = json(manifestPath)
  assert.deepEqual(manifest.dependencies, Object.fromEntries(Object.entries(versions).map(([name, version]) => [`@workbasehq/${name}`, version])))
  console.log(`Generated registry SDK dependencies: ${JSON.stringify(manifest.dependencies)}`)
  assert.equal(manifest.devDependencies.typescript, '5.7.2')
  const config = readFileSync(join(consumer, 'config.ts'), 'utf8')
  for (const key of ['entities', 'permissions', 'policies']) assert(config.includes(`${key}: {}`))
  // Only the disposable install fixture maps all three exact versions to candidate bytes.
  manifest.dependencies = candidates
  manifest.overrides = candidates
  put(manifestPath, manifest)
  npm(['install', '--ignore-scripts'])
  const lockHash = digest(join(consumer, 'package-lock.json'))
  npm(['ci', '--ignore-scripts'])
  assert.equal(digest(join(consumer, 'package-lock.json')), lockHash, 'Frozen reinstallation must preserve lock bytes')
  checkCandidateResolution(consumer)
  const lock = json(join(consumer, 'package-lock.json'))
  for (const name of ['core', 'plugins', 'mcp']) {
    const installed = join(consumer, 'node_modules/@workbasehq', name)
    assert(!lstatSync(installed).isSymbolicLink())
    assert(realpathSync(installed).startsWith(realpathSync(consumer) + '/'))
    const metadata = lock.packages[`node_modules/@workbasehq/${name}`]
    assert.equal(metadata.integrity, 'sha512-' + createHash('sha512').update(readFileSync(archives[name])).digest('base64'), 'Every SDK package must use candidate integrity')
    assert.equal(json(join(installed, 'package.json')).version, versions[name])
  }
  for (const path of files(join(consumer, 'node_modules'))) assert(realpathSync(path).startsWith(realpathSync(consumer) + '/'), `Dependency escapes fixture: ${path}`)
  writeFileSync(manifestPath, generatedManifest)
  // sst install only installs pinned providers/generates types; no state/cloud operation.
  console.log(run('bun', ['run', 'node_modules/.bin/sst', 'install']).trim())
  console.log(run('bun', ['run', 'migrate:initial']).trim())
  // Run the installed migration binary with a local SQLite-backed HTTP adapter.
  // Only this child receives synthetic Cloudflare credentials; no remote request occurs.
  const migrationFixture = join(scratch, 'd1-fixture.mjs')
  writeFileSync(migrationFixture, `import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.WORKBASE_SMOKE_DATABASE)
globalThis.fetch = async (url, init) => {
  if (url !== 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/d1/database/' + 'b'.repeat(36) + '/query') throw Error('unexpected_url')
  if (init.headers.Authorization !== 'Bearer synthetic-offline-token') throw Error('unexpected_auth')
  const { sql } = JSON.parse(init.body)
  if (/^(SELECT|PRAGMA)/.test(sql)) return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all() }] })
  db.exec('BEGIN')
  try { db.exec(sql); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  return Response.json({ success: true, result: [{ success: true, results: [] }] })
}
`)
  const migrate = () => JSON.parse(execFileSync(join(consumer, 'node_modules/.bin/workbase-migrate'), ['migrate', 'b'.repeat(36), './migrations', '--config', './config.ts'], {
    cwd: consumer, encoding: 'utf8', timeout: 120000, stdio: 'pipe',
    env: { ...env, NODE_OPTIONS: '--import=' + migrationFixture, WORKBASE_SMOKE_DATABASE: join(scratch, 'd1.sqlite'), CLOUDFLARE_API_TOKEN: 'synthetic-offline-token' },
  }))
  const applied = migrate(), reapplied = migrate()
  assert.equal(applied.event, 'infra.migrations.applied')
  assert.equal(applied.applied, 1)
  assert.equal(reapplied.applied, 0)
  console.log(`Packaged workbase-migrate: ${JSON.stringify(applied)}; idempotent reapply=${JSON.stringify(reapplied)}`)
  console.log(run('bun', ['run', 'check:migrations']).trim())
  console.log(run('bun', ['run', 'typecheck']).trim() || 'Generated instance typecheck passed')
  mkdirSync(join(consumer, '.smoke'))
  writeFileSync(join(consumer, '.smoke/worker.mjs'), `import { build } from 'esbuild'
await build({ entryPoints: ['src/index.ts'], outfile: '.smoke/worker/index.mjs', platform: 'browser', format: 'esm', bundle: true, conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2022' })
console.log('Generated Worker bundled from installed SDK packages')
`)
  console.log(run('node', ['.smoke/worker.mjs']).trim())
  assert(lstatSync(join(consumer, '.smoke/worker/index.mjs')).isFile())
  // Exercise both MCP process boundaries using the installed client SDK.
  writeFileSync(join(consumer, '.smoke/mcp.ts'), `import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const require = createRequire(import.meta.resolve('@workbasehq/mcp'))
const bin = require.resolve('@workbasehq/mcp/stdio').replace('stdio.ts', 'bin.ts')
for (const mode of ['config', 'data']) {
  const client = new Client({ name: 'packed-smoke', version: '1' })
  const transport = new StdioClientTransport({ command: 'bun', args: [bin, mode, ...(mode === 'config' ? ['--root', process.cwd()] : [])], stderr: 'pipe', env: { ...process.env, WORKBASE_BASE_URL: 'http://127.0.0.1:9', WORKBASE_TOKEN: 'synthetic-offline-token', WORKBASE_ORG_ID: 'neutral', WORKBASE_READ_ONLY: 'true' } })
  transport.stderr?.on('data', () => {})
  try {
    await client.connect(transport)
    assert.equal(client.getServerVersion()?.version, ${JSON.stringify(versions.mcp)})
    assert((await client.listTools()).tools.length > 0)
    if (mode === 'config') {
      const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
        assert(!result.isError, JSON.stringify(result))
        assert(result.structuredContent?.ok, JSON.stringify(result))
        return result.structuredContent
      }
      const initial = await call('inspect_schema', { instance: 'unfamiliar-neutral' })
      assert.deepEqual(initial.entities, {})
      const { proposalId } = await call('propose_change', { instance: 'unfamiliar-neutral', baseRevision: initial.revision, changes: [{ kind: 'add_entity', entity: 'notes', fields: { title: { type: 'string', required: true } }, permissions: { owner: ['read', 'create', 'update', 'delete'], viewer: ['read'] }, policies: { owner: 'all', viewer: 'all' } }] })
      await call('validate', { proposalId })
      const preview = await call('preview_migration', { proposalId })
      assert(preview.sql.includes('notes'))
      const disposable = await call('apply_to_disposable', { proposalId })
      assert(disposable.verified, JSON.stringify(disposable))
      await call('promote', { proposalId, expectedRevision: initial.revision })
      const promoted = await call('inspect_schema', { instance: 'unfamiliar-neutral' })
      assert(promoted.entities.notes.fields.title.required)
      assert.deepEqual(promoted.permissions.viewer.notes, ['read'])
      assert.equal(promoted.policies.notes.owner, 'all')
    }
  } finally { await client.close(); await transport.close() }
}
console.log('Packed config/data MCP entrypoints passed')
`)
  // SDK is a direct MCP dependency, so resolve the acceptance client from its installation.
  const sdkPath = join(consumer, 'node_modules/@modelcontextprotocol/sdk')
  assert(lstatSync(sdkPath).isDirectory())
  const asset = join(consumer, 'node_modules/@workbasehq/plugins/console/assets/index.html')
  const assetHash = digest(asset)
  console.log(run('bun', ['.smoke/mcp.ts']).trim())
  // An empty new project alone cannot detect an upgrade that bricks old configs.
  // Only the installed candidate packages resolve from this historical fixture.
  cpSync(join(root, 'scripts/test/fixtures/sdk-0.2.1-revision-3'), join(consumer, '.upgrade'), { recursive: true })
  cpSync(join(root, 'scripts/lib/mcp-upgrade-check.ts'), join(consumer, '.smoke/mcp-upgrade-check.ts'))
  writeFileSync(join(consumer, '.smoke/upgrade.ts'), `import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { checkMcpUpgrade } from './mcp-upgrade-check.ts'
import { resolve } from 'node:path'
const require = createRequire(import.meta.resolve('@workbasehq/mcp'))
const bin = require.resolve('@workbasehq/mcp/stdio').replace('stdio.ts', 'bin.ts')
const root = resolve('.upgrade')
const client = new Client({ name: 'packed-upgrade-gate', version: '1' })
const transport = new StdioClientTransport({ command: 'bun', args: [bin, 'config', '--root', root], stderr: 'pipe', env: { ...process.env, WORKBASE_MCP_DEV_MODULE: '' } })
transport.stderr?.on('data', () => {})
try {
  await client.connect(transport)
  await checkMcpUpgrade(client, root)
} finally { await client.close(); await transport.close() }
`)
  console.log(run('bun', ['.smoke/upgrade.ts']).trim())
  assert.equal(digest(asset), assetHash, 'MCP entity changes must not rebuild packaged console assets')
  console.log(run('bun', ['run', 'check:migrations']).trim())
  console.log(run('bun', ['run', 'typecheck']).trim() || 'Promoted neutral entity typecheck passed')
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
import { consoleAssetsDir } from '@workbasehq/plugins/console/assets'
globalThis.$config = value => value
const { default: config } = await import('../.sst/platform/sst.config.smoke.mjs')
assert.equal(config.app({ stage: 'production' }).protect, true)
assert.equal(config.app({ stage: 'trial' }).removal, 'remove')
const assets = consoleAssetsDir()
const plan = await createProvisionPlan({ configPath: './config.ts', handler: './src/index.ts', migrationsDir: './migrations', resourcePrefix: process.env.WORKBASE_RESOURCE_PREFIX, stage: 'trial', authSecret: process.env.BETTER_AUTH_SECRET, authBaseUrl: process.env.AUTH_BASE_URL, domain: process.env.WORKBASE_DOMAIN, email: { from: process.env.EMAIL_FROM }, assetsDir: assets })
for (const binding of ['DB', 'AUDIT_KV', 'EVENTS_QUEUE', 'ASSETS', 'EMAIL', 'EMAIL_FROM', 'SCHEMA_EXPECTED']) assert(plan.bindingNames.includes(binding))
assert(assets.startsWith(process.cwd() + '/node_modules/@workbasehq/plugins/'))
assert(plan.migration.bin.startsWith(process.cwd() + '/node_modules/@workbasehq/core/'))
assert(plan.schema.pluginMigrations)
assert.equal(plan.schema.coreVersion, ${JSON.stringify(versions.core)})
assert((await import('node:fs')).existsSync(assets + '/index.html'))
console.log('consoleAssetsDir()=' + assets + '; index.html present; coreVersion=' + plan.schema.coreVersion)
console.log('Bundled SST config imported; packaged assets/migration tool and bindings verified offline')
`)
  console.log(run('node', ['--import', './node_modules/tsx/dist/esm/index.mjs', '.smoke/plan.ts']).trim())
  console.log(`MCP template packed smoke passed: init, isolated install/frozen reinstall, initial SQL, schema replay, typecheck, Worker/SST bundles, config/data MCP; SDK ${versions.mcp}; lock sha256=${lockHash}; no deploy`)
} catch (error) {
  if (error && typeof error === 'object' && 'stderr' in error) console.error(String(error.stderr))
  throw error
} finally {
  cleanupTempDir(scratch)
}
