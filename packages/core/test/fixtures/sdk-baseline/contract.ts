import { afterEach, expect, it, vi } from 'vitest'
import * as sdk from '../../../src/migrations/sdk-baseline'
import { expectedPluginMigrations, pluginMigrationStatus } from '../../../src/kernel/migrations'
import { CORE_VERSION, defineInstance } from '../../../src/config'
import { hashMigrationRows, schemaStatus } from '../../../src/schema-compatibility'
import { defineConfig, defineEntity, accountLink, defineAccess, accessEntities, accessSystemActions } from '../../../src/schema'
import { KernelRegistry } from '../../../src/kernel/registry'
import { plan } from '../../../src/migrations/planner'
import { initialSchema } from '../../../src/migrations/schema'
import { migrateInstance } from '../../../src/infra/instance-migrations'
import { sha256 } from '../../../src/crypto'
import type { D1Query } from '../../../src/infra/d1-migrations'
import type { WorkbasePlugin } from '../../../src/kernel/plugin'
import { identity } from '../../../../plugins/identity/src'
import { members } from '../../../../plugins/members/src'
import { permissions } from '../../../../plugins/permissions/src'

export interface BaselineDatabase { db: D1Database; query: D1Query; calls: string[] }
export function composition(extra: WorkbasePlugin[] = [], roles = ['admin', 'staff']) {
  return new KernelRegistry(defineConfig({
    id: 'baseline', revision: 1, interactive: false, languages: ['en'],
    roles, organizationOwnerRole: 'admin', plugins: [identity, permissions({ roles, ownerRole: 'admin' }), members, ...extra],
    entities: { worker: defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() },
      access: Object.fromEntries(roles.map(role => [role, 'deny'])),
    }) },
    access: defineAccess({
      predicates: {},
      roles: Object.fromEntries(roles.map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) }])),
      entities: Object.fromEntries(accessEntities.map(entity => [entity, Object.fromEntries(roles.map(role => [role, 'deny']))])),
    }),
  }))
}
export async function domainFiles(kernel = composition()) {
  const sql = initialSchema(kernel.config)
  return [{ filename: '0001_r1.sql', sql, checksum: await sha256(sql) }]
}

/** Same acceptance contract runs on native workerd D1 and the Node SQLite adapter. */
export function baselineContract(database: () => BaselineDatabase) {
  afterEach(() => { vi.restoreAllMocks() })
  for (const languages of [['en'], []]) {
    const label = JSON.stringify(languages)
    const legacy = () => new KernelRegistry(defineInstance({ id: 'legacy', revision: 1, languages, entities: {} }))
    it(`legacy languages=${label} keeps main's exact SQL and workbase-core ledger`, async () => {
      const kernel = legacy()
      // Captured from main 1f88765 for both language lists (and absent languages).
      expect(await sha256(initialSchema(kernel.config))).toBe('e9f01a0c333eeac9ae63a449fac1691bad86f1172403dcf797481ebc3f86e544')
      expect((await expectedPluginMigrations(kernel.plugins, kernel.config)).map(row => row.namespace)).toEqual(['workbase-core'])
    })
    it(`legacy languages=${label} replays a fresh database successfully`, async () => {
      const { db, query } = database(), kernel = legacy()
      await expect(migrateInstance(query, await domainFiles(kernel), kernel)).resolves.toMatchObject({ applied: 1 })
      expect(await db.prepare('SELECT revision FROM instance_meta').first('revision')).toBe(1)
      expect((await db.prepare('SELECT DISTINCT namespace FROM _plugin_migrations').all()).results).toEqual([{ namespace: 'workbase-core' }])
    })
    it(`legacy languages=${label} accepts an existing legacy database`, async () => {
      const { db, query } = database()
      // Seed the unchanged main-era SQL and receipts without the language option.
      const existing = new KernelRegistry(defineInstance({ id: 'legacy', revision: 1, entities: {} }))
      const files = await domainFiles(existing)
      await migrateInstance(query, files, existing)
      const before = (await db.prepare('SELECT * FROM _plugin_migrations').all()).results
      await expect(migrateInstance(query, files, legacy())).resolves.toMatchObject({ applied: 0 })
      expect((await db.prepare('SELECT * FROM _plugin_migrations').all()).results).toEqual(before)
    })
  }
  it('fresh SDK -> plugins -> domain, then verification, yields usable identity and worker', async () => {
    const { db, query, calls } = database()
    const kernel = composition([{ name: 'verify-domain', version: '1.0.0', async checkSchema(db) {
      await db.prepare('SELECT user FROM worker LIMIT 0').all()
    } }])
    const files = await domainFiles(kernel)
    expect(files[0].sql).not.toMatch(/CREATE TABLE (?:atomic_assert|organizations|users|instance_meta)|create table "user"/i)
    expect(await migrateInstance(query, files, kernel)).toMatchObject({ applied: 1, total: 1 })
    expect(plan(null, kernel.config).sql).toBe(files[0].sql)
    expect((await db.prepare('SELECT namespace FROM _plugin_migrations ORDER BY rowid').all()).results.map(row => row.namespace)).toEqual(['workbase-sdk', 'identity', 'members', 'members', 'members', 'members'])
    const sdk = calls.findIndex(sql => sql.includes('CREATE TABLE atomic_assert'))
    const plugin = calls.findIndex(sql => sql.includes('ALTER TABLE memberships ADD COLUMN scope_id'))
    const domain = calls.findIndex(sql => sql.includes('CREATE TABLE "worker"'))
    const verify = calls.findIndex(sql => sql.includes('SELECT user FROM worker LIMIT 0'))
    expect(sdk).toBeGreaterThanOrEqual(0)
    expect(plugin).toBeGreaterThan(sdk)
    expect(domain).toBeGreaterThan(plugin)
    expect(verify).toBeGreaterThan(domain)
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()
    expect(tables.results.map(row => row.name)).toEqual(expect.arrayContaining(['users', 'user', 'identity_profiles', 'memberships', 'worker', 'instance_meta', '_plugin_migrations', '_migrations']))
    await db.batch([
      db.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('u','User','user@example.test',1,'now','now')`),
      db.prepare(`INSERT INTO users (id,organization_id,name,role,created_at,updated_at) VALUES ('u','instance','User','staff','now','now')`),
      db.prepare(`INSERT INTO memberships (user_id,organization_id,role) VALUES ('u','instance','staff')`),
      db.prepare(`INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES ('u','First','Last','now')`),
      db.prepare(`INSERT INTO worker (id,organization_id,name,user,created_at,updated_at) VALUES ('w','instance','Worker','u','now','now')`),
    ])
    expect(await kernel.identity.resolveUser(db, 'u')).toMatchObject({ id: 'u', email: 'user@example.test' })
    expect(await db.prepare('SELECT user FROM worker').first('user')).toBe('u')
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    const expected = { revision: 1, coreVersion: CORE_VERSION, migrations: await hashMigrationRows(files),
      pluginMigrations: await sha256(JSON.stringify(await expectedPluginMigrations(kernel.plugins, kernel.config))) }
    expect(await schemaStatus({ DB: db, SCHEMA_EXPECTED: JSON.stringify(expected), STAGE: 'staging' }, kernel.config)).toMatchObject({ compatible: true, applied: expected })
  })

  it('second run executes only reads and preserves every receipt', async () => {
    const { db, query, calls } = database(), kernel = composition(), files = await domainFiles(kernel)
    await migrateInstance(query, files, kernel)
    const before = (await db.prepare('SELECT * FROM _plugin_migrations ORDER BY namespace,position').all()).results
    const domain = (await db.prepare('SELECT * FROM _migrations').all()).results
    calls.length = 0
    expect(await migrateInstance(query, files, kernel)).toMatchObject({ applied: 0 })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true)
    expect((await db.prepare('SELECT * FROM _plugin_migrations ORDER BY namespace,position').all()).results).toEqual(before)
    expect((await db.prepare('SELECT * FROM _migrations').all()).results).toEqual(domain)
  })

  it('failed plugin file rolls back its SQL and receipt and prevents domain SQL', async () => {
    const { db, query, calls } = database()
    const kernel = composition([{ name: 'failing', version: '1.0.0', migrations: [
      { name: '001_ok', sql: 'CREATE TABLE plugin_kept (id TEXT);' },
      { name: '002_fail', sql: 'CREATE TABLE plugin_partial (id TEXT); INSERT INTO missing_table VALUES (1);' },
    ] }])
    await expect(migrateInstance(query, await domainFiles(kernel), kernel)).rejects.toThrow()
    expect(calls.some(sql => sql.includes('CREATE TABLE "worker"'))).toBe(false)
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='plugin_partial'").first()).toBeNull()
    expect((await db.prepare("SELECT name FROM _plugin_migrations WHERE namespace='failing' ORDER BY position").all()).results).toEqual([{ name: '001_ok' }])
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='plugin_kept'").first()).toBeTruthy()
    // Retry after removing the broken plugin; SDK metadata is present but no
    // domain revision has been written yet. The old successful receipt survives.
    const repaired = composition()
    await expect(migrateInstance(query, await domainFiles(repaired), repaired)).resolves.toMatchObject({ applied: 1 })
    expect(await db.prepare("SELECT name FROM _plugin_migrations WHERE namespace='failing'").first('name')).toBe('001_ok')
  })

  it('old-era inline database is rejected before writes with a concrete unsupported-history diagnostic', async () => {
    const { db, query, calls } = database(), kernel = composition()
    await db.prepare('CREATE TABLE instance_meta (revision INTEGER,core_version TEXT)').run()
    await db.prepare("INSERT INTO instance_meta VALUES (7,'0.2.9')").run()
    calls.length = 0
    await expect(migrateInstance(query, await domainFiles(kernel), kernel)).rejects.toThrow(/migration_unsupported_history:.*instance_meta.*unsupported.*reset/i)
    expect(calls.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true)
    expect(await db.prepare('SELECT revision FROM instance_meta').first('revision')).toBe(7)
  })

  it('SDK baseline SQL is independent of configured application roles', async () => {
    const { query, calls } = database(), kernel = composition()
    await migrateInstance(query, await domainFiles(kernel), kernel)
    calls.length = 0
    const changed = composition([], ['admin', 'staff', 'reviewer'])
    expect(await domainFiles(changed)).toEqual(await domainFiles(kernel))
    await migrateInstance(query, await domainFiles(changed), changed)
    expect(calls.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true)
  })

  it('failed first SDK step rolls back all SDK DDL and receipt, blocks plugins/domain, and can retry', async () => {
    const { db, query, calls } = database(), kernel = composition(), files = await domainFiles(kernel)
    const original = sdk.sdkMigrations()
    vi.spyOn(sdk, 'sdkMigrations').mockReturnValue([{ ...original[0], sql: original[0].sql + '; INSERT INTO sdk_missing VALUES (1);' }])
    await expect(migrateInstance(query, files, kernel)).rejects.toThrow()
    expect((await db.prepare('SELECT * FROM _plugin_migrations').all()).results).toEqual([])
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='atomic_assert'").first()).toBeNull()
    expect(calls.some(sql => /ALTER TABLE memberships ADD COLUMN scope_id|CREATE TABLE "worker"/.test(sql))).toBe(false)
    vi.restoreAllMocks()
    await expect(migrateInstance(query, files, kernel)).resolves.toMatchObject({ applied: 1 })
  })

  it('failed SDK file mid-namespace rolls back its data, DDL and receipt while preserving prior steps', async () => {
    const { db, query, calls } = database(), kernel = composition(), files = await domainFiles(kernel)
    const original = sdk.sdkMigrations()
    const pending = { name: '003_failed', sql: 'INSERT INTO sdk_kept VALUES (2); CREATE TABLE sdk_partial (id INTEGER); INSERT INTO sdk_missing VALUES (1);' }
    const upgraded = [...original, { name: '002_kept', sql: 'CREATE TABLE sdk_kept (id INTEGER); INSERT INTO sdk_kept VALUES (1);' }, pending]
    const mock = vi.spyOn(sdk, 'sdkMigrations').mockReturnValue(upgraded)
    await expect(migrateInstance(query, files, kernel)).rejects.toThrow()
    expect((await db.prepare("SELECT name FROM _plugin_migrations WHERE namespace='workbase-sdk' ORDER BY position").all()).results).toEqual([{ name: '001_system' }, { name: '002_kept' }])
    expect((await db.prepare('SELECT id FROM sdk_kept').all()).results).toEqual([{ id: 1 }])
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='sdk_partial'").first()).toBeNull()
    expect(calls.some(sql => /ALTER TABLE memberships ADD COLUMN scope_id|CREATE TABLE "worker"/.test(sql))).toBe(false)
    mock.mockReturnValue([...upgraded.slice(0, -1), { ...pending, sql: 'INSERT INTO sdk_kept VALUES (2);' }])
    await expect(migrateInstance(query, files, kernel)).resolves.toMatchObject({ applied: 1 })
  })

  it('SDK-only upgrade appends one SDK receipt with no domain SQL, revision or migration', async () => {
    const { db, query, calls } = database(), kernel = composition(), files = await domainFiles(kernel)
    await migrateInstance(query, files, kernel)
    const domain = (await db.prepare('SELECT * FROM _migrations').all()).results
    const meta = (await db.prepare('SELECT * FROM instance_meta').all()).results
    vi.spyOn(sdk, 'sdkMigrations').mockReturnValue([...sdk.sdkMigrations(), { name: '002_upgrade', sql: 'CREATE TABLE sdk_upgrade (id INTEGER);' }])
    calls.length = 0
    expect(await migrateInstance(query, files, kernel)).toMatchObject({ applied: 0, total: 1 })
    expect(calls.filter(sql => !/^SELECT/.test(sql))).toHaveLength(1)
    expect(calls.find(sql => sql.includes('CREATE TABLE sdk_upgrade'))).toContain("'workbase-sdk','002_upgrade'")
    expect((await db.prepare('SELECT * FROM _migrations').all()).results).toEqual(domain)
    expect((await db.prepare('SELECT * FROM instance_meta').all()).results).toEqual(meta)
    expect(await domainFiles(kernel)).toEqual(files)
  })

  it('failed domain file rolls back its SQL and receipt after SDK/plugins succeed', async () => {
    const { db, query } = database(), kernel = composition()
    const files = await domainFiles(kernel)
    const sql = files[0].sql + '; INSERT INTO missing_domain VALUES (1);'
    await expect(migrateInstance(query, [{ ...files[0], sql, checksum: await sha256(sql) }], kernel)).rejects.toThrow()
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='worker'").first()).toBeNull()
    expect((await db.prepare('SELECT * FROM _migrations').all()).results).toEqual([])
    expect((await db.prepare('SELECT * FROM instance_meta').all()).results).toEqual([])
    expect(await db.prepare("SELECT count(*) n FROM _plugin_migrations WHERE namespace='members'").first('n')).toBe(4)
    await expect(migrateInstance(query, files, kernel)).resolves.toMatchObject({ applied: 1 })
  })

  it('plugin append-only checks survive uninstall and reinstallation', async () => {
    const { db, query } = database()
    const plugin: WorkbasePlugin = { name: 'retained', version: '1.0.0', migrations: [
      { name: '001_first', sql: 'CREATE TABLE retained (id INTEGER);' },
      { name: '002_second', sql: 'INSERT INTO retained VALUES (1);' },
    ] }
    const kernel = composition([plugin]), files = await domainFiles(kernel)
    await migrateInstance(query, files, kernel)
    const receipts = (await db.prepare("SELECT * FROM _plugin_migrations WHERE namespace='retained' ORDER BY position").all()).results
    const uninstalled = composition()
    await migrateInstance(query, files, uninstalled)
    expect((await pluginMigrationStatus(db, uninstalled.plugins, uninstalled.config)).expected).toBe((await pluginMigrationStatus(db, uninstalled.plugins, uninstalled.config)).applied)
    expect((await db.prepare("SELECT * FROM _plugin_migrations WHERE namespace='retained' ORDER BY position").all()).results).toEqual(receipts)
    for (const migrations of [plugin.migrations!.slice(0, 1), [...plugin.migrations!].reverse()]) {
      await expect(migrateInstance(query, files, composition([{ ...plugin, migrations }]))).rejects.toThrow('Plugin migrations must be append-only: retained/')
    }
    const changed = [{ ...plugin.migrations![0], sql: 'SELECT 1;' }, plugin.migrations![1]]
    await expect(migrateInstance(query, files, composition([{ ...plugin, migrations: changed }]))).rejects.toThrow('Plugin migration changed: retained/001_first')
    await expect(migrateInstance(query, files, kernel)).resolves.toMatchObject({ applied: 0 })
  })

  it('SDK history is append-only and its namespace cannot be supplied as a plugin', async () => {
    const { query } = database(), kernel = composition(), files = await domainFiles(kernel)
    await migrateInstance(query, files, kernel)
    const original = sdk.sdkMigrations()
    const mock = vi.spyOn(sdk, 'sdkMigrations').mockReturnValue([])
    await expect(migrateInstance(query, files, kernel)).rejects.toThrow('Plugin migrations must be append-only: workbase-sdk/001_system')
    mock.mockReturnValue([{ ...original[0], sql: 'SELECT 1;' }])
    await expect(migrateInstance(query, files, kernel)).rejects.toThrow('Plugin migration changed: workbase-sdk/001_system')
    await expect(migrateInstance(query, files, composition([{ name: 'workbase-sdk', version: '1.0.0' }]))).rejects.toThrow('Reserved migration namespace: workbase-sdk')
  })

  it.each(['_migrations', '_plugin_migrations'])('old-era %s history is refused by CLI orchestration and direct kernel calls', async table => {
    const { db, query, calls } = database(), kernel = composition()
    await db.prepare(table === '_migrations'
      ? "CREATE TABLE _migrations (filename TEXT,checksum TEXT)"
      : "CREATE TABLE _plugin_migrations (namespace TEXT,name TEXT,position INTEGER,checksum TEXT)").run()
    if (table === '_migrations') await db.prepare("INSERT INTO _migrations VALUES ('0001_initial.sql','legacy')").run()
    else await db.prepare("INSERT INTO _plugin_migrations VALUES ('workbase-core','001_model_b',0,'legacy')").run()
    calls.length = 0
    await expect(migrateInstance(query, await domainFiles(kernel), kernel)).rejects.toThrow('migration_unsupported_history:found ' + table)
    await expect(kernel.applyMigrations(db)).rejects.toThrow('unsupported')
    expect(calls.every(sql => /^SELECT/.test(sql))).toBe(true)
  })

  it('legacy inline initial SQL retains system/auth DDL', () => {
    const inline = defineInstance({ id: 'inline', revision: 1, entities: {} })
    expect(initialSchema(inline)).toContain('CREATE TABLE atomic_assert')
    expect(initialSchema(inline)).toContain('create table "user"')
    expect(initialSchema(inline)).toContain('CREATE TABLE instance_meta')
  })


  it('pins the immutable SDK baseline SQL checksum', async () => {
    expect(await sha256(sdk.sdkMigrations()[0].sql)).toBe('ff8126d1572e1c1fe06ec26061f291599aa25bff4045a762e01a64442e226304')
  })

  it('SDK stamp refresh preserves domain revision and receipts', async () => {
    const { db, query } = database(), kernel = composition(), files = await domainFiles(kernel)
    await migrateInstance(query, files, kernel)
    const before = (await db.prepare('SELECT * FROM _migrations').all()).results
    await db.prepare("UPDATE instance_meta SET core_version='0.1.0'").run()
    await expect(migrateInstance(query, files, kernel)).resolves.toMatchObject({ applied: 0, total: 1 })
    expect((await db.prepare('SELECT revision,core_version FROM instance_meta').all()).results).toEqual([{ revision: 1, core_version: CORE_VERSION }])
    expect((await db.prepare('SELECT * FROM _migrations').all()).results).toEqual(before)
  })

}
