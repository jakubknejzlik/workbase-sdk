import { registerTempDir, cleanupTempDir } from '../../../../scripts/lib/test-temp-dir.mjs'
import { usePreparedConsumerDependencies } from '../../../../scripts/lib/packed-consumer-dependencies'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'

it('regression: packed migration-only consumer typechecks before deployment peers; CLI, provision types and SST bundle still work', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const coreVersion = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version as string
  const scratch = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-migrate-packed-')))
  const consumer = join(scratch, 'consumer')
  mkdirSync(consumer)
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_cache: join(scratch, 'cache') }
  const npm = (args: string[], cwd: string) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
  try {
    expect(realpathSync(consumer).startsWith(realpathSync(root) + '/')).toBe(false)
    const archives: Record<string, string> = {}
    for (const name of ['core']) {
      const source = join(root, 'packages', name), stage = join(scratch, name)
      mkdirSync(stage)
      cpSync(join(source, 'src'), join(stage, 'src'), { recursive: true })
      for (const file of ['LICENSE', 'NOTICE']) cpSync(file === 'LICENSE' ? join(root, file) : join(source, file), join(stage, file))
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
      delete manifest.devDependencies
      writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest))
      const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], stage))[0]
      archives[name] = join(stage, packed.filename)
      expect(packed.files.some((file: { path: string }) => file.path === 'LICENSE')).toBe(true)
      for (const file of ['index.ts', 'cli.ts', 'cli-main.ts', 'diagnostics.ts', 'bin.mjs', 'd1-migrations.ts', 'http-d1.ts', 'instance-migrations.ts', 'migration-files.ts', 'schema.ts', 'provision.ts', 'provision-plan.ts', 'provision-config.ts', 'provision-config-main.mjs', 'provision-diagnostics.ts', 'package-tools.ts', 'sst-runtime.ts']) {
        expect(packed.files.some((entry: { path: string }) => entry.path === `src/infra/${file}`), file).toBe(true)
      }
      expect(packed.files.some((file: { path: string }) => /(^|\/)(test|fixtures)\//.test(file.path))).toBe(false)
    }
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
      '@workbasehq/core': `file:${archives.core}`, tsx: '4.23.15',
    }, devDependencies: {
      typescript: '5.7.2', '@types/node': '25.9.9', '@cloudflare/workers-types': '5.20261022.1',
    } }))
    if (!usePreparedConsumerDependencies(consumer, 'migration', archives)) {
      npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], consumer)
    }
    // Importing /infra and running migrations/dry plans must not require SST/Pulumi.
    for (const name of ['sst', '@pulumi/command', '@pulumi/pulumi']) expect(existsSync(join(consumer, 'node_modules', name))).toBe(false)
    const typecheck = (file: string) => execFileSync(process.execPath, ['./node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--skipLibCheck', '--target', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'bundler', '--types', 'node,@cloudflare/workers-types', '--lib', 'ES2023', file], { cwd: consumer, env, encoding: 'utf8', stdio: 'pipe' })
    writeFileSync(join(consumer, 'migration-only.ts'), `import { expectedSchema } from '@workbasehq/core/infra'
const schema: ReturnType<typeof expectedSchema> = expectedSchema({ migrationsDirectory: './migrations', revision: 1 })
void schema
`)
    typecheck('migration-only.ts')
    for (const name of ['sst', '@pulumi/command', '@pulumi/pulumi']) expect(existsSync(join(consumer, 'node_modules', name))).toBe(false)
    for (const name of ['@workbasehq/core', 'tsx']) {
      expect(realpathSync(join(consumer, 'node_modules', name)).startsWith(realpathSync(consumer) + '/')).toBe(true)
    }
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@workbasehq/core/package.json'), 'utf8'))
    expect(Object.keys(installed.dependencies).sort()).toEqual(['@jakub.knejzlik/ts-query', 'hono', 'typescript', 'zod'])
    expect(installed.peerDependencies).toEqual({ tsx: '4.23.15', sst: '4.17.1', '@pulumi/command': '1.2.1', '@pulumi/pulumi': '^3.215.0' })
    expect(installed.peerDependenciesMeta).toEqual({ tsx: { optional: true }, sst: { optional: true }, '@pulumi/command': { optional: true }, '@pulumi/pulumi': { optional: true } })
    expect(installed.exports['./infra']).toBe('./src/infra/index.ts')
    expect(installed.exports['./infra/provision']).toBe('./src/infra/provision.ts')
    expect(installed.exports['./schema']).toBe('./src/schema.ts')
    expect(installed.exports['./schema/load']).toBe('./src/schema/load.ts')
    expect(installed.bin).toEqual({ 'workbase-migrate': 'src/infra/bin.mjs' })
    expect(JSON.stringify(installed)).not.toMatch(/workspace:/)
    expect(JSON.stringify([installed.exports, installed.bin, installed.dependencies])).not.toContain('packages/core')
    // The canonical loader must resolve its compiler from installed SDK dependencies.
    mkdirSync(join(consumer, 'schema'))
    writeFileSync(join(consumer, 'schema.lock.json'), JSON.stringify({ lockVersion: 1, revision: 1, parent: null, tables: [] }))
    writeFileSync(join(consumer, 'schema/worker.ts'), `import { defineEntity, accountLink } from '@workbasehq/core/schema'
export default defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() }, displayField: 'name' })
`)
    writeFileSync(join(consumer, 'canonical-config.ts'), `import { defineConfig } from '@workbasehq/core/schema'
import worker from './schema/worker.ts'
export default defineConfig({ id: 'sample', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['cs', 'en'], entities: { worker } })
`)
    writeFileSync(join(consumer, 'canonical-check.ts'), `import { loadConfig } from '@workbasehq/core/schema/load'
const { config, sources } = await loadConfig('./canonical-config.ts')
console.log(JSON.stringify({ config, sources }))
`)
    const canonical = JSON.parse(execFileSync(process.execPath, ['--import', './node_modules/tsx/dist/esm/index.mjs', 'canonical-check.ts'], { cwd: consumer, env, encoding: 'utf8', stdio: 'pipe' }))
    expect(canonical.config.roles).toEqual(['admin', 'staff'])
    expect(canonical.config.languages).toEqual(['cs', 'en'])
    expect(canonical.config.entities.worker.fields.name).toEqual({ type: 'text', required: true })
    expect(canonical.config.entities.worker.fields.user).toMatchObject({ type: 'ref', entity: 'users', readOnly: true, userLink: true })
    expect(canonical.config.entities.worker.relations.user_account).toEqual({ field: 'user', entity: 'users' })
    expect(canonical.sources['entities.worker.fields.name'].file).toBe(realpathSync(join(consumer, 'schema/worker.ts')))

    const inputs = join(consumer, 'application inputs'), migrations = join(inputs, 'sql')
    mkdirSync(migrations, { recursive: true })
    const migration = join(migrations, '0001_initial.sql')
    writeFileSync(migration, `CREATE TABLE instance_meta (revision INTEGER,core_version TEXT); INSERT INTO instance_meta VALUES (1,'${coreVersion}'); CREATE TABLE records (id TEXT PRIMARY KEY);`)
    const configPath = join(inputs, 'config.ts')
    writeFileSync(configPath, `import { defineInstance } from '@workbasehq/core/config'
export default defineInstance({ id: 'neutral', revision: 1, interactive: false, roles: ['owner'], entities: {}, plugins: [
  { name: 'records', version: '1.0.0', migrations: [{ name: '001_index', sql: 'CREATE INDEX records_id ON records(id);' }] },
] })
`)
    // Exercise the real HTTP adapter and CLI in child processes, with a local SQLite
    // transaction for every HTTP request. No credentials or remote requests are used.
    const preload = join(scratch, 'http-fixture.mjs'), databaseFile = join(scratch, 'd1.sqlite')
    writeFileSync(preload, `import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.WB_TEST_DATABASE)
globalThis.fetch = async (url, init) => {
  if (url !== 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/d1/database/' + 'b'.repeat(36) + '/query') throw Error('unexpected_url')
  if (init.headers.Authorization !== 'Bearer synthetic-token') throw Error('unexpected_auth')
  const { sql } = JSON.parse(init.body)
  if (/^(SELECT|PRAGMA)/.test(sql)) return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all() }] })
  db.exec('BEGIN')
  try { db.exec(sql); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  return Response.json({ success: true, result: [{ success: true, results: [] }] })
}
`)
    const cliEnv = { ...env, NODE_OPTIONS: `--import=${preload}`, WB_TEST_DATABASE: databaseFile,
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-token' }
    const cwd = join(consumer, 'unrelated-cwd'); mkdirSync(cwd)
    const cliWithEnv = (overrides: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(join(consumer, 'node_modules/.bin/workbase-migrate'), ['migrate', 'b'.repeat(36), migrations, ...args], {
      cwd, env: { ...cliEnv, ...overrides }, encoding: 'utf8', timeout: 30000,
    })
    const cli = (...args: string[]) => cliWithEnv({}, ...args)
    const run = () => cli('--config', configPath)
    // Worker consumers can omit the optional loader; CLI consumers get an actionable error.
    const loader = join(consumer, 'node_modules/tsx')
    renameSync(loader, loader + '.hidden')
    try {
      const missingLoader = run()
      expect(missingLoader.status).toBe(1)
      expect(missingLoader.stderr).toContain('workbase-migrate requires tsx; install tsx@4.23.15')
    } finally { renameSync(loader + '.hidden', loader) }
    // An explicitly selected, invalid module must never fall back to SQL-only mode.
    const invalidConfig = join(inputs, 'invalid.ts')
    writeFileSync(invalidConfig, 'export const config = {}\n')
    const invalid = cli('--config', invalidConfig)
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('invalid_config_default_export')
    // Accepted prefixes never make arbitrary config/transport messages safe.
    const secret = 'synthetic-credential-must-never-reach-output'
    const throwingConfig = join(inputs, 'throwing.ts')
    writeFileSync(throwingConfig, `throw new Error('invalid_credentials: ' + process.env.CLOUDFLARE_API_TOKEN)`)
    const configFailure = cliWithEnv({ CLOUDFLARE_API_TOKEN: secret }, '--config', throwingConfig)
    expect(configFailure).toMatchObject({ status: 1, stdout: '' })
    expect(configFailure.stderr).toContain('migration_failed:Error')
    expect(configFailure.stderr).not.toContain(secret)
    expect(configFailure.stderr).not.toContain('invalid_credentials')
    const failingPlugin = join(inputs, 'failing-plugin.ts')
    writeFileSync(failingPlugin, `import config from './config.ts'
export default { ...config, plugins: [...config.plugins, { name: 'failing', version: '1.0.0', configSchema: {
  parse() { throw new Error('migration_plugin: ' + process.env.CLOUDFLARE_API_TOKEN) },
} }] }`)
    const pluginFailure = cliWithEnv({ CLOUDFLARE_API_TOKEN: secret }, '--config', failingPlugin)
    expect(pluginFailure).toMatchObject({ status: 1, stdout: '' })
    expect(pluginFailure.stderr).toContain('migration_failed:Error')
    expect(pluginFailure.stderr).not.toContain(secret)
    expect(pluginFailure.stderr).not.toContain('migration_plugin')
    const failingTransport = join(scratch, 'failing-transport.mjs')
    writeFileSync(failingTransport, `globalThis.fetch = async () => { throw new TypeError('d1_transport: ' + process.env.CLOUDFLARE_API_TOKEN) }`)
    const transportFailure = cliWithEnv({ CLOUDFLARE_API_TOKEN: secret, NODE_OPTIONS: `--import=${failingTransport}` })
    expect(transportFailure).toMatchObject({ status: 1, stdout: '' })
    expect(transportFailure.stderr).toContain('migration_failed:TypeError')
    expect(transportFailure.stderr).not.toContain(secret)
    expect(transportFailure.stderr).not.toContain('d1_transport')
    // A valid, branded filename detail still cannot disclose an environment secret.
    const redactionDirectory = join(inputs, 'redaction-sql')
    mkdirSync(redactionDirectory)
    writeFileSync(join(redactionDirectory, `0002_${secret}.sql`), 'SELECT 1;')
    const redacted = spawnSync(join(consumer, 'node_modules/.bin/workbase-migrate'), ['migrate', 'b'.repeat(36), redactionDirectory], {
      cwd, env: { ...cliEnv, CLOUDFLARE_API_TOKEN: secret }, encoding: 'utf8', timeout: 30000,
    })
    expect(redacted).toMatchObject({ status: 1, stdout: '' })
    expect(redacted.stderr).toContain('migration_sequence_gap_or_duplicate:0002_[redacted].sql')
    expect(redacted.stderr).not.toContain(secret)
    const fresh = run()
    expect(fresh.status, fresh.stderr).toBe(0)
    expect(JSON.parse(fresh.stdout)).toMatchObject({ event: 'infra.migrations.applied', applied: 1, total: 1, pluginMigrations: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const db = new DatabaseSync(databaseFile)
    try {
      db.exec("INSERT INTO records VALUES ('retained')")
      const receipts = db.prepare('SELECT * FROM _migrations').all()
      const reapply = run()
      expect(reapply.status, reapply.stderr).toBe(0)
      expect(JSON.parse(reapply.stdout).applied).toBe(0)
      expect(db.prepare('SELECT * FROM _migrations').all()).toEqual(receipts)
      expect(db.prepare('SELECT * FROM records').all()).toEqual([{ id: 'retained' }])
      const original = readFileSync(migration, 'utf8')
      writeFileSync(migration, original + "INSERT INTO records VALUES ('tampered');")
      const tampered = run()
      expect(tampered.status).toBe(1)
      expect(tampered.stderr).toContain('migration_history_mismatch:0001_initial.sql')
      expect(db.prepare('SELECT * FROM records').all()).toEqual([{ id: 'retained' }])
      writeFileSync(migration, original)
      const receipt = db.prepare("SELECT checksum FROM _plugin_migrations WHERE namespace='records'").get()!
      db.exec("UPDATE _plugin_migrations SET checksum='tampered' WHERE namespace='records'")
      const pluginMismatch = run()
      expect(pluginMismatch).toMatchObject({ status: 1, stdout: '' })
      expect(pluginMismatch.stderr).toContain('migration_failed')
      // Generic SQL-only invocation does not load an application or plugin registry.
      expect(cli().status).toBe(0)
      const redactedSuccess = cliWithEnv({ GITHUB_TOKEN: 'b'.repeat(36) })
      expect(redactedSuccess.status, redactedSuccess.stderr).toBe(0)
      expect(redactedSuccess.stdout).not.toContain('b'.repeat(36))
      expect(JSON.parse(redactedSuccess.stdout).database).toBe('[redacted]')
      db.prepare("UPDATE _plugin_migrations SET checksum=? WHERE namespace='records'").run(receipt.checksum!)
      expect(run().status).toBe(0)
    } finally { db.close() }
    // Import the infra subpath from installed candidate bytes, including schema calculation.
    writeFileSync(join(consumer, 'worker.ts'), 'export default { fetch() { return new Response("ok") } }\n')
    writeFileSync(join(consumer, 'check.ts'), `import { expectedSchema, migrateD1, httpD1Query, migrateInstance, readMigrationFiles, runCli } from '@workbasehq/core/infra'
import { provision, createProvisionPlan, type ProvisionOptions, type ProvisionResult } from '@workbasehq/core/infra/provision'
import type { Output } from '@pulumi/pulumi'
import config from './application inputs/config'
for (const helper of [migrateD1, httpD1Query, migrateInstance, readMigrationFiles, runCli, provision, createProvisionPlan]) if (typeof helper !== 'function') throw Error('missing_infra_export')
const schema = await expectedSchema({ migrationsDirectory: './application inputs/sql', revision: 1, config })
if (!schema.pluginMigrations || schema.coreVersion !== ${JSON.stringify(coreVersion)}) throw Error('invalid_schema')
const options: ProvisionOptions = { configPath: './application inputs/config.ts', handler: './worker.ts', migrationsDir: './application inputs/sql', resourcePrefix: 'neutral-instance', stage: 'preview', authSecret: 'synthetic-stable-auth-secret-at-least-32-characters', authBaseUrl: 'https://neutral.example.test' }
// Typecheck a real consumer call without registering resources or deploying.
async function deploy(): Promise<ProvisionResult> {
  const result = await provision(options)
  const url: Output<string | undefined> = result.url
  void url
  return result
}
void deploy
const plan = await createProvisionPlan(options)
if (plan.bindingNames.includes('ASSETS') || !plan.bindingNames.includes('DB') || !plan.bindingNames.includes('BETTER_AUTH_SECRET')) throw Error('invalid_bindings')
if (!plan.names.events.startsWith('neutral-instance-preview-') || plan.names.events.length > 63) throw Error('invalid_names')
if (!plan.migration.bin.startsWith(process.cwd() + '/node_modules/@workbasehq/core/')) throw Error('tool_outside_consumer')
if (JSON.stringify(plan).includes(String(options.authSecret))) throw Error('secret_in_plan')
console.log('packed exports and expected schema passed')
console.log('packed provision dry mapping passed')
`)
    const check = execFileSync(process.execPath, ['--import', './node_modules/tsx/dist/esm/index.mjs', 'check.ts'], { cwd: consumer, env, encoding: 'utf8' })
    expect(check).toContain('packed exports and expected schema passed')
    expect(check).toContain('packed provision dry mapping passed')

    // Execute the exact command emitted by provision(), using the existing HTTP
    // fixture. Spaces in config/migration paths must survive shell invocation.
    writeFileSync(join(consumer, 'command.ts'), `import { spawnSync } from 'node:child_process'
import { createProvisionPlan } from '@workbasehq/core/infra/provision'
const plan = await createProvisionPlan({ configPath: './application inputs/config.ts', handler: './worker.ts', migrationsDir: './application inputs/sql', resourcePrefix: 'neutral-instance', stage: 'preview', authSecret: 'synthetic-stable-auth-secret-at-least-32-characters', authBaseUrl: 'https://neutral.example.test' })
const run = spawnSync('/bin/sh', ['-c', plan.migration.command], { cwd: plan.root, encoding: 'utf8', env: { ...process.env, WB_NODE_BINARY: process.execPath, WB_MIGRATION_BIN: plan.migration.bin, WB_DATABASE_ID: 'b'.repeat(36), WB_MIGRATIONS_DIRECTORY: plan.migrationsDir, WB_CONFIG_MODULE: plan.configPath } })
if (run.status !== 0) throw Error(run.stderr)
if (JSON.parse(run.stdout).applied !== 0) throw Error('not_idempotent')
console.log('packed provision migration command passed')
`)
    const emittedCommand = execFileSync(process.execPath, ['--import', './node_modules/tsx/dist/esm/index.mjs', 'command.ts'], { cwd: consumer, env: cliEnv, encoding: 'utf8', stdio: 'pipe' })
    expect(emittedCommand).toContain('packed provision migration command passed')

    if (!usePreparedConsumerDependencies(consumer, 'deployment', archives)) {
      npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--save-dev',
        'sst@4.17.1', '@pulumi/command@1.2.1', '@pulumi/pulumi@3.215.0', 'esbuild@0.21.5'], consumer)
    }
    typecheck('check.ts')
    for (const name of ['sst', '@pulumi/command', '@pulumi/pulumi', 'typescript', 'esbuild']) expect(realpathSync(join(consumer, 'node_modules', name)).startsWith(realpathSync(consumer) + '/')).toBe(true)

    // SST injects lexical globals into dependencies and bundles the program under
    // .sst/platform. Exercise the same layout without SST init/preview/cloud APIs.
    // Regression: a bundled CLI self-entry check used to execute on library import;
    // bundled tsx would also resolve its own loader files relative to the SST bundle.
    const platform = join(consumer, '.sst/platform'); mkdirSync(platform, { recursive: true })
    writeFileSync(join(platform, 'globals.mjs'), 'export const sst = {}; export const cloudflare = {}; export const $util = {};\n')
    writeFileSync(join(consumer, 'bundle.mjs'), `import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const globals = resolve('.sst/platform/globals.mjs')
const result = await build({ entryPoints: ['check.ts'], outfile: '.sst/platform/sst.config.test.mjs', platform: 'node', format: 'esm', bundle: true, metafile: true, external: ['@pulumi/*'], banner: { js: "import { createRequire as topLevelCreateRequire } from 'node:module'; const require = topLevelCreateRequire(import.meta.url);" }, plugins: [{ name: 'SstInjectGlobals', setup(builder) {
  builder.onLoad({ filter: /\\.(js|ts|jsx|tsx)$/ }, args => ({ contents: 'import { sst, cloudflare, $util } from ' + JSON.stringify(globals) + ';\\n' + readFileSync(args.path, 'utf8'), loader: args.path.endsWith('.ts') ? 'ts' : 'js' }))
} }] })
if (Object.keys(result.metafile.inputs).some(path => /node_modules\\/tsx\\//.test(path))) throw Error('loader_was_bundled')
console.log('SST-style consumer bundle built; loader external')
`)
    const bundle = execFileSync(process.execPath, ['bundle.mjs'], { cwd: consumer, env, encoding: 'utf8', stdio: 'pipe' })
    expect(bundle).toContain('SST-style consumer bundle built; loader external')
    const bundledCheck = spawnSync(process.execPath, ['.sst/platform/sst.config.test.mjs'], { cwd: consumer, env, encoding: 'utf8', timeout: 30000 })
    expect(bundledCheck.status, bundledCheck.stderr).toBe(0)
    expect(bundledCheck.stdout).toContain('packed provision dry mapping passed')
    expect(bundledCheck.stderr).not.toContain('usage: workbase-migrate')
    console.log('Packed core CLI: fresh=1; reapply=0; tampered SQL/plugin rejected; SQL-only passed; infra exports imported; optional loader checked; config/plugin/transport credentials hidden; branded details redacted; all dependencies inside temp consumer')
    console.log('Packed core provision: migration-only consumer typechecked before installing deployment peers; no SST/Pulumi needed for import/dry plan; emitted migration command passed; consumer provision() call typechecked; SST-style bundle executed with package-resolved tools; no cloud access')
  } finally { cleanupTempDir(scratch) }
}, 180000)
