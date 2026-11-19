import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadConfig } from '@workbasehq/core/schema/load'
import { checkLinkage } from '@workbasehq/core/migrations/schema-plan'
import { createServer } from '../src/server'
import { replayBundle } from '../src/offline'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const constraint = { kind: 'unique', name: 'worker_name_unique', fields: ['name', 'code'] }
async function fixture(duplicates = false) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-constraints-')); roots.push(root)
  const { server, workflow, store } = await createServer({ root })
  expect(await workflow.call('bootstrap_instance', { id: 'constraint_fixture', target: 'cloudflare-github' })).toMatchObject({ ok: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  const entityPath = join(root, 'schema/worker.ts')
  await writeFile(entityPath, (await readFile(entityPath, 'utf8')).replace('fields: {', "fields: { code: { type: 'text' },"))
  execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
  await writeFile(join(root, 'runtime.ts'), `import { identity } from '@workbasehq/plugins/identity'
import { permissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import config from './config'
export default { ...config, plugins: [identity, permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }), members] }
`)
  if (duplicates) {
    // Reviewed data in the committed bundle must be replayed before adding uniqueness.
    const { parseBundle, renderBundle, manualEvidence } = await import('../../core/src/migrations/schema-bundle')
    const path = join(root, 'migrations/0001_r1.sql')
    const bundle = parseBundle('0001_r1.sql', await readFile(path, 'utf8'))
    bundle.post = `INSERT INTO organizations VALUES ('org','Org');
INSERT INTO worker (id,organization_id,name,code,created_at,updated_at) VALUES ('one','org','Duplicate','same','now','now'),('two','org','Duplicate','same','now','now');\n`
    bundle.manual = await manualEvidence(bundle)
    await writeFile(path, renderBundle(bundle))
  }
  execFileSync('bun', [resolve('packages/core/src/openapi/cli.ts'), '--root', root, '--write'], { encoding: 'utf8' })
  execFileSync('bun', ['run', 'access:lock'], { cwd: root, encoding: 'utf8' })
  await store.init()
  const call = (name: string, args: Record<string, unknown>) => workflow.call(name, args) as Promise<any>
  const propose = (constraints: unknown[] = [constraint]) => call('propose_change', { instance: 'constraint-fixture', baseRevision: 1, changes: [{ kind: 'set_constraints', entity: 'worker', constraints }] })
  return { root, server, store, call, propose }
}
it('authors V3 constraints through validate, preview, disposable D1 and promote, including removal', async () => {
  const { root, server, store, call, propose } = await fixture()
  try {
    const baseLock = await readFile(join(root, 'schema.lock.json'), 'utf8')
    const baseSql = await readFile(join(root, 'migrations/0001_r1.sql'), 'utf8')
    const source = '// keep header\r\n' + await readFile(join(root, 'schema/worker.ts'), 'utf8') + '\n// keep footer\n'
    await writeFile(join(root, 'schema/worker.ts'), source)
    const result = await propose()
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, kind: 'schema_change' })
    expect(await call('propose_change', { instance: 'constraint-fixture', baseRevision: 1, changes: [{ kind: 'set_constraints', entity: 'worker', constraints: [constraint] }, { kind: 'add_index', entity: 'worker', name: 'name_idx', fields: ['name'] }] })).toMatchObject({ ok: false, error: { code: 'mixed_change_kinds' } })
    expect(await call('propose_change', { instance: 'constraint-fixture', baseRevision: 1, changes: [{ kind: 'set_constraints', entity: 'missing', constraints: [constraint] }] })).toMatchObject({ ok: false, error: { code: 'unknown_entity' } })
    const { proposalId } = result
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false })
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true, revision: 2 })
    const preview = await call('preview_migration', { proposalId })
    expect(preview).toMatchObject({ ok: true, revision: 2, sql: expect.stringContaining('CREATE UNIQUE INDEX') })
    expect(preview.sql).toContain('("organization_id", "name", "code")')
    expect(preview.sql).not.toContain('CREATE TABLE')
    expect(await readFile(join(root, 'schema/worker.ts'), 'utf8')).toBe(source)
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 2, appliesToDatabase: false })
    expect(await readFile(join(root, 'schema/worker.ts'), 'utf8')).toMatch(/^\/\/ keep header\r\n/)
    expect(await readFile(join(root, 'schema/worker.ts'), 'utf8')).toMatch(/\/\/ keep footer\n$/)
    const loaded = await loadConfig(join(root, 'config.ts'))
    expect(loaded.config.entities.worker.constraints).toEqual([constraint])
    const lock = await readFile(join(root, 'schema.lock.json'), 'utf8')
    expect(JSON.parse(lock)).toMatchObject({ lockVersion: 3, revision: 2, tables: [expect.objectContaining({ constraints: [constraint] })] })
    const sql = await readFile(join(root, 'migrations/0002_r2.sql'), 'utf8')
    await checkLinkage(baseLock, { '0001_r1.sql': baseSql }, lock, { '0001_r1.sql': baseSql, '0002_r2.sql': sql })
    await replayBundle(await store.load('constraint-fixture'), db => {
      db.exec("INSERT INTO organizations VALUES ('org','Org'),('different','Other')")
      db.exec("INSERT INTO worker (id,organization_id,name,code,created_at,updated_at) VALUES ('a','org','Unique','same','now','now')")
      db.exec("INSERT INTO worker (id,organization_id,name,code,created_at,updated_at) VALUES ('other','org','Unique','other','now','now'),('tenant','different','Unique','same','now','now')")
      expect(() => db.exec("INSERT INTO worker (id,organization_id,name,code,created_at,updated_at) VALUES ('b','org','Unique','same','now','now')")).toThrow(/UNIQUE/)
    })
    for (const script of ['check:schema', 'check:access', 'check:openapi']) expect(execFileSync('bun', ['run', script], { cwd: root, encoding: 'utf8' })).toContain(script + ':')
    expect(await call('submit_change', { instance: 'constraint-fixture', proposalId, expectedBaseSha: 'a'.repeat(40) })).toMatchObject({ ok: false, error: { code: 'github_not_configured' } })
    expect(await call('propose_change', { instance: 'constraint-fixture', baseRevision: 2, changes: [{ kind: 'set_constraints', entity: 'worker', constraints: [{ ...constraint, fields: ['name'] }] }] })).toMatchObject({ ok: false, error: { code: 'invalid_schema', message: expect.stringContaining('use a new name') } })
    const removal = await call('propose_change', { instance: 'constraint-fixture', baseRevision: 2, changes: [{ kind: 'set_constraints', entity: 'worker', constraints: [] }] })
    expect(removal).toMatchObject({ ok: true })
    expect(await call('validate', { proposalId: removal.proposalId })).toMatchObject({ ok: true, revision: 3 })
    expect(await call('preview_migration', { proposalId: removal.proposalId })).toMatchObject({ sql: expect.stringContaining('DROP INDEX') })
    expect(await call('apply_to_disposable', { proposalId: removal.proposalId })).toMatchObject({ ok: true, verified: true })
    expect(await call('promote', { proposalId: removal.proposalId, expectedRevision: 2 })).toMatchObject({ ok: true, revision: 3 })
    expect(await call('propose_change', { instance: 'constraint-fixture', baseRevision: 3, changes: [{ kind: 'set_constraints', entity: 'worker', constraints: [] }] })).toMatchObject({ ok: false, error: { code: 'no_schema_change' } })
  } finally { await server.close() }
})
it.each([
  [[{ ...constraint, fields: ['missing'] }], 'Unknown constraint field'],
  [[{ ...constraint, fields: ['name', 'name'] }], 'distinct'],
  [[constraint, constraint], 'Duplicate constraint name'],
  [[{ ...constraint, fields: ['id'] }], 'Unknown constraint field'],
  [[{ ...constraint, where: '1=1' }], 'Input does not match'],
])('rejects invalid constraint inputs without editing sources: %j', async (constraints, message) => {
  const { root, server, propose } = await fixture()
  try {
    const source = await readFile(join(root, 'schema/worker.ts'), 'utf8')
    const result = await propose(constraints)
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(message) } })
    expect(result.error.code).not.toBe('internal_error')
    expect(await readFile(join(root, 'schema/worker.ts'), 'utf8')).toBe(source)
  } finally { await server.close() }
})
it.each(['schema/worker.ts', 'schema.lock.json'])('rejects stale proposal evidence after changing %s', async path => {
  const { root, server, call, propose } = await fixture()
  try {
    const result = await propose(); expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    const { proposalId } = result
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true })
    const original = await readFile(join(root, path), 'utf8')
    await writeFile(join(root, path), original + '\n')
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    await writeFile(join(root, path), 'malformed source or lock')
    expect(await call('validate', { proposalId })).toMatchObject({ ok: false })
    await writeFile(join(root, path), original)
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  } finally { await server.close() }
})
it.each(['validate', 'apply_to_disposable'])('revokes saved authorization when config disappears before %s', async action => {
  const { root, server, call, propose } = await fixture()
  try {
    const result = await propose(); expect(result).toMatchObject({ ok: true })
    const { proposalId } = result
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
    const path = join(root, 'config.ts')
    const config = await readFile(path)
    await rm(path)
    expect(await call(action, { proposalId })).toMatchObject({ ok: false, error: { code: 'invalid_instance_directory' } })
    await writeFile(path, config)
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({
      ok: false, error: { code: action === 'validate' ? 'validation_required' : 'verification_required' },
    })
    const saved = JSON.parse(await readFile(join(root, 'proposals', `${proposalId}.json`), 'utf8'))
    expect(saved.verification).toBeUndefined()
    expect(saved.status).toBe(action === 'validate' ? 'proposed' : 'validated')
    if (action === 'validate') expect(saved.validation).toBeUndefined()
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'verification_required' } })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted' })
  } finally { await server.close() }
})
it('rejects existing duplicate data reviewably and cannot promote failed validation', async () => {
  const { root, server, call, propose } = await fixture(true)
  try {
    const source = await readFile(join(root, 'schema/worker.ts'), 'utf8')
    const result = await propose(); expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expect(await call('validate', { proposalId: result.proposalId })).toMatchObject({ ok: false, error: { status: 422, message: expect.stringContaining('UNIQUE constraint failed') } })
    expect(await call('promote', { proposalId: result.proposalId, expectedRevision: 1 })).toMatchObject({ ok: false })
    expect(await readFile(join(root, 'schema/worker.ts'), 'utf8')).toBe(source)
  } finally { await server.close() }
})

it('keeps legacy add_index non-unique and refuses unique/predicate flags', async () => {
  const { schemas } = await import('../src/schemas')
  const { prepare } = await import('../src/planning')
  const { sample: config } = await import('./fixtures/model')
  const change = { kind: 'add_index' as const, entity: 'clients', name: 'clients_name_idx', fields: ['name'] }
  const input = { instance: 'example', baseRevision: 1, changes: [{ ...change, fields: [...change.fields] }] }
  expect(schemas.propose_change.safeParse(input).success).toBe(true)
  for (const extra of [{ unique: true }, { where: '1=1' }]) expect(schemas.propose_change.safeParse({ ...input, changes: [{ ...input.changes[0], ...extra }] }).success).toBe(false)
  const planned = prepare(config, [], input.changes)
  expect(planned.sql).toContain('CREATE INDEX "clients_name_idx" ON "clients" ("organization_id", "name")')
  expect(planned.sql).not.toContain('CREATE UNIQUE INDEX')
})

it('keeps the MCP wire shape compatible with the shared constraint contract', async () => {
  const { schemaChangeSchema } = await import('../src/schemas')
  const { declarationSchema } = await import('@workbasehq/core/schema')
  const shared = declarationSchema.shape.constraints.unwrap()
  for (const constraints of [[constraint], [], Array.from({ length: 33 }, () => constraint), [{ ...constraint, fields: Array(17).fill('name') }], [{ ...constraint, where: '1=1' }], [{ ...constraint, kind: 'partial_unique' }]]) {
    expect(schemaChangeSchema.safeParse({ kind: 'set_constraints', entity: 'worker', constraints }).success).toBe(shared.safeParse(constraints).success)
  }
})
