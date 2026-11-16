import { cleanupTempDir, registerTempDir } from '../../../../scripts/lib/test-temp-dir.mjs'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { output, secret } from '@pulumi/pulumi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { provision, type ProvisionOptions } from '../../src/infra/provision'
import { CORE_VERSION } from '../../src/config'

type Options = { dependsOn?: object[] }
type Action = { resource: object; opts: Options; run: () => Promise<void> }
type Capture = { resource: object; args: any; opts: Options; native?: { args: any; opts: Options } }
const captured = vi.hoisted(() => ({ commands: [] as Capture[], workers: [] as Capture[] }))
vi.mock('../../src/infra/sst-runtime', () => ({ sstCommand: () => ({ local: { Command: class {
  constructor(_name: string, args: any, opts: Options) { captured.commands.push({ resource: this, args, opts }) }
} } }) }))

// This deliberately small scheduler tests the emitted dependency contract, not
// Pulumi engine semantics, dependency inheritance, or provider lifecycle selection.
async function drain(actions: Action[]) {
  const states = new Map<object, 'succeeded' | 'failed' | 'blocked'>()
  const errors = new Map<object, unknown>()
  const pending = new Set(actions)
  while (pending.size) {
    // Snapshot ready work before executing it: an unfenced upload must run even
    // when the migration happens to be registered/executed first and fails.
    const ready = [...pending].filter(action => (action.opts.dependsOn ?? []).every(dep => states.has(dep)))
    if (!ready.length) throw Error('unresolved_dependency_or_cycle')
    await Promise.all(ready.map(async action => {
      pending.delete(action)
      if ((action.opts.dependsOn ?? []).some(dep => states.get(dep) !== 'succeeded')) {
        states.set(action.resource, 'blocked')
        return
      }
      try { await action.run(); states.set(action.resource, 'succeeded') }
      catch (error) { errors.set(action.resource, error); states.set(action.resource, 'failed') }
    }))
  }
  return { states, errors }
}

let root: string | undefined
const actions: Action[] = []
const noop = async () => {}
function mockResources() {
  const register = (resource: object, opts: Options = {}) => actions.push({ resource, opts, run: noop })
  class D1 {
    databaseId = output('b'.repeat(36)); nodes = { database: {} }
    constructor(_name: string, args: any, opts: Options) {
      const native = { args: {}, opts: {} }; args.transform.database(native.args, native.opts)
      register(this, opts); register(this.nodes.database, native.opts)
    }
  }
  class Kv {
    namespaceId = output('kv-id')
    constructor() { register(this) }
  }
  class Queue {
    id = output('queue-id'); nodes: any
    constructor(_name: string, args: any, opts: Options) {
      const native: any = { args: {}, opts: {} }; args.transform.queue(native.args, native.opts)
      this.nodes = { queue: { queueName: output(native.args.queueName) } }
      register(this, opts)
    }
  }
  class Worker {
    url = output('https://neutral.example.test'); nodes: any
    constructor(_name: string, args: any, opts: Options) {
      const native = { args: { bindings: output([]) }, opts: {} }
      args.transform.worker(native.args, native.opts)
      this.nodes = { worker: { scriptName: output((native.args as any).scriptName) } }
      captured.workers.push({ resource: this, args, opts, native })
    }
  }
  class Dependent {
    constructor(_name: string, _args: any, opts: Options) { register(this, opts) }
  }
  vi.stubGlobal('sst', { cloudflare: { D1, Kv, Queue, Worker } })
  vi.stubGlobal('cloudflare', { QueueConsumer: Dependent, WorkersCronTrigger: Dependent })
  vi.stubGlobal('$util', { output, secret })
  vi.stubGlobal('$cli', { paths: { platform: '/fixture/.sst/platform' } })
}

afterEach(() => {
  captured.commands.length = 0; captured.workers.length = 0; actions.length = 0
  vi.unstubAllGlobals()
  if (root) cleanupTempDir(root)
  root = undefined
})

// Same local SQLite/fetch-preload pattern as packed-cli.test.ts. The preload
// never calls the original fetch; unexpected requests are recorded and rejected.
function fixture() {
  root = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-provision-order-')))
  const inputs = join(root, 'application inputs'), sql = join(inputs, 'sql')
  mkdirSync(sql, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(inputs, 'config.ts'), `export default { id: 'neutral', revision: 1, interactive: false, roles: ['owner'], entities: {}, plugins: [] }`)
  writeFileSync(join(root, 'worker.ts'), 'export default { fetch() { return new Response("ok") } }')
  const initial = `CREATE TABLE instance_meta (revision INTEGER, core_version TEXT); INSERT INTO instance_meta VALUES (1,'${CORE_VERSION}'); CREATE TABLE records (id TEXT PRIMARY KEY);`
  writeFileSync(join(sql, '0001_initial.sql'), initial)
  const database = join(root, 'd1.sqlite'), requests = join(root, 'requests.jsonl'), configLoads = join(root, 'config-loads.txt')
  // A durable marker proves the CLI loaded this config, independently of planning.
  appendFileSync(join(inputs, 'config.ts'), `\nimport { appendFileSync } from 'node:fs'\nif (process.env.WB_TEST_CONFIG_LOADS) appendFileSync(process.env.WB_TEST_CONFIG_LOADS, 'loaded\\n')\n`)
  writeFileSync(requests, '')
  const preload = join(root, 'fetch-preload.mjs')
  writeFileSync(preload, `import { DatabaseSync } from 'node:sqlite'
import { appendFileSync } from 'node:fs'
const db = new DatabaseSync(process.env.WB_TEST_DATABASE)
globalThis.fetch = async (url, init) => {
  const allowed = url === 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/d1/database/' + 'b'.repeat(36) + '/query'
    && init?.method === 'POST' && init.headers.Authorization === 'Bearer synthetic-token'
  if (!allowed) { appendFileSync(process.env.WB_TEST_REQUESTS, JSON.stringify({ unexpected: true }) + '\\n'); throw Error('unexpected_request') }
  const { sql } = JSON.parse(init.body)
  appendFileSync(process.env.WB_TEST_REQUESTS, JSON.stringify({ sql }) + '\\n')
  if (/^(SELECT|PRAGMA)/.test(sql)) return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all() }] })
  db.exec('BEGIN')
  try { db.exec(sql); db.exec('COMMIT') }
  catch (error) { db.exec('ROLLBACK'); appendFileSync(process.env.WB_TEST_REQUESTS, JSON.stringify({ failedSQL: sql }) + '\\n'); throw error }
  return Response.json({ success: true, result: [{ success: true, results: [] }] })
}
`)
  const options: ProvisionOptions = { projectRoot: root, configPath: 'application inputs/config.ts', handler: 'worker.ts', migrationsDir: 'application inputs/sql',
    resourcePrefix: 'neutral', stage: 'preview', accountId: 'a'.repeat(32), authSecret: 'synthetic-auth-secret-at-least-32-characters', authBaseUrl: 'https://neutral.example.test' }
  const execute = async (command: Capture, operation: 'create' | 'update') => {
    const environment = await (output(command.args.environment) as unknown as { promise(): Promise<Record<string, string>> }).promise()
    return spawnSync('/bin/sh', ['-c', command.args[operation]], {
      cwd: command.args.dir, encoding: 'utf8', timeout: 30000,
      env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, NODE_PATH: '',
        NODE_OPTIONS: `--import=${JSON.stringify(preload)}`, CLOUDFLARE_API_TOKEN: 'synthetic-token',
        WB_TEST_DATABASE: database, WB_TEST_REQUESTS: requests, WB_TEST_CONFIG_LOADS: configLoads, ...environment },
    })
  }
  return { sql, initial, database, requests, configLoads, options, execute }
}

for (const fence of ['component', 'native'] as const) describe(`${fence} fence independently`, () => {
  it.each([
    ['create', false], ['create', true], ['update', false], ['update', true],
  ] as const)('%s migration success=%s gates a deferred native upload', async (operation, succeeds) => {
    const f = fixture()
    mockResources()
    if (operation === 'update') {
      await provision(f.options)
      const baseline = await f.execute(captured.commands[0], 'create')
      expect(baseline.error).toBeUndefined(); expect(baseline.signal).toBeNull()
      expect(baseline.status, baseline.stderr).toBe(0)
      expect(JSON.parse(baseline.stdout)).toMatchObject({ applied: 1, total: 1 })
      captured.commands.length = 0; captured.workers.length = 0; actions.length = 0
      writeFileSync(f.requests, '')
    }
    const pending = succeeds ? "INSERT INTO records VALUES ('pending');" : 'THIS IS INVALID SQL;'
    const migration = join(f.sql, operation === 'update' ? '0002_pending.sql' : '0001_initial.sql')
    if (operation === 'update') writeFileSync(migration, pending)
    else appendFileSync(migration, pending)
    await provision(f.options)
    const command = captured.commands[0], worker = captured.workers[0]
    expect(captured.commands).toHaveLength(1); expect(captured.workers).toHaveLength(1)
    const events: string[] = []
    let uploads = 0, independent = 0
    let result: Awaited<ReturnType<typeof f.execute>> | undefined
    // Constructors register resources only; upload attempts exist solely as actions.
    actions.push({ resource: command.resource, opts: command.opts, run: async () => {
      events.push('migration:start')
      result = await f.execute(command, operation)
      events.push('migration:complete')
      if (result.error || result.signal || result.status !== 0) throw Error('migration_command_failed')
    } })
    // Project just one captured gate onto the upload action. Do not union the
    // lists: the other fence must not hide a missing dependency. For the component
    // probe this is an explicit gate-contract projection, not SST inheritance.
    actions.push({ resource: worker.resource, opts: fence === 'component' ? worker.opts : worker.native!.opts, run: async () => {
      uploads++; events.push('native:upload')
    } })
    // Keep independent work ready in a later round, after the Command fails.
    const first = {}, second = {}
    actions.push({ resource: first, opts: {}, run: noop })
    actions.push({ resource: second, opts: { dependsOn: [first] }, run: noop })
    actions.push({ resource: {}, opts: { dependsOn: [second] }, run: async () => { independent++; events.push('independent') } })
    expect(uploads).toBe(0)
    const drained = await drain(actions)
    // Check behaviour first so fence mutations expose actual upload attempts.
    expect(uploads, `${fence} behavioural upload guard; events=${events.join(',')}`).toBe(succeeds ? 1 : 0)
    expect(independent).toBe(1)
    expect(events.indexOf('independent')).toBeGreaterThan(events.indexOf('migration:complete'))
    expect(result).toBeDefined()
    expect(result!.error).toBeUndefined(); expect(result!.signal).toBeNull()
    expect(result!.status, result!.stderr).toBe(succeeds ? 0 : 1)
    expect(drained.states.get(command.resource)).toBe(succeeds ? 'succeeded' : 'failed')
    expect(drained.states.get(worker.resource)).toBe(succeeds ? 'succeeded' : 'blocked')
    expect([...drained.errors.keys()]).toEqual(succeeds ? [] : [command.resource])
    const requests = readFileSync(f.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(requests.some(request => request.unexpected)).toBe(false)
    expect(requests.some(request => request.sql?.includes(pending))).toBe(true)
    expect(requests.filter(request => request.failedSQL)).toEqual(succeeds ? [] : [{ failedSQL: expect.stringContaining(pending) }])
    expect(readFileSync(f.configLoads, 'utf8').trim().split('\n')).toHaveLength(operation === 'update' ? 2 : 1)
    if (succeeds) {
      expect(JSON.parse(result!.stdout)).toMatchObject({ event: 'infra.migrations.applied', applied: 1, total: operation === 'update' ? 2 : 1 })
      expect(events.indexOf('native:upload')).toBeGreaterThan(events.indexOf('migration:complete'))
    }
    if (operation === 'update') expect(readFileSync(join(f.sql, '0001_initial.sql'), 'utf8')).toBe(f.initial)
    const db = new DatabaseSync(f.database)
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM _migrations').get()).toEqual({ n: succeeds ? (operation === 'update' ? 2 : 1) : (operation === 'update' ? 1 : 0) })
    } finally { db.close() }
  }, 60000)
})
