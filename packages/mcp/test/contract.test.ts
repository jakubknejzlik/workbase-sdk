import { cloneInstanceConfig } from '@workbasehq/core/config'
import { copyHistoricalInstances } from './fixtures'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from '../src/server.ts'
import { stateRoot } from '../src/disposable.ts'
import { createAgentInstance, agentInstance } from '../src/template.ts'
import { configSource, json } from '../src/storage.ts'
import { verifyAgent } from './fixtures/verify-agent.ts'

let root: string
let client: Client
let application: Awaited<ReturnType<typeof createServer>>
const tools = ['bootstrap_instance', 'list_versions', 'rollback', 'inspect_schema', 'upgrade_sdk', 'propose_change', 'validate', 'preview_migration', 'apply_to_disposable', 'promote', 'submit_change', 'discard']
const addition = { kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text' } }
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const result = response.structuredContent as Record<string, any>
  expect(response.isError).toBe(result.ok === false)
  return result
}
async function propose(changes: unknown[] = [addition]) {
  const result = await call('propose_change', { instance: 'sample', baseRevision: 2, changes })
  expect(result.ok).toBe(true)
  return result.proposalId as string
}
async function deploymentHash(instance = 'sample') {
  const dir = join(root, instance === 'quaternary' ? 'instances' : 'examples', instance)
  const paths = (await readdir(dir)).filter(n => /^config.*\.(ts|json)$/.test(n)).map(n => join(dir, n))
  paths.push(...(await readdir(join(dir, 'migrations'))).map(n => join(dir, 'migrations', n)))
  return createHash('sha256').update(JSON.stringify(await Promise.all(paths.sort().map(async p => [p.slice(dir.length), await readFile(p, 'utf8')])))).digest('hex')
}
async function proposalFile(id: string) { return JSON.parse(await readFile(join(root, 'examples/sample/proposals', `${id}.json`), 'utf8')) }
async function connect(allowed?: string[]) {
  application = await createServer({ root, allowed })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'workbase-contract', version: '1.0.0' })
  await application.server.connect(b)
  await client.connect(a)
}
beforeEach(async () => {
  await mkdir(stateRoot, { recursive: true })
  root = await mkdtemp(join(stateRoot, 'contract-'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await copyHistoricalInstances(root)
  await connect()
})
afterEach(async () => { await client?.close(); await application?.server.close(); await rm(root, { recursive: true, force: true }) })

describe('MCP SDK in-memory contract', () => {
  it('inspects the third tertiary instance offline without changing its configuration', async () => {
    const before = await deploymentHash('tertiary')
    const result = await call('inspect_schema', { instance: 'tertiary' })
    expect(result.ok).toBe(true)
    expect(result.roles).toContain('dispatcher')
    expect(Object.keys(result.entities).sort()).toEqual(['bookings', 'clients', 'jobs', 'slots', 'stock_items', 'workers'])
    expect(await deploymentHash('tertiary')).toBe(before)
  })
  it('lists the structured config tools and inspects offline metadata and proposals', async () => {
    const listed = await client.listTools()
    expect(listed.tools.map(t => t.name)).toEqual(tools)
    for (const t of listed.tools) expect(t.inputSchema.additionalProperties).toBe(false)
    const id = await propose()
    const result = await call('inspect_schema', { instance: 'sample' })
    expect(result.revision).toBe(2)
    expect(result.instance_meta.revision).toBe(2)
    expect(result.instance_meta.source).toContain('offline')
    expect(result.entities.jobs.fields.title.type).toBe('string')
    expect(result.pendingProposals).toEqual([expect.objectContaining({ proposalId: id, status: 'proposed' })])
    expect(result.permissions.viewer.jobs).toEqual(['read'])
  })
  it.each(tools)('%s rejects bad/missing input through the SDK', async name => {
    expect((await call(name, { path: '/tmp/forbidden', sql: 'DROP TABLE jobs' })).error.code).toBe('invalid_input')
    expect((await call(name, {})).error.code).toBe('invalid_input')
  })
  it('completes add_field → validate → preview → real disposable D1 → promote', async () => {
    const before = await deploymentHash()
    const serviceBefore = await deploymentHash('secondary')
    const id = await propose()
    expect(await call('validate', { proposalId: id })).toMatchObject({ ok: true, errors: [], revision: 3 })
    const preview = await call('preview_migration', { proposalId: id })
    expect(preview.sql.replaceAll('"', '')).toContain('ALTER TABLE jobs ADD COLUMN notes TEXT')
    expect(preview.configDiff).toContainEqual({ op: 'add', path: '/config/entities/jobs/fields/notes', value: { type: 'text', required: false } })
    expect(await deploymentHash()).toBe(before)
    expect(await call('apply_to_disposable', { proposalId: id })).toEqual({ ok: true, verified: true, diffs: [] })
    expect(await deploymentHash()).toBe(before)
    const promoted = await call('promote', { proposalId: id, expectedRevision: 2 })
    expect(promoted).toMatchObject({ ok: true, revision: 3, appliesToDatabase: false })
    expect(await readFile(join(root, 'examples/sample/migrations', promoted.migration), 'utf8')).toBe(preview.sql)
    expect((await application.store.load('sample')).config.entities.jobs.fields.notes.type).toBe('text')
    expect((await call('inspect_schema', { instance: 'sample' })).revision).toBe(3)
    expect((await proposalFile(id)).status).toBe('promoted')
    expect(await deploymentHash('secondary')).toBe(serviceBefore)
    const log = (await readFile(join(root, 'examples/sample/proposals/log.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s))
    expect(log.filter(r => r.proposalId === id).map(r => r.tool)).toEqual(['propose_change', 'validate', 'preview_migration', 'apply_to_disposable', 'promote'])
  })
  it('stale expectedRevision returns 409 and writes no deployment or proposal files', async () => {
    const id = await propose()
    const before = await deploymentHash(), saved = await proposalFile(id)
    expect(await call('promote', { proposalId: id, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision', status: 409 } })
    expect(await deploymentHash()).toBe(before)
    expect(await proposalFile(id)).toEqual(saved)
  })
  it.each(['journal', 'migration', 'config', 'final', 'historical config', 'existing migration'])('rejects concurrent edits during %s publication and preserves external bytes', async phase => {
    const id = await propose()
    expect((await call('validate', { proposalId: id })).ok).toBe(true)
    expect((await call('apply_to_disposable', { proposalId: id })).verified).toBe(true)
    const dir = await application.store.directory('sample')
    const saved = await proposalFile(id)
    const originalProposal = await readFile(join(dir, 'proposals', `${id}.json`))
    const originalFiles = await readdir(join(dir, 'migrations'))
    const originalMigrations = await Promise.all(originalFiles.map(name => readFile(join(dir, 'migrations', name))))
    const configFiles = (await readdir(dir)).filter(name => /^config.*\.(ts|json)$/.test(name)).sort()
    const configBytes = await Promise.all(configFiles.map(name => readFile(join(dir, name))))
    const guardOnly = ['historical config', 'existing migration'].includes(phase)
    const originalConfig = await readFile(join(dir, 'config.ts'), 'utf8')
    const config = cloneInstanceConfig((await application.store.load('sample')).config)
    config.permissions.viewer.jobs = []
    const target = phase === 'historical config' ? join(dir, 'config.v2.ts')
      : phase === 'existing migration' ? join(dir, 'migrations/0001_initial.sql') : join(dir, 'config.ts')
    const external = phase === 'historical config' ? (await readFile(target, 'utf8')) + '\n// external edit\n'
      : phase === 'existing migration' ? (await readFile(target, 'utf8')) + '\n-- external edit\n' : configSource(config)
    const link = fs.link
    let injected = false
    const stub = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      const destination = String(to)
      const publication = phase === 'migration' ? /\/migrations\/\d{4}_add_field_/.test(destination)
        : phase === 'config' ? destination === join(dir, 'config.ts')
        : phase === 'final' ? destination === join(dir, 'proposals', `${id}.json`)
        : destination === join(dir, 'proposals/.promotion.json')
      // Journal probe edits before journal publication; later probes edit after our no-replace install.
      if (publication && !injected && !['migration', 'config', 'final'].includes(phase)) {
        injected = true; await writeFile(target, external)
      }
      await link(from, to)
      if (publication && !injected) { injected = true; await writeFile(target, external) }
    })
    syncBuiltinESMExports()
    try {
      const result = await call('promote', { proposalId: id, expectedRevision: 2 })
      expect(injected, JSON.stringify(result)).toBe(true)
      expect(result).toMatchObject({ ok: false, error: { code: 'concurrent_modification', status: 409 } })
      if (guardOnly) expect(result.error.message).toContain(target.slice(dir.length + 1))
    } finally { stub.mockRestore(); syncBuiltinESMExports() }
    expect(injected).toBe(true)
    expect(await readFile(target, 'utf8')).toBe(external)
    if (target !== join(dir, 'config.ts')) expect(await readFile(join(dir, 'config.ts'), 'utf8')).toBe(originalConfig)
    expect(await readdir(join(dir, 'migrations'))).toEqual(originalFiles)
    expect(await proposalFile(id)).toEqual(saved)
    expect(await readFile(join(dir, 'proposals', `${id}.json`))).toEqual(originalProposal)
    for (const [index, name] of originalFiles.entries()) {
      if (join(dir, 'migrations', name) !== target) expect(await readFile(join(dir, 'migrations', name))).toEqual(originalMigrations[index])
    }
    expect((await readdir(dir)).filter(name => /^config.*\.(ts|json)$/.test(name)).sort()).toEqual(configFiles)
    for (const [index, name] of configFiles.entries()) {
      if (join(dir, name) !== target) expect(await readFile(join(dir, name))).toEqual(configBytes[index])
    }
    if (guardOnly) {
      // Guard drift leaves no rollback conflict on the transaction's own writes.
      expect((await readdir(join(dir, 'proposals'))).sort()).toEqual([`${id}.json`, 'log.jsonl'].sort())
    } else {
      const journal = await readFile(join(dir, 'proposals/.promotion.json'), 'utf8')
      const marker = `.promotion.json.conflict-${createHash('sha256').update(journal).digest('hex').slice(0, 16)}`
      expect(await readFile(join(dir, 'proposals', marker), 'utf8')).toBe(journal)
      const entries = await readdir(join(dir, 'proposals'))
      const retained = JSON.parse(journal).files.flatMap((file: { path: string; stage: string; before: string | null; capture?: { token: string } }) => [
        `.promotion-${file.stage}.tmp`,
        ...(file.capture && file.path.startsWith('proposals/') ? [`${file.path.slice('proposals/'.length)}.${file.capture.token}.tmp`] : []),
      ]).filter((name: string) => entries.includes(name))
      expect(entries.sort()).toEqual([`${id}.json`, 'log.jsonl', '.promotion.json', marker, ...retained].sort())
      for (const file of JSON.parse(journal).files) if (file.capture && file.path.startsWith('proposals/')) {
        const temporary = join(dir, `${file.path}.${file.capture.token}.tmp`)
        const captured = await readFile(temporary).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (captured) expect(captured).toEqual(Buffer.from(file.before, 'base64'))
      }
      await expect(application.store.recover(dir)).rejects.toMatchObject({ code: 'concurrent_modification' })
    }
    expect(await readdir(dir)).not.toContain('config.indexes.json')
  })
  it('rejects a non-existent rename at validate and leaves the git instance clean', async () => {
    await writeFile(join(root, '.gitignore'), 'node_modules/\ninstances/*/proposals/\nexamples/*/proposals/\n')
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    git(['init', '--quiet']); git(['add', 'instances', 'examples', '.gitignore', 'package.json'])
    git(['-c', 'user.name=MCP contract', '-c', 'user.email=mcp@example.test', 'commit', '--quiet', '-m', 'fixture'])
    const before = await deploymentHash()
    const id = await propose([{ kind: 'rename_field', entity: 'jobs', from: 'missing', to: 'title2' }])
    expect(await call('validate', { proposalId: id })).toMatchObject({ ok: false, errors: [{ code: 'unknown_field' }] })
    expect(await deploymentHash()).toBe(before)
    expect(git(['status', '--porcelain', '--', 'examples/sample'])).toBe('')
    expect((await proposalFile(id)).validation).toBeUndefined()
    expect((await call('apply_to_disposable', { proposalId: id })).ok).toBe(false)
    expect(git(['status', '--porcelain', '--', 'examples/sample'])).toBe('')
  })
  it.each(['drop_field', 'drop_entity', 'change_type'])('rejects destructive %s at propose', async kind => {
    const before = await deploymentHash()
    const result = await call('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ kind, entity: 'jobs', field: 'title', type: 'int' }] })
    expect(result.error.code).toBe('invalid_input')
    expect(await deploymentHash()).toBe(before)
    expect((await readdir(join(root, 'examples/sample/proposals'))).filter(n => n.endsWith('.json'))).toEqual([])
  })
  it.each([['jobs', 'id'], ['jobs', 'organization_id'], ['jobs', 'created_at'], ['jobs', 'updated_at'], ['jobs', 'version'], ['slots', 'capacity'], ['slots', 'booked'], ['bookings', 'status'], ['workers', 'name'], ['slots', 'worker_id'], ['slots', 'job_id'], ['jobs', 'client_id']])('protects %s.%s at propose', async (entity, field) => {
    expect((await call('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ kind: 'rename_field', entity, from: field, to: 'renamed' }] })).error.code).toBe('protected_field')
  })
  it('rejects unknown instances, path traversal, raw SQL and arbitrary proposal IDs', async () => {
    expect((await call('inspect_schema', { instance: 'unlisted' })).error.code).toBe('instance_not_allowed')
    expect((await call('inspect_schema', { instance: '../sample' })).error.code).toBe('invalid_input')
    expect((await call('validate', { proposalId: '../../config.ts' })).error.code).toBe('invalid_input')
    expect((await call('validate', { proposalId: crypto.randomUUID() })).error.code).toBe('proposal_not_found')
    expect((await call('execute_sql', { sql: 'SELECT 1' })).error.code).toBe('unknown_tool')
  })
  it('requires validate and verified D1 evidence; discard closes a proposal', async () => {
    const id = await propose()
    expect((await call('promote', { proposalId: id, expectedRevision: 2 })).error.code).toBe('validation_required')
    expect((await call('apply_to_disposable', { proposalId: id })).error.code).toBe('validation_required')
    expect((await call('validate', { proposalId: id })).ok).toBe(true)
    expect((await call('promote', { proposalId: id, expectedRevision: 2 })).error.code).toBe('verification_required')
    expect((await call('discard', { proposalId: id })).status).toBe('discarded')
    expect((await call('validate', { proposalId: id })).error.code).toBe('proposal_closed')
  })
  it('rejects invalid enum/default/required additions without a partial config update', async () => {
    const before = await deploymentHash()
    for (const definition of [{ type: 'enum' }, { type: 'int', default: 'bad' }, { type: 'text', required: true }]) {
      const id = await propose([{ ...addition, definition }])
      expect((await call('validate', { proposalId: id })).ok).toBe(false)
    }
    expect(await deploymentHash()).toBe(before)
  })
  it('invalidates validation when proposal contents change', async () => {
    const id = await propose()
    expect((await call('validate', { proposalId: id })).ok).toBe(true)
    const p = await proposalFile(id); p.changes[0].field = 'other_notes'
    await writeFile(join(root, 'examples/sample/proposals', `${id}.json`), json(p))
    expect((await call('apply_to_disposable', { proposalId: id })).error.code).toBe('validation_required')
  })
  it('recovers an interrupted promotion from its journal before inspecting', async () => {
    const path = join(root, 'examples/sample/config.ts')
    const before = await readFile(path, 'utf8')
    const originalMigrations = (await readdir(join(root, 'examples/sample/migrations'))).length
    await writeFile(join(root, 'examples/sample/proposals/.promotion.json'), json({ files: [{ path: 'config.ts', before }, { path: 'migrations/0099_incomplete.sql', before: null }] }))
    await writeFile(path, 'broken incomplete promotion')
    await writeFile(join(root, 'examples/sample/migrations/0099_incomplete.sql'), 'invalid')
    expect((await call('inspect_schema', { instance: 'sample' })).revision).toBe(2)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readdir(join(root, 'examples/sample/migrations'))).toHaveLength(originalMigrations)
  })
  it('uses an exclusive cross-process instance lock', async () => {
    await mkdir(join(root, 'examples/sample/proposals/.lock'))
    expect((await call('inspect_schema', { instance: 'sample' })).error).toMatchObject({ code: 'instance_busy', status: 409 })
  })
  it('refuses symlinked instance migrations', async () => {
    const path = join(root, 'examples/sample/migrations/0001_initial.sql')
    await rm(path)
    await symlink(resolve('packages/mcp/test/fixtures/template/migrations/0001_initial.sql'), path)
    expect((await call('inspect_schema', { instance: 'sample' })).error.code).toBe('unsafe_path')
  })


  it('verifies entities, relations, indexes, renames and required defaults across two promotions', async () => {
    const changes = [
      { kind: 'add_entity', entity: 'materials', fields: { label: { type: 'text' }, job_id: { type: 'ref', entity: 'jobs' }, client_id: { type: 'ref', entity: 'clients' } } },
      { kind: 'add_relation', entity: 'materials', name: 'job', field: 'job_id', target: 'jobs' },
      { kind: 'add_relation', entity: 'jobs', name: 'customer', field: 'client_id', target: 'clients' },
      { kind: 'add_index', entity: 'materials', name: 'materials_label_idx', fields: ['label'] },
      { kind: 'rename_field', entity: 'jobs', from: 'title', to: 'summary' },
    ]
    const first = await propose(changes)
    expect((await call('validate', { proposalId: first })).ok).toBe(true)
    expect((await call('apply_to_disposable', { proposalId: first })).verified).toBe(true)
    expect((await call('promote', { proposalId: first, expectedRevision: 2 })).revision).toBe(3)
    const second = await call('propose_change', { instance: 'sample', baseRevision: 3, changes: [
      { kind: 'rename_field', entity: 'materials', from: 'label', to: 'description' },
      { kind: 'rename_field', entity: 'materials', from: 'job_id', to: 'project_id' },
      { kind: 'add_field', entity: 'jobs', field: 'contact_note', definition: { type: 'text', required: true, default: 'n/a' } },
    ] })
    const proposalId = second.proposalId
    expect(second.ok).toBe(true)
    expect((await call('validate', { proposalId })).ok).toBe(true)
    expect((await call('apply_to_disposable', { proposalId })).verified).toBe(true)
    expect((await call('promote', { proposalId, expectedRevision: 3 })).revision).toBe(4)
    const inspected = await call('inspect_schema', { instance: 'sample' })
    expect(inspected.indexes).toEqual([{ entity: 'materials', name: 'materials_label_idx', fields: ['description'] }])
    expect(inspected.entities.materials.relations.job).toEqual({ field: 'project_id', entity: 'jobs' })
    expect(inspected.entities.jobs.fields.contact_note).toMatchObject({ required: true, default: 'n/a' })
    expect((await call('discard', { proposalId })).error.code).toBe('already_promoted')
  })
  it('preserves the core block on required reference columns added to existing tables', async () => {
    const before = await deploymentHash()
    const id = await propose([
      { kind: 'add_field', entity: 'jobs', field: 'worker_id', definition: { type: 'ref', entity: 'workers', required: true } },
      { kind: 'add_relation', entity: 'jobs', name: 'assignee', field: 'worker_id', target: 'workers' },
    ])
    expect(await call('validate', { proposalId: id })).toMatchObject({ ok: false, errors: [{ code: 'migration_blocked', message: expect.stringContaining('Required added reference') }] })
    expect(await deploymentHash()).toBe(before)
  })
  it('fails a real D1 apply without partial deployment and removes disposable state', async () => {
    // SQLite permits this locally, while D1 forbids explicit transaction statements.
    const migration = join(root, 'examples/sample/migrations/0001_initial.sql')
    await writeFile(migration, (await readFile(migration, 'utf8')) + '\nBEGIN; COMMIT;\n')
    const before = await deploymentHash()
    const stateBefore = (await readdir(stateRoot)).sort()
    const id = await propose()
    expect((await call('validate', { proposalId: id })).ok).toBe(true)
    const result = await call('apply_to_disposable', { proposalId: id })
    expect(result).toMatchObject({ ok: false, verified: false, diffs: [{ code: 'disposable_apply_failed' }] })
    expect(await deploymentHash()).toBe(before)
    expect((await readdir(stateRoot)).sort()).toEqual(stateBefore)
    expect((await proposalFile(id)).verification).toBeUndefined()
    expect((await call('promote', { proposalId: id, expectedRevision: 2 })).error.code).toBe('verification_required')
  })
  it('keeps a verified disposable only when explicitly requested', async () => {
    const id = await propose()
    expect((await call('validate', { proposalId: id })).ok).toBe(true)
    const result = await call('apply_to_disposable', { proposalId: id, keep: true })
    try {
      expect(result).toMatchObject({ ok: true, verified: true, diffs: [] })
      expect(result.directory.startsWith(join(stateRoot, 'proposal-'))).toBe(true)
      expect(await readdir(result.directory)).toContain('persist')
    } finally { if (result.directory) await rm(result.directory, { recursive: true, force: true }) }
  })
  it('an old verified proposal never overwrites a newer promoted revision', async () => {
    const first = await propose(), old = await propose([{ ...addition, field: 'description' }])
    for (const id of [first, old]) {
      expect((await call('validate', { proposalId: id })).ok).toBe(true)
      expect((await call('apply_to_disposable', { proposalId: id })).verified).toBe(true)
    }
    expect((await call('promote', { proposalId: first, expectedRevision: 2 })).revision).toBe(3)
    const before = await deploymentHash(), saved = await proposalFile(old)
    for (const expectedRevision of [2, 3]) expect((await call('promote', { proposalId: old, expectedRevision })).error).toMatchObject({ code: 'stale_revision', status: 409 })
    expect(await deploymentHash()).toBe(before)
    expect(await proposalFile(old)).toEqual(saved)
  })
  it('reloads transitive versioned config edits before checking a stale revision', async () => {
    const id = await propose()
    const path = join(root, 'examples/sample/config.v2.ts')
    await writeFile(path, (await readFile(path, 'utf8')).replace('"revision": 2', '"revision": 3'))
    const before = await deploymentHash()
    expect((await call('promote', { proposalId: id, expectedRevision: 2 })).error).toMatchObject({ code: 'stale_revision', status: 409 })
    expect(await deploymentHash()).toBe(before)
  })
  it('rejects changed migrations even when the revision number did not change', async () => {
    const id = await propose()
    expect((await call('validate', { proposalId: id })).ok).toBe(true)
    const migration = join(root, 'examples/sample/migrations/0001_initial.sql')
    await writeFile(migration, (await readFile(migration, 'utf8')) + '\n-- changed externally\n')
    expect((await call('apply_to_disposable', { proposalId: id })).error.code).toBe('validation_required')
  })
  it('logs rejected calls without caller arguments or defaults', async () => {
    const secret = 'synthetic-private-default@example.test'
    expect((await call('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ ...addition, definition: { type: 'text', default: secret } }] })).ok).toBe(true)
    expect((await call('inspect_schema', { instance: 'sample', password: secret })).ok).toBe(false)
    const content = await readFile(join(root, 'examples/sample/proposals/log.jsonl'), 'utf8')
    expect(content).not.toContain(secret)
    expect(content.trim().split('\n').map(s => JSON.parse(s).tool)).toEqual(['propose_change', 'inspect_schema'])
  })
  it('audits null, array and numeric arguments and returns structured invalid_input errors', async () => {
    const before = await deploymentHash()
    await call('inspect_schema', { instance: 'sample' })
    const path = join(root, 'examples/sample/proposals/log.jsonl')
    const count = (await readFile(path, 'utf8')).trim().split('\n').length
    for (const args of [null, [], 42]) {
      const response = await client.callTool({ name: 'inspect_schema', arguments: args } as any)
      expect(response.isError).toBe(true)
      expect(response.structuredContent).toMatchObject({ ok: false, error: { code: 'invalid_input', status: 400 } })
    }
    const log = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(log).toHaveLength(count + 3)
    expect(new Set(log.map(row => row.callId)).size).toBe(log.length)
    for (const row of log.slice(-3)) {
      expect(Object.keys(row).sort()).toEqual(['timestamp', 'callId', 'tool'].sort())
      expect(row.tool).toBe('inspect_schema')
      expect(Number.isFinite(Date.parse(row.timestamp))).toBe(true)
      expect(row.callId).toMatch(/^[a-f0-9-]{36}$/)
    }
    expect(await deploymentHash()).toBe(before)
    expect((await readdir(join(root, 'examples/sample/proposals'))).sort()).toEqual(['log.jsonl'])
  })
  it('creates the real-model fixture only from a fixed template and restricts its allowlist', async () => {
    await mkdir(join(root, 'packages/mcp/test/fixtures'), { recursive: true })
    await cp(resolve('packages/mcp/test/fixtures/template'), join(root, 'packages/mcp/test/fixtures/template'), { recursive: true })
    const before = await deploymentHash()
    expect(await createAgentInstance(root)).toBe(agentInstance)
    expect(await createAgentInstance(root)).toBe(agentInstance)
    await client.close(); await application.server.close(); await connect([agentInstance])
    expect((await call('inspect_schema', { instance: 'sample' })).error.code).toBe('instance_not_allowed')
    expect((await call('inspect_schema', { instance: agentInstance })).revision).toBe(3)
    const proposed = await call('propose_change', { instance: agentInstance, baseRevision: 3, changes: [addition] })
    const proposalId = proposed.proposalId
    expect(proposed.ok).toBe(true)
    expect((await call('validate', { proposalId })).ok).toBe(true)
    expect((await call('preview_migration', { proposalId })).ok).toBe(true)
    expect((await call('apply_to_disposable', { proposalId })).verified).toBe(true)
    expect((await call('promote', { proposalId, expectedRevision: 3 })).revision).toBe(4)
    expect(await verifyAgent(root)).toMatchObject({ ok: true, revision: 4 })
    await mkdir(join(root, 'packages/mcp/test/fixtures'), { recursive: true })
    await cp(resolve('packages/mcp/test/fixtures/verify-agent.ts'), join(root, 'packages/mcp/test/fixtures/verify-agent.ts'))
    const verified = execFileSync(process.execPath, ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'), join(root, 'packages/mcp/test/fixtures/verify-agent.ts')], { encoding: 'utf8' })
    expect(JSON.parse(verified)).toMatchObject({ ok: true, revision: 4 })
    const configPath = join(root, 'examples', agentInstance, 'config.ts')
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('"revision": 4', '"revision": 5'))
    await expect(verifyAgent(root)).rejects.toThrow('Revision must increase exactly once')
    expect(await deploymentHash()).toBe(before)
  })
})
