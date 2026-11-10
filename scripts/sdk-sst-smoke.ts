import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A real Pulumi monitor is essential here: constructor mocks and dry plans miss
// protobuf serialization failures caused by loading a second SDK into SST.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-sdk-sst-')))
const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', SST_TELEMETRY_DISABLED: '1' }
for (const key of Object.keys(env)) if (key.startsWith('CLOUDFLARE_') || key.startsWith('AWS_') || key.startsWith('SST_SECRET_')) delete env[key]
Object.assign(env, { CLOUDFLARE_API_TOKEN: 'synthetic-token', CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9/client/v4', baseUrl: 'http://127.0.0.1:9/client/v4' })
const run = (command: string, args: string[]) => {
  try { return execFileSync(command, args, { cwd: scratch, env, encoding: 'utf8', timeout: 240000, stdio: 'pipe' }) }
  catch (error) {
    const result = error as { stdout?: string; stderr?: string }
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n${existsSync(join(scratch, '.sst/log/pulumi.log')) ? readFileSync(join(scratch, '.sst/log/pulumi.log'), 'utf8') : ''}`)
  }
}
try {
  const dependencies: Record<string, string> = { sst: '4.17.1' }
  mkdirSync(join(scratch, 'archives'))
  for (const name of ['core', 'plugins', 'mcp']) {
    const archives = readdirSync(join(root, 'dist-sdk')).filter(file => file.startsWith(`workbasehq-${name}-`) && file.endsWith('.tgz'))
    assert.equal(archives.length, 1, `Pack exactly one ${name} tarball first`)
    // Bun caches local archives by path: reuse of dist-sdk/*-0.2.0.tgz can load
    // an earlier pack even with --force. Give every candidate a fresh identity.
    const archive = join(scratch, 'archives', archives[0])
    copyFileSync(join(root, 'dist-sdk', archives[0]), archive)
    dependencies[`@workbasehq/${name}`] = `file:${archive}`
  }
  // Inter-SDK deps (plugins -> core, mcp -> core/plugins) pin exact versions; without
  // overrides an unpublished version fails to resolve and a published one silently
  // pulls the npm copy instead of the candidate pack.
  const overrides = Object.fromEntries(Object.entries(dependencies).filter(([name]) => name.startsWith('@workbasehq/')))
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies, overrides }))
  run('bun', ['install'])
  // Only the three public packages and SST are direct dependencies. mcp supplies
  // the config/migration loader; consumers need no direct Pulumi/command install.
  for (const name of ['@pulumi/pulumi', '@pulumi/command']) assert.equal(existsSync(join(scratch, 'node_modules', name)), false)
  mkdirSync(join(scratch, 'migrations'))
  mkdirSync(join(scratch, 'local-migrations'))
  writeFileSync(join(scratch, 'migrations/0001_initial.sql'), 'CREATE TABLE records (id TEXT PRIMARY KEY);\n')
  writeFileSync(join(scratch, 'local-migrations/index.ts'), 'export const revision = 1\n')
  writeFileSync(join(scratch, 'config.ts'), `import { identity } from '@workbasehq/plugins/identity'
import { revision } from './local-migrations'
export default { id: 'packed', revision, interactive: false, roles: ['owner'], entities: {}, plugins: [identity] }
`)
  writeFileSync(join(scratch, 'worker.ts'), 'export default { fetch() { return new Response("packed") } }\n')
  writeFileSync(join(scratch, 'sst.config.ts'), `export default $config({
  app() { return { name: 'workbase-packed-runtime', home: 'local', providers: { cloudflare: '6.19.0' }, removal: 'remove' } },
  async run() {
    const { provision } = await import('@workbasehq/core/infra/provision')
    const { consoleAssetsDir } = await import('@workbasehq/plugins/console/assets')
    const result = await provision({ configPath: './config.ts', handler: './worker.ts', migrationsDir: './migrations',
      resourcePrefix: 'packed-runtime', stage: $app.stage, authSecret: $util.secret('synthetic-stable-auth-secret-at-least-32-characters'),
      authBaseUrl: 'https://packed.example.test', domain: 'packed.example.test', assetsDir: consoleAssetsDir(), email: { from: 'auth@example.test' } })
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const loaded = Object.keys(require.cache).filter(path => /[/]node_modules[/]@pulumi[/](pulumi|command)[/]/.test(path))
    if (!loaded.length || loaded.some(path => !path.startsWith($cli.paths.platform + '/'))) throw Error('consumer_pulumi_loaded')
    console.log('SST runtime isolation passed: all Pulumi/command modules belong to the platform')
    return { url: result.url, worker: result.workerName }
  },
})
`)
  const preview = (label: string) => {
    const output = run('bunx', ['--no-install', 'sst', 'diff', '--stage', 'console'])
    const log = readFileSync(join(scratch, '.sst/log/pulumi.log'), 'utf8')
    assert.match(log + output, /SST runtime isolation passed/)
    assert.doesNotMatch(log, /serialization failure|b\.Va is not a function|[ ]error:/)
    const resources = new Set([...log.matchAll(/^ \+\s+(\S+) (\S+) create/gm)].map(match => `${match[1]} ${match[2]}`))
    const expected: Record<string, number> = { 'pulumi:pulumi:Stack': 1, 'sst:cloudflare:D1': 1, 'cloudflare:index:D1Database': 1,
      'sst:cloudflare:Kv': 1, 'cloudflare:index:WorkersKvNamespace': 1, 'sst:cloudflare:Queue': 2, 'cloudflare:index:Queue': 2,
      'command:local:Command': 1, 'sst:cloudflare:Worker': 1, 'cloudflare:index:WorkersScript': 1,
      'cloudflare:index:WorkersCustomDomain': 1, 'cloudflare:index:QueueConsumer': 1, 'cloudflare:index:WorkersCronTrigger': 1,
      'pulumi-nodejs:dynamic:Resource': 2, 'sst:sst:LinkRef': 5 }
    for (const [type, count] of Object.entries(expected)) assert.equal([...resources].filter(resource => resource.startsWith(type + ' ')).length, count, `Missing ${type}\n${log}`)
    for (const name of ['WorkerZoneLookup.sst.cloudflare.ZoneLookup', 'WorkerUrl.sst.cloudflare.WorkerUrl']) assert.ok(log.includes(name))
    console.log(`Packed SST diff (${label}): passed; real engine, local state, dummy credentials`)
    console.log([...resources].sort().join('\n'))
    console.log(log.slice(log.indexOf('Resources:')).trim())
  }
  preview('three SDK packages + sst')
  // Reproduce the original consumer layout too: command 1.2.1 brings its own
  // Pulumi/protobuf copy. None of these consumer modules may enter SST's process.
  run('bun', ['add', '--dev', '@pulumi/command@1.2.1', '@pulumi/pulumi@3.215.0'])
  preview('conflicting consumer Pulumi/command installed')
} finally { cleanupTempDir(scratch) }
