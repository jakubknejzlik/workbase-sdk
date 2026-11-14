import { registerTempDir, cleanupTempDir } from '../../../../scripts/lib/test-temp-dir.mjs'
import { usePreparedConsumerDependencies } from '../../../../scripts/lib/packed-consumer-dependencies'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('regression: packed config and plugin imports load inside an SST bundle with ts-node ESM hooks active', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const scratch = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-provision-loader-')))
  const consumer = join(scratch, 'consumer')
  mkdirSync(consumer)
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', TS_NODE_TRANSPILE_ONLY: 'true',
    TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'ESNext', moduleResolution: 'Bundler' }) }
  const npm = (args: string[], cwd: string) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
  try {
    const archives: Record<string, string> = {}
    for (const name of ['core', 'plugins']) {
      const source = join(root, 'packages', name), stage = join(scratch, name)
      mkdirSync(stage)
      if (name === 'core') cpSync(join(source, 'src'), join(stage, 'src'), { recursive: true })
      else for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && readdirSync(join(source, entry.name)).includes('src')) {
          cpSync(join(source, entry.name, 'src'), join(stage, entry.name, 'src'), { recursive: true })
        }
      }
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
      delete manifest.devDependencies
      delete manifest.scripts
      writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest))
      archives[name] = join(stage, JSON.parse(npm(['pack', '--ignore-scripts', '--json'], stage))[0].filename)
    }
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
      '@workbasehq/core': `file:${archives.core}`, '@workbasehq/plugins': `file:${archives.plugins}`,
      tsx: '4.23.15', 'ts-node': '10.9.2', typescript: '5.7.2', esbuild: '0.21.5',
    } }))
    if (!usePreparedConsumerDependencies(consumer, 'loader', archives)) {
      npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], consumer)
    }
    cpSync(join(root, 'packages/core/test/fixtures/worker-access'), join(consumer, 'openapi-instance'), { recursive: true })
    writeFileSync(join(consumer, 'openapi-runtime.ts'), `import config from './openapi-instance/config'
import { createApp } from '@workbasehq/core/app'
import { openApiRoutes } from '@workbasehq/core/openapi/routes'
if (typeof openApiRoutes !== 'function') throw Error('missing_openapi_route_export')
export default createApp(config, { DB: {} } as any)
`)
    writeFileSync(join(consumer, 'bundle-openapi.mjs'), `import { build } from 'esbuild'
await build({ entryPoints: ['openapi-runtime.ts'], outfile: 'openapi-runtime.mjs', bundle: true, platform: 'browser', format: 'esm', external: ['node:*'] })
`)
    execFileSync(process.execPath, ['bundle-openapi.mjs'], { cwd: consumer, env, stdio: 'pipe' })
    writeFileSync(join(consumer, 'verify-openapi.mjs'), `import app from './openapi-runtime.mjs'
import { readFileSync } from 'node:fs'
const response = await app.request('http://localhost/openapi.json')
if (response.status !== 200 || await response.text() !== readFileSync('openapi-instance/openapi.json', 'utf8')) throw Error('packed_openapi_roundtrip_failed')
console.log('Packed OpenAPI: browser bundle serves exact committed bytes anonymously')
`)
    const roundtrip = execFileSync(process.execPath, ['verify-openapi.mjs'], { cwd: consumer, env, encoding: 'utf8', stdio: 'pipe' })
    expect(roundtrip).toContain('browser bundle serves exact committed bytes anonymously')
    console.log(roundtrip.trim())
    mkdirSync(join(consumer, 'sql'))
    mkdirSync(join(consumer, 'local-migrations'))
    mkdirSync(join(consumer, '.sst/platform'), { recursive: true })
    writeFileSync(join(consumer, 'sql/0001_initial.sql'), 'CREATE TABLE records (id TEXT PRIMARY KEY);\n')
    writeFileSync(join(consumer, 'local-migrations/index.ts'), 'export const revision = 7\n')
    writeFileSync(join(consumer, 'worker.ts'), 'export default {}\n')
    writeFileSync(join(consumer, 'config.ts'), `import { identity } from '@workbasehq/plugins/identity'
import { revision } from './local-migrations'
console.log('config log must not corrupt the protocol')
export default { id: 'packed', revision, interactive: false, roles: ['owner'], entities: {}, plugins: [identity] }
`)
    // Prove the real resolver hook rejects directory imports, without mocking it.
    writeFileSync(join(consumer, 'probe.mjs'), `import { tsImport } from 'tsx/esm/api'
import { writeFileSync } from 'node:fs'
try {
  const config = (await tsImport('./config.ts', import.meta.url)).default
  const { expectedSchema } = await tsImport('@workbasehq/core/infra', import.meta.url)
  writeFileSync('expected-schema.json', JSON.stringify(await expectedSchema({ config, revision: config.revision, migrationsDirectory: './sql' })))
  console.log('plain config loaded')
}
catch (error) { console.error(error.message); process.exitCode = 1 }
`)
    const run = (args: string[], overrides = {}) => spawnSync(process.execPath, args, {
      cwd: consumer, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000,
    })
    const plain = run(['probe.mjs'])
    expect(plain.status, plain.stderr).toBe(0)
    const hooked = run(['--loader', 'ts-node/esm', 'probe.mjs'])
    expect(hooked.status).toBe(1)
    expect(hooked.stderr).toContain('ERR_UNSUPPORTED_DIR_IMPORT')
    console.log('Reproducer: plain tsImport succeeds; ts-node 10.9.2 ESM hook rejects a directory import with ERR_UNSUPPORTED_DIR_IMPORT')

    writeFileSync(join(consumer, 'plan.ts'), `import { createProvisionPlan } from '@workbasehq/core/infra/provision'
import { readFileSync } from 'node:fs'
const plan = await createProvisionPlan({ configPath: './config.ts', handler: './worker.ts', migrationsDir: './sql', resourcePrefix: 'packed', stage: 'console', authSecret: 'synthetic-stable-auth-secret-at-least-32-characters', authBaseUrl: 'https://packed.example.test' })
if (plan.schema.revision !== 7 || !plan.schema.pluginMigrations) throw Error('invalid_schema')
if (JSON.stringify(plan.schema) !== readFileSync('expected-schema.json', 'utf8')) throw Error('plugin_schema_changed')
console.log('packed config loaded with ts-node hooks active')
`)
    writeFileSync(join(consumer, 'bundle.mjs'), `import { build } from 'esbuild'
await build({ entryPoints: ['plan.ts'], outfile: '.sst/platform/plan.mjs', bundle: true, platform: 'node', format: 'esm', external: ['@pulumi/*'], banner: { js: "import { createRequire as bundleRequire } from 'node:module'; const require = bundleRequire(import.meta.url);" } })
`)
    execFileSync(process.execPath, ['bundle.mjs'], { cwd: consumer, env, stdio: 'pipe' })
    // NODE_OPTIONS also carries the loader: a child must clear inherited hooks.
    const result = run(['.sst/platform/plan.mjs'], { NODE_OPTIONS: '--loader ts-node/esm' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('packed config loaded with ts-node hooks active')
    expect(result.stdout).not.toContain('config log')
    console.log('Packed provision: schema prepared successfully inside SST bundle with inherited ts-node ESM loader; no cloud access')
  } finally { cleanupTempDir(scratch) }
}, 180000)
