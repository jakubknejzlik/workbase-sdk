import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from '../src/server.ts'
import { replayEngine } from '../src/offline.ts'
import { replayQuery } from '../src/migration-replay.ts'
import type { Bundle } from '../src/storage.ts'
import { migrateInstance } from '@workbasehq/core/infra'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function deploy(db: DatabaseSync, bundle: Bundle) {
  const files = bundle.migrations.map(m => ({ filename: m.name, sql: m.sql, checksum: createHash('sha256').update(m.sql).digest('hex') }))
  await migrateInstance(replayQuery(db, bundle.migrations), files, replayEngine(bundle.config, bundle.runtime).kernel)
}
it.each(['node', 'bun'])('composes through MCP under %s and deployment preserves existing rows and receipts', async runtime => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-composition-deploy-')); roots.push(root)
  const { server, store, workflow } = await createServer({ root })
  expect(await workflow.call('bootstrap_instance', { id: 'composition_deploy', target: 'cloudflare-github' })).toMatchObject({ ok: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
  execFileSync('bun', [resolve('packages/core/src/openapi/cli.ts'), '--root', root, '--write'], { encoding: 'utf8' })
  // Start with a valid machine-only deployment, then add interactive login.
  const source = await readFile(join(root, 'runtime.ts'), 'utf8')
  await writeFile(join(root, 'runtime.ts'), source.replace('interactive: true', 'interactive: false')
    .replace('createOrganizations({ allowCreate: true }), ', '').replace("createLocalAuth({ methods: ['magic-link'] }),", '')
    .replace('mailOutbox(), ', '').replace('audit(), ', '').replace('consoleUI(),', ''))
  await store.init()
  const initial = await store.load('composition-deploy')
  const db = new DatabaseSync(':memory:')
  const client = new Client({ name: 'composition-deploy', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const transport = runtime === 'bun' ? new StdioClientTransport({ command: 'bun',
    args: ['--no-install', resolve('packages/mcp/src/stdio.ts'), '--root', root], stderr: 'pipe' }) : clientTransport
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
  else await server.connect(serverTransport)
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as any
  try {
    await deploy(db, initial)
    db.exec("INSERT INTO worker (id,organization_id,created_at,updated_at,version,name) VALUES ('worker-1','instance','2026-11-14','2026-11-14',1,'Preserved worker')")
    const rows = db.prepare('SELECT * FROM worker').all()
    const domain = db.prepare('SELECT * FROM _migrations ORDER BY filename').all()
    const baseline = db.prepare('SELECT * FROM _plugin_migrations ORDER BY namespace,position').all()
    const meta = db.prepare('SELECT * FROM instance_meta').all()
    await client.connect(transport)
    const tool = (await client.listTools()).tools.find(t => t.name === 'propose_composition')
    expect(tool?.inputSchema.additionalProperties).toBe(false)
    const result = await call('propose_composition', { instance: 'composition-deploy', baseRevision: 1, changes: [
      { kind: 'set_plugin', plugin: 'organizations', options: { allowCreate: true } },
      { kind: 'set_plugin', plugin: 'local-auth', options: { methods: ['magic-link'] } },
      { kind: 'set_plugin', plugin: 'mail-outbox' },
      { kind: 'set_interactive', interactive: true },
    ] })
    expect(result).toMatchObject({ ok: true, kind: 'composition_change' })
    const proposalId = result.proposalId
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, revision: 1 })
    const target = await store.load('composition-deploy')
    await deploy(db, target)
    expect(db.prepare('SELECT * FROM worker').all()).toEqual(rows)
    expect(db.prepare('SELECT * FROM _migrations ORDER BY filename').all()).toEqual(domain)
    expect(db.prepare('SELECT * FROM instance_meta').all()).toEqual(meta)
    expect(db.prepare('SELECT * FROM _plugin_migrations ORDER BY namespace,position').all()).toEqual(expect.arrayContaining(baseline))
    expect(db.prepare("SELECT DISTINCT namespace FROM _plugin_migrations WHERE namespace IN ('organizations','mail-outbox') ORDER BY namespace").all())
      .toEqual([{ namespace: 'mail-outbox' }, { namespace: 'organizations' }])
    const after = db.prepare('SELECT * FROM _plugin_migrations ORDER BY namespace,position').all()
    await deploy(db, target)
    expect(db.prepare('SELECT * FROM _plugin_migrations ORDER BY namespace,position').all()).toEqual(after)
  } finally { db.close(); await client.close(); await transport.close(); await server.close() }
})
