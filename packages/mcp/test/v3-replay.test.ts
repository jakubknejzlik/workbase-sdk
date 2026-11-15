import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { appendFile, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from '../src/server'
import { replayBundle, replayEngine } from '../src/offline'
import { migrateInstance } from '@workbasehq/core/infra'
import { replayQuery } from '../src/migration-replay'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) cleanupTempDir(root) })

it.each(['node', 'bun'])('validates a proposal on a V3 instance created through bootstrap_instance under %s', async runtime => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-v3-replay-')))
  roots.push(root)
  const { server, store } = await createServer({ root })
  const client = new Client({ name: 'v3-replay-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const transport = runtime === 'bun' ? new StdioClientTransport({ command: 'bun', args: ['--no-install', resolve('packages/mcp/src/stdio.ts'), '--root', root], stderr: 'pipe' }) : clientTransport
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
  else await server.connect(serverTransport)
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>
  try {
    expect(await call('bootstrap_instance', { id: 'replay_fixture', target: 'cloudflare-github' })).toMatchObject({ ok: true })
    // Use the current checkout as the installed SDK, then follow the template's
    // documented first step to generate the lock and initial domain migration.
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    const entityPath = join(root, 'schema/worker.ts')
    await writeFile(entityPath, (await readFile(entityPath, 'utf8')).replace('fields: {', "fields: { active: { type: 'bool' }, state: { type: 'enum', values: ['open', 'closed'] },"))
    execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
    const proposal = await call('propose_change', { instance: 'replay-fixture', baseRevision: 1,
      changes: [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }] })
    expect(proposal).toMatchObject({ ok: true, status: 'proposed' })
    const validation = await call('validate', { proposalId: proposal!.proposalId })
    expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true, revision: 2 })
    if (runtime === 'bun') await store.init()
    const bundle = await store.load('replay-fixture')
    expect(bundle.runtime?.plugins?.map(plugin => plugin.name)).toEqual(['identity', 'permissions', 'members', 'organizations', 'local-auth', 'machine-credentials', 'mail-outbox', 'audit', 'console'])
    const namespaces = await replayBundle(bundle, db => db.prepare('SELECT DISTINCT namespace FROM _plugin_migrations ORDER BY namespace').all().map(row => row.namespace))
    expect(namespaces).toEqual(['audit', 'identity', 'machine-credentials', 'mail-outbox', 'members', 'organizations', 'workbase-sdk'])
    expect(await call('inspect_schema', { instance: 'replay-fixture' })).toMatchObject({ ok: true,
      instance_meta: { revision: 1 }, validation: { ok: true, errors: [] } })
    expect(await call('validate', { instance: 'replay-fixture' })).toMatchObject({ ok: true, errors: [] })
    const preview = await call('preview_migration', { proposalId: proposal.proposalId })
    expect(preview).toMatchObject({ ok: true, revision: 2, sql: expect.stringContaining('ADD COLUMN') })
    const verification = await call('apply_to_disposable', { proposalId: proposal.proposalId })
    expect(verification, JSON.stringify(verification)).toMatchObject({ ok: true, verified: true, diffs: [] })
    // Legacy promote must not write a V3 instance (#40 slice 0, #47): the
    // validated proposal is refused before any file is touched.
    const configBefore = await readFile(join(root, 'config.ts'), 'utf8')
    const promotion = await call('promote', { proposalId: proposal.proposalId, expectedRevision: 1 })
    expect(promotion, JSON.stringify(promotion)).toMatchObject({ ok: false, error: { code: 'v3_promote_unsupported' } })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(configBefore)
    const current = await store.load('replay-fixture')
    expect(current.migrations.map(m => m.name)).toEqual(bundle.migrations.map(m => m.name))
    expect(await call('upgrade_sdk', { instance: 'replay-fixture', baseRevision: 1, targetVersion: '0.2.16' })).toMatchObject({ ok: false,
      error: { code: 'v3_sdk_upgrade_unsupported', message: 'SDK upgrade is not supported yet for V3' } })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(configBefore)
    const deploy = new DatabaseSync(':memory:')
    try {
      await migrateInstance(replayQuery(deploy, current.migrations), current.migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') })), replayEngine(current.config, current.runtime).kernel)
      expect(deploy.prepare('SELECT MAX(revision) AS revision FROM instance_meta').get()).toEqual({ revision: 1 })
    } finally { deploy.close() }
    const domainFile = join(root, 'migrations/0001_r1.sql'), domainSQL = await readFile(domainFile, 'utf8')
    for (const drifted of [
      domainSQL + '\nCREATE TABLE unconfigured_table (id TEXT);\n',
      domainSQL.replace(' CHECK ("active" IN (0,1))', ''),
      domainSQL.replace(/ CHECK \("state" IN \([^)]*\)\)/, ''),
      domainSQL + "\nCREATE TRIGGER reject_worker BEFORE INSERT ON worker BEGIN SELECT RAISE(ABORT, 'reject inserts'); END;",
    ]) {
      expect(drifted).not.toBe(domainSQL)
      await writeFile(domainFile, drifted)
      expect(await call('inspect_schema', { instance: 'replay-fixture' })).toMatchObject({ validation: { ok: false, errors: [{ code: 'config_schema_mismatch' }] } })
      expect(await call('validate', { instance: 'replay-fixture' })).toMatchObject({ ok: false, errors: [{ code: 'config_schema_mismatch' }] })
      expect(await call('validate', { proposalId: proposal.proposalId })).toMatchObject({ ok: false, errors: [{ code: 'config_schema_mismatch' }] })
      for (const tool of ['preview_migration', 'apply_to_disposable']) {
        expect(await call(tool, { proposalId: proposal.proposalId })).toMatchObject({ ok: false, error: { code: 'config_schema_mismatch' } })
      }
    }
    await writeFile(domainFile, domainSQL)
    await appendFile(join(root, 'migrations/0001_r1.sql'), '\nSELECT * FROM missing_domain_source;\n')
    const failure = await call('validate', { instance: 'replay-fixture' })
    expect(failure).toMatchObject({ ok: false, errors: [{ code: 'migration_replay_failed',
      message: expect.stringMatching(/0001_r1\.sql.*migrations\/0001_r1\.sql.*SQLite SQL logic error/) }] })

  } finally { await client.close(); await transport.close(); await server.close() }
})
