import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSecret, output, secret, type Output } from '@pulumi/pulumi'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sha256 } from '../../src/infra'
import { createProvisionPlan, provision, ProvisionDiagnostic, provisionErrorMessage, validateProvisionOptions, type ProvisionOptions } from '../../src/infra/provision'

const records = vi.hoisted(() => [] as { type: string; name: string; args: any; opts: any; resource: any; child?: any }[])
vi.mock('../../src/infra/sst-runtime', () => ({ sstCommand: () => ({ local: { Command: class {
  constructor(name: string, args: any, opts: any) { records.push({ type: 'migration', name, args, opts, resource: this }) }
} } }) }))
let root: string
let options: ProvisionOptions
const authSecret = 'synthetic-stable-auth-secret-at-least-32-characters'
const outputValue = <T>(value: Output<T>) => (value as unknown as { promise(): Promise<T> }).promise()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workbase-provision-'))
  await mkdir(join(root, 'application inputs'))
  await mkdir(join(root, 'sql'))
  await mkdir(join(root, 'console assets'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(root, 'application inputs/config.ts'), `export default { id: 'unfamiliar', revision: 1, roles: ['owner'], entities: {}, plugins: [] }\n`)
  await writeFile(join(root, 'worker.ts'), 'export default { fetch() { return new Response("ok") } }\n')
  await writeFile(join(root, 'sql/0001_initial.sql'), 'CREATE TABLE records (id TEXT PRIMARY KEY);\n')
  options = { projectRoot: root, configPath: 'application inputs/config.ts', handler: 'worker.ts', migrationsDir: 'sql',
    resourcePrefix: 'neutral-app', stage: 'preview', authSecret, authBaseUrl: 'https://neutral.example.test', accountId: 'a'.repeat(32) }
})
afterEach(async () => { records.length = 0; vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

function mockSst() {
  class D1 {
    databaseId = output('b'.repeat(36)); nodes = { database: {} }
    constructor(name: string, args: any, opts: any) {
      const child = { args: {}, opts: {} }; args.transform.database(child.args, child.opts)
      records.push({ type: 'db', name, args, opts, resource: this, child })
    }
  }
  class Kv {
    namespaceId = output('kv-id')
    constructor(name: string, args: any, opts: any) {
      const child = { args: {}, opts: {} }; args.transform.namespace(child.args, child.opts)
      records.push({ type: 'kv', name, args, opts, resource: this, child })
    }
  }
  class Queue {
    id: ReturnType<typeof output<string>>; nodes: any
    constructor(name: string, args: any, opts: any) {
      const child: any = { args: {}, opts: {} }; args.transform.queue(child.args, child.opts)
      this.id = output(name); this.nodes = { queue: { queueName: output(child.args.queueName) } }
      records.push({ type: 'queue', name, args, opts, resource: this, child })
    }
  }
  class Worker {
    url = output('https://neutral.example.test'); nodes: any
    constructor(name: string, args: any, opts: any) {
      // Model SST's native binding assembly, including its conditional ASSETS binding.
      const child: any = { args: { bindings: output([
        ...Object.entries(args.environment).map(([name, text]) => ({ name, type: 'plain_text', text })),
        ...(args.assets ? [{ name: 'ASSETS', type: 'assets' }] : []),
      ]) }, opts: {} }
      args.transform.worker(child.args, child.opts)
      this.nodes = { worker: { scriptName: output(child.args.scriptName) } }
      records.push({ type: 'worker', name, args, opts, resource: this, child })
    }
  }
  vi.stubGlobal('sst', { cloudflare: { D1, Kv, Queue, Worker } })
  vi.stubGlobal('$util', { output, secret })
  vi.stubGlobal('$cli', { paths: { platform: '/fixture/.sst/platform' } })
  vi.stubGlobal('cloudflare', {
    QueueConsumer: class {
      constructor(name: string, args: any, opts: any) { records.push({ type: 'consumer', name, args, opts, resource: this }) }
    },
    WorkersCronTrigger: class {
      scriptName: any; schedules: any
      constructor(name: string, args: any, opts: any) {
        this.scriptName = args.scriptName; this.schedules = output(args.schedules)
        records.push({ type: 'cron', name, args, opts, resource: this })
      }
    },
  })
}

it.each([
  ['stage', undefined, 'provision_invalid_stage'], ['resourcePrefix', undefined, 'provision_invalid_prefix'],
  ['handler', undefined, 'provision_invalid_handler'], ['stage', 'bad secret\n', 'provision_invalid_stage'],
  ['resourcePrefix', '../private-secret', 'provision_invalid_prefix'], ['handler', '', 'provision_invalid_handler'],
  ['authSecret', 'short-secret', 'provision_invalid_auth_secret'], ['authBaseUrl', 'https://user:secret@example.test/path', 'provision_invalid_auth_base_url'],
  ['authBaseUrl', 'http://example.test', 'provision_invalid_auth_base_url'], ['configPath', '', 'provision_invalid_config_path'],
  ['migrationsDir', '', 'provision_invalid_migrations_dir'], ['assetsDir', '', 'provision_invalid_assets_dir'],
  ['domain', 'other.example.test', 'provision_invalid_domain'], ['accountId', 'secret', 'provision_invalid_account_id'],
] as const)('input validation: %s rejects invalid input before resources and never echoes values', async (key, value, code) => {
  mockSst()
  try { await provision({ ...options, [key]: value } as ProvisionOptions); throw Error('expected_failure') }
  catch (error) {
    expect(error).toBeInstanceOf(ProvisionDiagnostic)
    expect(error).toMatchObject({ code, message: code })
    expect(provisionErrorMessage(error)).toBe(code)
    expect(String(error)).not.toContain(authSecret)
  }
  expect(records).toEqual([])
})

it('branded diagnostics reject forged and arbitrary exception text', () => {
  expect(provisionErrorMessage(new Error(authSecret))).toBe('provision_failed')
  expect(provisionErrorMessage({ name: 'ProvisionDiagnostic', message: authSecret, code: authSecret })).toBe('provision_failed')
  const branded = new ProvisionDiagnostic('provision_invalid_handler')
  branded.message = authSecret
  expect(provisionErrorMessage(branded)).toBe('provision_invalid_handler')
  expect(new ProvisionDiagnostic(authSecret as any).message).toBe('provision_failed')
})

it('config exceptions and unreadable paths become typed, secret-free errors before resource registration', async () => {
  mockSst()
  await expect(provision({ ...options, handler: authSecret })).rejects.toMatchObject({ code: 'provision_inputs_unreadable', message: 'provision_inputs_unreadable' })
  await writeFile(join(root, 'throwing.ts'), `throw new Error(${JSON.stringify(authSecret)})\n`)
  await expect(provision({ ...options, configPath: 'throwing.ts' })).rejects.toMatchObject({ code: 'provision_config_load_failed', message: 'provision_config_load_failed: [redacted]' })
  await writeFile(join(root, 'invalid.ts'), 'export default {}\n')
  await expect(provision({ ...options, configPath: 'invalid.ts' })).rejects.toMatchObject({ code: 'provision_invalid_config' })
  expect(records).toEqual([])
})

it('retains config error messages while redacting environment and provision secrets', async () => {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-cloud-token')
  await writeFile(join(root, 'throwing.ts'), `throw new Error('config dependency missing; ' + process.env.CLOUDFLARE_API_TOKEN + ' ' + ${JSON.stringify(authSecret)} + ' https://user:password@example.test')\n`)
  try { await createProvisionPlan({ ...options, configPath: 'throwing.ts' }); throw Error('expected_failure') }
  catch (error) {
    expect(error).toBeInstanceOf(ProvisionDiagnostic)
    expect(provisionErrorMessage(error)).toBe('provision_config_load_failed: config dependency missing; [redacted] [redacted] https://[redacted]@example.test')
    expect(String(error)).not.toContain('synthetic-cloud-token')
    expect(String(error)).not.toContain(authSecret)
  }
})

it('reports missing config dependencies with the underlying module error', async () => {
  await writeFile(join(root, 'missing.ts'), "import './does-not-exist.ts'\nexport default {}\n")
  await expect(createProvisionPlan({ ...options, configPath: 'missing.ts' })).rejects.toThrow(/provision_config_load_failed: .*Cannot find module.*does-not-exist/)
})

it('resource names are prefixed, stage-safe, deterministic and distinct across stages and long inputs', async () => {
  const first = await createProvisionPlan(options)
  const again = await createProvisionPlan(options)
  expect(again).toEqual(first)
  expect(JSON.stringify(first)).not.toContain(authSecret)
  const second = await createProvisionPlan({ ...options, stage: 'production' })
  expect(first.id).not.toBe(second.id)
  expect(new Set([...Object.values(first.names), ...Object.values(second.names)]).size).toBe(10)
  for (const name of Object.values(first.names)) expect(name).toMatch(/^neutral-app-preview-/)
  const long = await createProvisionPlan({ ...options, resourcePrefix: 'p'.repeat(63), stage: 's'.repeat(32) })
  const other = await createProvisionPlan({ ...options, resourcePrefix: 'p'.repeat(62) + 'q', stage: 's'.repeat(32) })
  for (const name of [...Object.values(long.names), ...Object.values(other.names)]) {
    expect(name.length).toBeLessThanOrEqual(63); expect(name).toMatch(/^[a-z][a-z0-9-]+$/)
  }
  expect(new Set([...Object.values(long.names), ...Object.values(other.names)]).size).toBe(10)
  const tupleA = await createProvisionPlan({ ...options, resourcePrefix: 'a-b', stage: 'c' })
  const tupleB = await createProvisionPlan({ ...options, resourcePrefix: 'a', stage: 'b-c' })
  expect(tupleA.names.worker).not.toBe(tupleB.names.worker)
})

it('regression: long production Worker names fit 54 characters and preserve the stable tuple hash across stages', async () => {
  for (const resourcePrefix of ['neutral-customer-application', 'p'.repeat(63)]) {
    const production = await createProvisionPlan({ ...options, resourcePrefix, stage: 'production' })
    const repeated = await createProvisionPlan({ ...options, resourcePrefix, stage: 'production' })
    const preview = await createProvisionPlan({ ...options, resourcePrefix, stage: 'preview' })
    expect(production.names.worker).toBe(repeated.names.worker)
    expect(production.names.worker).not.toBe(preview.names.worker)
    for (const plan of [production, preview]) {
      expect(plan.names.worker.length).toBeLessThanOrEqual(54)
      const hash = sha256(JSON.stringify([resourcePrefix, plan.stage, 'worker'])).slice(0, 12)
      expect(plan.names.worker).toMatch(new RegExp(`-${hash}$`))
    }
  }
})

it('regression: production protects D1 while migration trigger changes remain replaceable', async () => {
  mockSst()
  await provision({ ...options, stage: 'production' })
  await writeFile(join(root, 'sql/0002_add.sql'), 'ALTER TABLE records ADD COLUMN name TEXT;\n')
  await provision({ ...options, stage: 'production' })
  const databases = records.filter(record => record.type === 'db')
  const migrations = records.filter(record => record.type === 'migration')
  expect(databases).toHaveLength(2)
  expect(migrations).toHaveLength(2)
  for (const database of databases) {
    expect(database.opts).toMatchObject({ protect: true, retainOnDelete: true })
    expect(database.child.opts).toMatchObject({ protect: true, retainOnDelete: true })
  }
  for (const migration of migrations) expect(migration.opts.protect).toBe(false)
  expect(migrations[1].name).toBe(migrations[0].name)
  expect(migrations[1].args.triggers).not.toEqual(migrations[0].args.triggers)
})

it.each([false, true])('builds D1/KV/queue/DLQ/consumer/cron with migration-before-upload and optional ASSETS=%s', async assets => {
  mockSst()
  const result = await provision({ ...options, ...(assets ? { assetsDir: 'console assets' } : {}) })
  expect(records.map(record => record.type)).toEqual(['db', 'kv', 'queue', 'queue', 'migration', 'worker', 'consumer', 'cron'])
  const byType = (type: string) => records.find(record => record.type === type)!
  const db = byType('db'), migration = byType('migration'), worker = byType('worker'), consumer = byType('consumer'), cron = byType('cron')
  expect(migration.opts.dependsOn).toEqual([db.resource, db.resource.nodes.database])
  expect(worker.opts.dependsOn).toContain(migration.resource)
  expect(worker.child.opts.dependsOn).toContain(migration.resource)
  expect(migration.args.create).toBe(migration.args.update)
  expect(migration.args.create).toBe('"$WB_NODE_BINARY" "$WB_MIGRATION_BIN" migrate "$WB_DATABASE_ID" "$WB_MIGRATIONS_DIRECTORY" --config "$WB_CONFIG_MODULE"')
  expect(migration.args.environment.WB_MIGRATION_BIN).toMatch(/\/core\/src\/infra\/bin.mjs$/)
  expect(migration.args.environment.WB_CONFIG_MODULE).toBe(join(root, 'application inputs/config.ts'))
  expect(migration.args.dir).toBe(root)
  expect(migration.args.environment).not.toHaveProperty('CLOUDFLARE_API_TOKEN')
  expect(migration.args.create).not.toContain(root)
  const bindings = await worker.child.args.bindings.promise()
  expect(bindings.find((binding: any) => binding.name === 'BETTER_AUTH_SECRET')).toMatchObject({ type: 'secret_text', text: authSecret })
  expect(await isSecret(worker.child.args.bindings)).toBe(true)
  const bindingNames = bindings.map((binding: any) => binding.name)
  expect(new Set(bindingNames).size).toBe(bindingNames.length)
  expect(bindingNames.sort()).toEqual((await createProvisionPlan({ ...options, ...(assets ? { assetsDir: 'console assets' } : {}) })).bindingNames.sort())
  expect(bindings.find((binding: any) => binding.name === 'AUTH_BASE_URL').text).toBe(options.authBaseUrl)
  expect(worker.args.compatibility).toEqual({ date: '2026-08-01', flags: ['nodejs_compat'] })
  expect(worker.child.args.observability.logs.invocationLogs).toBe(false)
  expect(worker.child.args.keepBindings).toEqual([])
  expect(worker.args.assets).toEqual(assets ? { directory: join(root, 'console assets'), htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: true } : undefined)
  const schemaBinding = JSON.parse(worker.args.environment.SCHEMA_EXPECTED)
  expect(schemaBinding).toMatchObject({ revision: 1, coreVersion: expect.any(String), migrations: expect.stringMatching(/^[a-f0-9]{64}$/), pluginMigrations: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(consumer.args).toMatchObject({ accountId: options.accountId, type: 'worker', settings: { batchSize: 10, maxWaitTimeMs: 1000, maxRetries: 5 } })
  expect(await consumer.args.deadLetterQueue.promise()).toBe(await outputValue(result.deadLetterQueueName))
  expect(consumer.opts.dependsOn).toEqual([worker.resource, result.resources.events, result.resources.deadLetter])
  expect(cron.args.schedules).toEqual([{ cron: '*/5 * * * *' }])
  expect(cron.opts.dependsOn).toContain(worker.resource)
  expect(await cron.args.scriptName.promise()).toBe(await outputValue(result.workerName))
})

it('wires explicit email/domain/webhook inputs and protects production resource children', async () => {
  mockSst()
  await provision({ ...options, stage: 'production', authSecret: secret(authSecret), domain: 'neutral.example.test',
    email: { from: 'auth@example.test' }, internalToken: secret('synthetic-internal-token'),
    webhook: { url: secret('https://hooks.example.test'), allowedHosts: 'hooks.example.test', service: output('consumer-owned-receiver'), events: 'records.created' } })
  const worker = records.find(record => record.type === 'worker')!
  expect(worker.args.domain).toBe('neutral.example.test')
  expect(worker.args.environment).toMatchObject({ EMAIL_FROM: 'auth@example.test', WEBHOOK_EVENTS: 'records.created' })
  const bindings = await worker.child.args.bindings.promise()
  expect(bindings).toEqual(expect.arrayContaining([
    { name: 'EMAIL', type: 'send_email', allowedSenderAddresses: ['auth@example.test'] },
    { name: 'WEBHOOK_URL', type: 'secret_text', text: 'https://hooks.example.test' },
    { name: 'WEBHOOK_ALLOWED_HOSTS', type: 'secret_text', text: 'hooks.example.test' },
    { name: 'WEBHOOK_SERVICE', type: 'service', service: 'consumer-owned-receiver' },
    { name: 'INTERNAL_TOKEN', type: 'secret_text', text: 'synthetic-internal-token' },
  ]))
  for (const record of records.filter(record => record.type !== 'migration')) {
    expect(record.opts).toMatchObject({ protect: true, retainOnDelete: true })
    if (record.child) expect(record.child.opts).toMatchObject({ protect: true, retainOnDelete: true })
  }
})

it('migration triggers change for SQL, config and application verification fingerprints', async () => {
  const initial = await createProvisionPlan(options)
  await writeFile(join(root, 'sql/0002_add.sql'), 'ALTER TABLE records ADD COLUMN name TEXT;\n')
  const addedSql = await createProvisionPlan(options)
  expect(addedSql.schema.migrations).not.toBe(initial.schema.migrations)
  expect(addedSql.migration.triggers).not.toEqual(initial.migration.triggers)
  await writeFile(join(root, 'application inputs/config.ts'), `export default { id: 'unfamiliar', revision: 2, roles: ['owner'], entities: {}, plugins: [] }\n`)
  const configEdit = await createProvisionPlan(options)
  expect(configEdit.schema.revision).toBe(2)
  expect(configEdit.migration.triggers.at(-1)).not.toBe(addedSql.migration.triggers.at(-1))
  mockSst()
  await provision({ ...options, migrationTriggers: ['application-verifier-v2'] })
  expect(records.find(record => record.type === 'migration')!.args.triggers).toContain('application-verifier-v2')
})

it('requires SST only when provisioning, while dry planning works without SST or credentials', async () => {
  vi.stubEnv('CLOUDFLARE_DEFAULT_ACCOUNT_ID', '')
  const plan = await createProvisionPlan({ ...options, accountId: undefined })
  expect(plan.names.worker).toMatch(/^neutral-app-preview-/)
  await expect(provision(options)).rejects.toMatchObject({ code: 'provision_requires_sst' })
  expect(records).toEqual([])
  validateProvisionOptions(options)
})
