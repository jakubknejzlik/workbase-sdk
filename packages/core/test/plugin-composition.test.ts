import { queryClient } from '../../mcp/test/data/query-client'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { expectedPluginMigrations } from '../src/kernel/migrations'
import { KernelRegistry, kernelFor } from '../src/kernel/registry'
import type { WorkbasePlugin } from '../src/kernel/plugin'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { json, request, runtime, setup, insertDomain } from '@workbasehq/test-support/helpers'
import { createApp } from '../src/app'

// Cast keeps this regression suite runnable before contract metadata exists.
const plugin = (name: string, extra: Record<string, unknown> = {}): WorkbasePlugin => ({ name, version: '9.2.0', ...extra })
const build = (plugins: WorkbasePlugin[], extra = {}) => new KernelRegistry({ ...sample, interactive: false, ...extra } as any, { plugins })
beforeEach(async () => { await setup(); await insertDomain() })

it('rejects unbound configs instead of rebuilding default permissions', () => {
  expect(() => kernelFor(defineInstance({ ...sample }))).toThrow('Unbound instance config')
})
it.each([
  ['missing', [plugin('consumer', { requires: { identity: '^1' } })], /consumer.*missing.*identity/i],
  ['incompatible', [plugin('provider', { provides: { identity: '2.x' } }), plugin('consumer', { requires: { identity: '^1' } })], /consumer.*identity.*\^1.*2.x/i],
  ['duplicate', [plugin('one', { provides: { identity: '1.x' } }), plugin('two', { provides: { identity: '1.x' } })], /duplicate.*identity/i],
  ['cyclic', [plugin('one', { provides: { a: '1.x' }, requires: { b: '^1' } }), plugin('two', { provides: { b: '1.x' }, requires: { a: '^1' } })], /cycle.*one.*two/i],
  ['optional incompatible', [plugin('one', { optionalRequires: { a: '^1' } }), plugin('two', { provides: { a: '2.x' } })], /one.*a.*\^1.*2.x/i],
  ['optional cycle', [plugin('one', { provides: { a: '1.x' }, optionalRequires: { b: '^1' } }), plugin('two', { provides: { b: '1.x' }, requires: { a: '^1' } })], /cycle/i],
] as const)('fails the build for %s contracts', (_name, plugins, message) => {
  expect(() => build([...plugins])).toThrow(message)
})
it('rejects config for an absent plugin', () => {
  expect(() => build([], { pluginConfig: { absent: {} } })).toThrow('Unknown plugin config: absent')
})
it('rejects removal of the only login provider in an interactive instance', () => {
  expect(() => build([plugin('users', { provides: { identity: '1.x' } })], { interactive: true })).toThrow(/login/i)
})
it('rejects a domain plugin declaring authorization', () => {
  expect(() => build([plugin('domain', { authorization: true, tableFilter: () => ({ kind: 'all' }), commandGuard: () => ({ allow: true }) })])).toThrow(/domain.*permissions/i)
})
it('explicit config without permissions denies API reads and writes', async () => {
  const app = createApp({ ...sample, plugins: [identity, localAuth] } as any, runtime())
  expect(await json(await request(app, '/api/clients'))).toEqual({ data: [], next_cursor: null })
  expect((await request(app, '/api/clients', 'POST', { name: 'denied' })).status).toBe(403)
})
it('orders and namespaces migrations by contracts rather than installation order', () => {
  const kernel = build([
    plugin('domain', { requires: { identity: '^1' }, migrations: [{ name: '001', sql: 'SELECT 2' }] }),
    plugin('users', { provides: { identity: '1.x' }, migrations: [{ name: '001', sql: 'SELECT 1' }] }),
  ])
  expect(kernel.migrations.map(m => m.name)).toEqual(['users/001', 'domain/001'])
})
it('errors when two login plugins claim one request in either order', async () => {
  const users = plugin('users', { provides: { identity: '1.x' } })
  const login = (name: string) => plugin(name, { provides: { login: '1.x' }, requires: { identity: '^1' }, authenticate: () => ({ actor: { type: 'user', id: 'local-user' } }) })
  for (const logins of [[login('local'), login('idp')], [login('idp'), login('local')]]) {
    await expect(build([users, ...logins]).authenticate(new Request('http://localhost'), runtime())).rejects.toMatchObject({ status: 401, code: 'ambiguous_login' })
  }
})
it('applies a per-plugin append-only ledger in dependency order and retains data on uninstall', async () => {
  const users = plugin('users', { provides: { identity: '1.x' }, migrations: [{ name: '001', sql: 'CREATE TABLE plugin_users (id TEXT PRIMARY KEY); INSERT INTO plugin_users VALUES (\'local-user\');' }] })
  const domain = plugin('domain', { requires: { identity: '^1' }, migrations: [{ name: '001', sql: 'CREATE TABLE plugin_domain (user_id TEXT REFERENCES plugin_users(id)); INSERT INTO plugin_domain SELECT id FROM plugin_users;' }] })
  const kernel = build([domain, users])
  await (kernel as any).applyMigrations(env.DB)
  await (kernel as any).applyMigrations(env.DB)
  await (build([]) as any).applyMigrations(env.DB)
  expect(await env.DB.prepare('SELECT user_id FROM plugin_domain').first('user_id')).toBe('local-user')
  expect((await env.DB.prepare("SELECT namespace,name FROM _plugin_migrations WHERE namespace IN ('users','domain') ORDER BY rowid").all()).results).toEqual([{ namespace: 'users', name: '001' }, { namespace: 'domain', name: '001' }])
  await expect((build([{ ...users, migrations: [{ name: '001', sql: 'SELECT 1' }] }]) as any).applyMigrations(env.DB)).rejects.toThrow(/changed/i)
  await expect((build([{ ...users, migrations: [] }]) as any).applyMigrations(env.DB)).rejects.toThrow(/append-only/i)
})
it('rejects a plugin ledger row with a wrong position as an append-only violation', async () => {
  const kernel = build([plugin('position-check', { migrations: [{ name: '001', sql: 'SELECT 1' }] })])
  await kernel.applyMigrations(env.DB)
  // Preserve the name and checksum so only the ledger position is invalid.
  await env.DB.prepare("UPDATE _plugin_migrations SET position=1 WHERE namespace='position-check' AND name='001'").run()
  await expect(kernel.applyMigrations(env.DB)).rejects.toThrow(/append-only/i)
})

it('matches contract majors independently of package versions and orders installed optional providers', () => {
  const optional = plugin('optional', { provides: { organizations: '1.x' } })
  const consumer = plugin('consumer', { optionalRequires: { organizations: '^1' } })
  expect(build([consumer]).plugins.map(p => p.name)).toEqual(['consumer'])
  expect(build([consumer, optional]).plugins.map(p => p.name)).toEqual(['optional', 'consumer'])
  expect(build([plugin('consumer', { requires: { identity: '^1' } }), plugin('users', { provides: { identity: '1.x' } })]).plugins.map(p => p.name)).toEqual(['users', 'consumer'])
})
it.each(['permissions', 'members', 'organizations', 'machine-credentials', 'mail-outbox', 'audit'])('rejects duplicate %s providers', contract => {
  expect(() => build([plugin('one', { provides: { [contract]: '1.x' } }), plugin('two', { provides: { [contract]: '1.x' } })])).toThrow(/duplicate/i)
})
it.each(['1', '^1', '1.0.0', '1.x || 2.x'])('rejects ambiguous provided contract version %s', version => {
  expect(() => build([plugin('users', { provides: { identity: version } })])).toThrow(/contract/i)
})
it('retains SQL strings, comments, CASE and trigger bodies and rolls back a failed migration with its ledger', async () => {
  const migrated = plugin('example', { migrations: [{ name: '001', sql: `
    -- quoted semicolons and trigger bodies are one statement each
    CREATE TABLE [plugin;example] (value TEXT);
    CREATE TABLE plugin_seen (value TEXT);
    CREATE TRIGGER plugin_insert AFTER INSERT ON [plugin;example] BEGIN
      INSERT INTO plugin_seen VALUES (CASE WHEN NEW.value = 'a;b' THEN 'it''s;ok' ELSE 'bad' END);
      INSERT INTO plugin_seen VALUES ('second');
    END;
    INSERT INTO [plugin;example] VALUES ('a;b'); -- trailing comment;
  ` }] })
  await build([migrated]).applyMigrations(env.DB)
  expect((await env.DB.prepare('SELECT value FROM plugin_seen ORDER BY rowid').all()).results).toEqual([{ value: "it's;ok" }, { value: 'second' }])
  const broken = { ...migrated, migrations: [...migrated.migrations!, { name: '002', sql: "INSERT INTO plugin_seen VALUES ('rolled back'); INSERT INTO absent_table VALUES (1);" }] }
  await expect(build([broken]).applyMigrations(env.DB)).rejects.toThrow()
  expect(await env.DB.prepare("SELECT count(*) n FROM plugin_seen WHERE value='rolled back'").first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT count(*) n FROM _plugin_migrations WHERE name='002'").first('n')).toBe(0)
})

it('explicit config without permissions denies MCP reads and writes', async () => {
  const app = createApp({ ...sample, plugins: [identity, localAuth] } as any, runtime())
  const { client, close } = await queryClient(((url: string, init: RequestInit) => {
    const { redirect: _redirect, ...local } = init
    return app.request(url, local)
  }) as typeof fetch, 'synthetic-owner-a')
  try {
    const query = await client.callTool({ name: 'query', arguments: { entity: 'clients', limit: 10 } })
    expect(query.structuredContent).toEqual({ data: [], next_cursor: null })
    const write = await client.callTool({ name: 'create_record', arguments: { entity: 'clients', data: { name: 'denied' } } })
    expect(write.structuredContent).toEqual({ ok: false, code: 'permission_denied', status: 403 })
  } finally { await close() }
})
it('enables permissions through a complete contract provider independently of its object identity or name', () => {
  const permissions = plugin('custom-permissions', { provides: { permissions: '1.x' }, authorization: true, tableFilter: () => ({ kind: 'all' }), commandGuard: () => ({ allow: true }) })
  expect(build([permissions]).permissionsActive).toBe(true)
  expect(build([permissions]).tableFilter('clients', { organizationId: 'org-a', actor: { type: 'user', id: 'owner-a' }, role: 'owner', correlationId: 'contract' })).toEqual({ kind: 'all' })
})

it('F3 ignores inherited contract metadata when deciding permissions authority', () => {
  const inherited = Object.create({ permissions: '1.x' })
  expect(() => build([plugin('inherited', { provides: inherited, authorization: true, tableFilter: () => ({ kind: 'all' }), commandGuard: () => ({ allow: true }) })])).toThrow(/permissions/i)
  const descriptor = Object.create({ provides: { permissions: '1.x' } })
  Object.assign(descriptor, plugin('inherited-descriptor', { authorization: true, tableFilter: () => ({ kind: 'all' }), commandGuard: () => ({ allow: true }) }))
  expect(() => build([descriptor])).toThrow(/permissions/i)
})
it('F3 rejects unsupported permissions majors', () => {
  expect(() => build([plugin('future-permissions', { provides: { permissions: '7.x' }, authorization: true, tableFilter: () => ({ kind: 'all' }), commandGuard: () => ({ allow: true }) })])).toThrow(/permissions.*1\.x/i)
})
it.each(['authorization', 'tableFilter', 'commandGuard'])('F3 rejects a permissions provider missing %s', missing => {
  const provider = plugin('incomplete', { provides: { permissions: '1.x' }, authorization: true, tableFilter: () => ({ kind: 'all' }), commandGuard: () => ({ allow: true }) })
  delete (provider as any)[missing]
  expect(() => build([provider])).toThrow(/permissions/i)
})

it.each([
  'CREATE TRIGGER t AFTER INSERT ON example BEGIN SELECT 1;',
  'SELECT CASE WHEN 1 THEN 2;',
  'BEGIN; SELECT 1; COMMIT;',
  'COMMIT;',
  'SELECT 1; BEGIN TRANSACTION;',
])('F8 rejects malformed blocks and transaction control before preparing a batch: %s', async sql => {
  let batches = 0
  const coreReceipts = await expectedPluginMigrations([])
  const db = { prepare: () => {
    let namespace = ''
    return { run: async () => ({}), bind(value: string) { namespace = value; return this }, all: async () => ({ results: namespace === 'workbase-core' ? coreReceipts : [] }) }
  }, batch: async () => { batches++; return [] } } as unknown as D1Database
  await expect(build([plugin('invalid-sql', { migrations: [{ name: '001', sql }] })]).applyMigrations(db)).rejects.toThrow(/block|transaction/i)
  expect(batches).toBe(0)
})

it('F4 requires an explicit interactive boolean for nonempty plugin compositions', () => {
  const { interactive: _interactive, ...input } = sample
  expect(() => defineInstance(input)).toThrow(/interactive/i)
  expect(() => defineInstance({ ...input, interactive: false })).not.toThrow()
  expect(() => defineInstance({ ...input, interactive: true })).not.toThrow()
  expect(() => defineInstance({ ...input, plugins: [] })).not.toThrow()
})

it.each([
  'CREATE TABLE begin (id TEXT);',
  'CREATE TABLE releases (release TEXT);',
  'CREATE TABLE conflict_test (id TEXT UNIQUE ON CONFLICT ROLLBACK);',
  'CREATE TABLE t (id TEXT, end TEXT)',
])('G3 permits transaction keywords inside valid schema statements: %s', async sql => {
  await build([plugin('keyword-schema', { migrations: [{ name: '001', sql }] })]).applyMigrations(env.DB)
  expect(await env.DB.prepare("SELECT count(*) n FROM _plugin_migrations WHERE namespace='keyword-schema'").first('n')).toBe(1)
})

it.each(['END;', 'ROLLBACK;', 'SAVEPOINT named;', 'RELEASE named;', 'SELECT 1; /* comment */ COMMIT;', '-- comment\nBEGIN TRANSACTION;'])('G3 still rejects statement-leading transaction control: %s', async sql => {
  await expect(build([plugin('transaction', { migrations: [{ name: '001', sql }] })]).applyMigrations(env.DB)).rejects.toThrow(/transaction/i)
})

it('K4 END column references do not close a trigger body', async () => {
  await build([plugin('end-column', { migrations: [{ name: '001', sql: `
    CREATE TABLE source (end TEXT);
    CREATE TABLE seen (value TEXT);
    CREATE TRIGGER copy_end AFTER INSERT ON source BEGIN
      INSERT INTO seen SELECT end FROM source;
      INSERT INTO seen VALUES ('second');
    END /* closing block */;
    INSERT INTO source VALUES ('first');
  ` }] })]).applyMigrations(env.DB)
  expect((await env.DB.prepare('SELECT value FROM seen ORDER BY rowid').all()).results).toEqual([{ value: 'first' }, { value: 'second' }])
})

it.each(['INSERT INTO seen SELECT new.end;', 'INSERT INTO seen SELECT end FROM source ORDER BY end;'])('#46 END identifiers at statement end preserve trigger depth: %s', async statement => {
  await build([plugin('end-identifier', { migrations: [{ name: '001', sql: `
    CREATE TABLE source (end TEXT); CREATE TABLE seen (value TEXT);
    CREATE TRIGGER copy_end AFTER INSERT ON source BEGIN
      ${statement}
      INSERT INTO seen VALUES (CASE WHEN new.end='first' THEN CASE WHEN 1 THEN 'second' END ELSE 'bad' END);
    END;
    INSERT INTO source VALUES ('first');
  ` }] })]).applyMigrations(env.DB)
  expect((await env.DB.prepare('SELECT value FROM seen ORDER BY rowid').all()).results).toEqual([{ value: 'first' }, { value: 'second' }])
})
