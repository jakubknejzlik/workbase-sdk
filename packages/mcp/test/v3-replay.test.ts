import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { appendFile, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from '../src/server'
import { replayBundle } from '../src/offline'

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
    expect(await call('validate', { instance: 'replay-fixture' })).toMatchObject({ ok: true, errors: [] })
    const preview = await call('preview_migration', { proposalId: proposal.proposalId })
    expect(preview).toMatchObject({ ok: true, revision: 2, sql: expect.stringContaining('ADD COLUMN') })
    const verification = await call('apply_to_disposable', { proposalId: proposal.proposalId })
    expect(verification, JSON.stringify(verification)).toMatchObject({ ok: true, verified: true, diffs: [] })
    await appendFile(join(root, 'migrations/0001_r1.sql'), '\nSELECT * FROM missing_domain_source;\n')
    const failure = await call('validate', { proposalId: proposal.proposalId })
    expect(failure).toMatchObject({ ok: false, errors: [{ code: 'migration_replay_failed',
      message: expect.stringMatching(/0001_r1\.sql.*migrations\/0001_r1\.sql.*no such table: missing_domain_source/) }] })
    expect(await call('preview_migration', { proposalId: proposal.proposalId })).toMatchObject({ ok: false,
      error: { code: 'migration_replay_failed', message: expect.stringContaining('0001_r1.sql') } })
  } finally { await client.close(); await transport.close(); await server.close() }
})
