import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/schema/load'
import { schemaLock, lockBytes, diffSpecs, checkSchema } from '../../src/migrations/schema-lock'
import { KernelRegistry } from '../../src/kernel/registry'
import { createApp } from '../../src/app'
import { migrateInstance, queryDatabase } from '../../src/infra/instance-migrations'
import { readMigrationFiles } from '../../src/infra/migration-files'
import { runCli, migrationErrorMessage } from '../../src/infra/cli'
import { provisionConfigSchema } from '../../src/infra/provision-config'
import { expectedSchema } from '../../src/infra/schema'
import { buildInfo } from '../../src/console'
import { makeEvent } from '../../src/audit-event'
import type { RuntimeEnv, Scope } from '../../src/types'
import fixture from '../fixtures/config-era/config'

const roots: string[] = []
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function consumer() {
  const root = mkdtempSync(join(tmpdir(), 'lock-binding-')); roots.push(root)
  cpSync(resolve('packages/core/test/fixtures/config-era'), root, { recursive: true })
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  return root
}
const env = { CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic' }
const cliArgs = (root: string) => ['migrate', 'a'.repeat(36), join(root, 'migrations'), '--config', join(root, 'config.ts')]
const scope = { organizationId: 'org', actor: { type: 'service', id: 'test' }, correlationId: 'test' } as Scope

it('r2 lock reaches native and Worker imports, loader, CLI, provisioning, health, audit and console', async () => {
  const root = consumer(), path = join(root, 'schema/worker.ts')
  writeFileSync(path, readFileSync(path, 'utf8').replace('fields: {', "fields: { extra: { type: 'text' },"))
  const base = schemaLock(fixture), config = structuredClone(fixture)
  config.entities.worker.fields.extra = { type: 'text', required: false }
  const lock = schemaLock(config, base)
  writeFileSync(join(root, 'schema.lock.json'), lockBytes(lock))
  writeFileSync(join(root, 'migrations/0002_r2.sql'), diffSpecs(base.tables, lock.tables))
  const native = (await import(pathToFileURL(join(root, 'config.ts')).href)).default
  expect(native.revision).toBe(2)
  const bundled = join(root, 'bundle.mjs')
  execFileSync('bun', ['build', join(root, 'config.ts'), '--target=browser', '--external=node:*', '--format=esm', '--outfile', bundled])
  const worker = (await import(pathToFileURL(bundled).href)).default
  const loaded = (await loadConfig(join(root, 'config.ts'))).config
  for (const value of [native, worker, loaded, structuredClone(worker), JSON.parse(JSON.stringify(worker))]) expect(new KernelRegistry(value).config.revision).toBe(2)
  const expected = await provisionConfigSchema(root, join(root, 'config.ts'), join(root, 'migrations'), [])
  expect(expected.revision).toBe(2)
  const sqlite = new DatabaseSync(':memory:')
  try {
    const query = async (sql: string) => {
      if (/^\s*SELECT\b/.test(sql)) return [{ success: true, results: sqlite.prepare(sql).all() }]
      sqlite.exec('BEGIN')
      try { sqlite.exec(sql); sqlite.exec('COMMIT'); return [{ success: true }] }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    }
    const files = await readMigrationFiles(join(root, 'migrations'))
    await migrateInstance(query, files, new KernelRegistry(worker))
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => Response.json({ success: true, result: await query(JSON.parse(init.body as string).sql) }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCli(cliArgs(root), env)
    const runtime = { DB: queryDatabase(query), SCHEMA_EXPECTED: JSON.stringify(expected), STAGE: 'staging' } as RuntimeEnv
    const response = await createApp(worker, runtime).request('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ revision: 2, schema: { compatible: true } })
    expect(makeEvent(worker, scope, 'create', 'worker', 'id').schema_version).toBe(2)
    expect((await buildInfo(worker, runtime, 'https://example.test')).revision).toBe(2)
  } finally { sqlite.close() }
})

it.each(['revision', 'native import', 'bundle import', 'loadConfig', 'kernel', 'createApp', 'migrateInstance', 'migration CLI', 'SCHEMA_EXPECTED', 'audit', 'console', 'serialized kernel'])('unbound SDK config rejects %s with schema lock not bound', async path => {
  const root = consumer(), configPath = join(root, 'config.ts')
  // Keep the same declaration, deliberately omit its lock binding.
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('bindSchemaLock(defineConfig({', 'defineConfig({').replace('}), lock)', '})').replace("import lock from './schema.lock.json'", ''))
  rmSync(join(root, 'schema.lock.json'))
  const config = (await loadConfig(configPath)).config
  const runtime = { DB: {} } as RuntimeEnv
  const actions: Record<string, () => unknown> = {
    revision: () => config.revision,
    'native import': async () => (await import(pathToFileURL(configPath).href)).default.revision,
    'bundle import': async () => {
      const outfile = join(root, 'unbound.mjs')
      execFileSync('bun', ['build', configPath, '--target=browser', '--external=node:*', '--format=esm', '--outfile', outfile])
      return (await import(pathToFileURL(outfile).href)).default.revision
    },
    loadConfig: () => config.revision,
    kernel: () => new KernelRegistry(config),
    createApp: () => createApp(config, runtime),
    migrateInstance: () => migrateInstance(vi.fn(), [], { config } as KernelRegistry),
    'migration CLI': () => runCli(cliArgs(root), env),
    SCHEMA_EXPECTED: () => provisionConfigSchema(root, configPath, join(root, 'migrations'), []),
    audit: () => makeEvent(config, scope, 'create', 'worker', 'id'),
    console: () => buildInfo(config, runtime, 'https://example.test'),
    'serialized kernel': () => new KernelRegistry({ ...structuredClone(fixture), revision: undefined } as never),
  }
  await expect(Promise.resolve().then(actions[path])).rejects.toThrow('schema lock not bound')
  if (path === 'migration CLI') {
    try { await actions[path]() } catch (error) { expect(migrationErrorMessage(error)).toContain('schema lock not bound') }
  }
  await expect(expectedSchema({ config, revision: 1, migrationsDirectory: join(root, 'migrations') })).rejects.toThrow('schema lock not bound')
})

it('order drift names the first table and source location, with located fallback', () => {
  const config = structuredClone(fixture); config.entities.another = config.entities.worker
  const lock = schemaLock(config); lock.tables.reverse()
  expect(() => checkSchema(config, lock, { 'entities.another': { file: 'schema/another.ts', line: 7, column: 1 } })).toThrow('schema/another.ts:7: another: table/column order')
  expect(() => checkSchema(config, lock)).toThrow('config.ts:1: another: table/column order')
})

it('column order drift names the first column and its source, falling back to the table', () => {
  const lock = schemaLock(fixture); lock.tables[0].columns.reverse()
  const source = { file: 'schema/worker.ts', line: 9, column: 1 }
  expect(() => checkSchema(fixture, lock, { 'entities.worker.fields.id': source })).toThrow('schema/worker.ts:9: worker.id: table/column order')
  expect(() => checkSchema(fixture, lock, { 'entities.worker': source })).toThrow('schema/worker.ts:9: worker.id: table/column order')
})
