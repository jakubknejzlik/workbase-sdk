import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { z } from 'zod'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { createCommandRegistry, defineCommand } from '../src/commands'
import { refImmutableViolation, constraintError } from '../src/constraint-errors'
import { refImmutableToken } from '../src/entity-constraints'
import { checkEntityConstraints } from '../src/kernel/schema-check'
import { json, request, runtime, setup, insertDomain } from '@workbasehq/test-support/helpers'

const constraint = { kind: 'ref_immutable' as const, name: 'job_client_locked', field: 'client_id', referencedBy: { entity: 'reservation', field: 'location' } }
const config = defineInstance({ ...sample, entities: { ...sample.entities, jobs: { ...sample.entities.jobs, constraints: [constraint] },
  reservation: { displayField: 'id', fields: { client: { type: 'ref', entity: 'clients' }, location: { type: 'ref', entity: 'jobs' } } } },
  policies: { ...sample.policies, reservation: { owner: 'all', dispatcher: 'all', viewer: 'all' } },
  permissions: Object.fromEntries(sample.roles.map(role => [role, { ...sample.permissions[role], reservation: role === 'viewer' ? ['read' as const] : ['read' as const, 'create' as const, 'update' as const, 'delete' as const] }])), commands: [...sample.commands, 'reservation/relocate'],
})
// Atomic write: domain row, audit outbox and idempotency receipt must all roll back with the failing statement.
const operation = defineCommand({ name: 'reservation/relocate', permission: { entity: 'reservation', operation: 'create' }, idempotency: 'required', input: z.strictObject({ client: z.string() }),
  plan: (ctx, input) => ({ rules: [{ name: 'relocate', statements: [
    { sql: 'INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', bindings: [ctx.newId, ctx.scope.organizationId, 'rolled back', ctx.now, ctx.now], expectRows: 1 },
    { sql: 'UPDATE jobs SET client_id = ? WHERE id = ? AND organization_id = ?', bindings: [input.client, 'job-org-a', ctx.scope.organizationId], expectRows: 1 },
  ] }], result: { status: 200, body: {} }, event: { entity: 'jobs', entityId: 'job-org-a', operation: 'jobs.updated' } }),
})
const snapshot = async () => Promise.all(['reservation', 'clients', 'jobs', 'audit_outbox', 'idempotency_keys', 'atomic_assert'].map(table => env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(r => r.results)))
const conflict = { error: 'ref_immutable', detail: { constraintId: 'jobs.job_client_locked' } }
const patch = (app: Awaited<ReturnType<typeof setup>>, id: string, data: object, version = '1') => request(app, `/api/jobs/${id}`, 'PATCH', data, 'owner-a', 'org-a', { 'If-Match': version })

it('returns HTTP 409 ref_immutable for CRUD while referenced, then allows the change once unreferenced', async () => {
  const app = await setup(config); await insertDomain(); await insertDomain('org-b')
  await env.DB.prepare("INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES ('other','org-a','Other','now','now')").run()
  const free = await request(app, '/api/jobs', 'POST', { title: 'Free', client_id: 'client-org-a' }, 'owner-a', 'org-a'); const freeJob = await json(free)
  const reserve = await request(app, '/api/reservation', 'POST', { client: 'client-org-a', location: 'job-org-a' }); expect(reserve.status).toBe(201)
  const row = await json(reserve), before = await snapshot()
  const blocked = await patch(app, 'job-org-a', { client_id: 'other' })
  expect(blocked.status).toBe(409); expect(await json(blocked)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  expect((await patch(app, 'job-org-a', { title: 'Renamed' })).status).toBe(200)
  expect((await patch(app, 'job-org-a', { client_id: 'client-org-a' }, '2')).status).toBe(200)
  expect((await patch(app, freeJob.id, { client_id: 'other' })).status).toBe(200)
  // A reference held by another organization never blocks this organization (and vice versa).
  await env.DB.prepare("INSERT INTO reservation (id,organization_id,client,location,created_at,updated_at) VALUES ('held-b','org-b','client-org-b','job-org-b','now','now')").run()
  await env.DB.prepare("INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES ('other-b','org-b','Other B','now','now')").run()
  await expect(env.DB.prepare("UPDATE jobs SET client_id='other-b' WHERE id='job-org-b'").run()).rejects.toThrow()
  await env.DB.prepare("UPDATE jobs SET title='b' WHERE id='job-org-b'").run()
  expect((await request(app, `/api/reservation/${row.id}`, 'DELETE', undefined, 'owner-a', 'org-a', { 'If-Match': '1' })).status).toBe(204)
  expect((await patch(app, 'job-org-a', { client_id: 'other' }, '3')).status).toBe(200)
})
it('maps actual D1 trigger wrappers and atomically rolls back domain/audit/idempotency writes', async () => {
  await setup(config); await insertDomain()
  await env.DB.prepare("INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES ('other','org-a','Other','now','now')").run()
  await env.DB.prepare("INSERT INTO reservation (id,organization_id,client,location,created_at,updated_at) VALUES ('held','org-a','client-org-a','job-org-a','now','now')").run()
  const app = createApp(config, runtime(), { commands: createCommandRegistry([operation]) })
  const before = await snapshot()
  const result = await request(app, '/commands/reservation/relocate', 'POST', { client: 'other', idempotencyKey: 'atomic-locked' })
  expect(result.status).toBe(409); expect(await json(result)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  const error = await env.DB.prepare("UPDATE jobs SET client_id='other' WHERE id='job-org-a'").run().catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(refImmutableViolation(error, config)).toMatchObject({ status: 409, code: 'ref_immutable', detail: conflict.detail })
  expect(constraintError(error, config)).toMatchObject({ code: 'ref_immutable' })
  await env.DB.prepare("DELETE FROM reservation WHERE id='held'").run()
  expect((await request(app, '/commands/reservation/relocate', 'POST', { client: 'other', idempotencyKey: 'atomic-locked' })).status).toBe(200)
})
it('maps exact generated tokens only, bounds causes, and preserves generic fallback', async () => {
  const token = refImmutableToken('jobs', constraint.name)
  for (const suffix of ['', ': SQLITE_CONSTRAINT', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)']) {
    expect(refImmutableViolation(new Error(`D1_ERROR: ${token}${suffix}`), config)).toMatchObject({ code: 'ref_immutable' })
    expect(refImmutableViolation(new Error('D1_ERROR', { cause: new Error(`${token}${suffix}`) }), config)).toMatchObject({ code: 'ref_immutable' })
  }
  for (const message of [`prefix ${token}`, `${token}: arbitrary text`, 'ref_immutable', token.replace('job_client_locked', 'unknown'), 'x'.repeat(10000)]) expect(refImmutableViolation(new Error(message), config)).toBeUndefined()
  const cycle = new Error('unknown'); cycle.cause = cycle; expect(refImmutableViolation(cycle, config)).toBeUndefined()
  const app = await setup(config)
  await env.DB.prepare("CREATE TRIGGER arbitrary AFTER INSERT ON reservation BEGIN SELECT RAISE(ABORT, 'ref_immutable'); END").run()
  const result = await request(app, '/api/reservation', 'POST', {})
  expect(result.status).toBe(409); expect(await json(result)).toEqual({ error: 'constraint_conflict' })
})
it('detects missing and modified immutability triggers as schema drift', async () => {
  await setup(config)
  await expect(checkEntityConstraints(env.DB, config)).resolves.toBeUndefined()
  const token = refImmutableToken('jobs', constraint.name)
  await env.DB.prepare(`DROP TRIGGER "${token}_replace"`).run()
  await expect(checkEntityConstraints(env.DB, config)).rejects.toThrow('Schema drift')
  await env.DB.prepare(`CREATE TRIGGER "${token}_replace" BEFORE INSERT ON jobs BEGIN SELECT 1; END`).run()
  await expect(checkEntityConstraints(env.DB, config)).rejects.toThrow('Schema drift')
})
it('returns stable data MCP status/code for real D1 CRUD and atomic failures with rollback', async () => {
  const { connectEqualityDataMcp } = await import('../../mcp/test/data/ref-equality-bridge')
  await setup(config); await insertDomain()
  await env.DB.prepare("INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES ('other','org-a','Other','now','now')").run()
  const app = createApp(config, runtime(), { commands: createCommandRegistry([operation]) })
  const mcp = await connectEqualityDataMcp(async (url, init) => app.request(String(url), { ...init, redirect: 'manual' }))
  try {
    const { call } = mcp
    await call('create_record', { entity: 'reservation', data: { client: 'client-org-a', location: 'job-org-a' } })
    const before = await snapshot()
    for (const [name, args] of [
      ['update_record', { entity: 'jobs', id: 'job-org-a', data: { client_id: 'other' }, version: 1 }],
      ['run_command', { name: 'reservation/relocate', input: { client: 'other' }, idempotencyKey: 'mcp-atomic' }],
    ] as const) {
      expect(await call(name, args)).toEqual({ ok: false, code: 'ref_immutable', status: 409 })
      expect(await snapshot()).toEqual(before)
    }
    expect(await call('update_record', { entity: 'jobs', id: 'job-org-a', data: { title: 'Renamed' }, version: 1 })).toMatchObject({ ok: true })
  } finally { await mcp.close() }
})

// Regressions derived from the reviewer's local D1/Miniflare probes.
it('rejects UPDATE OR REPLACE of an occupied referenced identity on D1', async () => {
  await setup(config); await insertDomain()
  await env.DB.prepare("PRAGMA recursive_triggers=OFF").run()
  await env.DB.prepare("INSERT INTO clients(id,organization_id,name,created_at,updated_at) VALUES('other','org-a','Other','now','now')").run()
  await env.DB.prepare("INSERT INTO jobs(id,organization_id,title,client_id,created_at,updated_at) VALUES('free','org-a','Free','other','now','now')").run()
  await env.DB.prepare("INSERT INTO reservation(id,organization_id,client,location,created_at,updated_at) VALUES('held','org-a','client-org-a','job-org-a','now','now')").run()
  const before = await snapshot()
  await expect(env.DB.prepare("UPDATE OR REPLACE jobs SET id='job-org-a' WHERE id='free'").run()).rejects.toThrow(refImmutableToken('jobs', constraint.name))
  expect(await snapshot()).toEqual(before)
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
})
it('rejects multi-row REPLACE through a declared unique key and reused referenced id on D1', async () => {
  const uniqueConfig = defineInstance({ ...config, entities: { ...config.entities, jobs: { ...config.entities.jobs, constraints: [constraint, { kind: 'unique', name: 'title_unique', fields: ['title'] }] } } })
  await setup(uniqueConfig); await insertDomain()
  await env.DB.prepare("PRAGMA recursive_triggers=OFF").run()
  await env.DB.prepare("INSERT INTO clients(id,organization_id,name,created_at,updated_at) VALUES('other','org-a','Other','now','now')").run()
  await env.DB.prepare("INSERT INTO reservation(id,organization_id,client,location,created_at,updated_at) VALUES('held','org-a','client-org-a','job-org-a','now','now')").run()
  const row = await env.DB.prepare("SELECT title FROM jobs WHERE id='job-org-a'").first<{ title: string }>()
  const before = await snapshot()
  await expect(env.DB.prepare("INSERT OR REPLACE INTO jobs(id,organization_id,title,client_id,created_at,updated_at) VALUES('replacement','org-a',?,'other','now','now'),('job-org-a','org-a','New title','other','now','now')").bind(row!.title).run()).rejects.toThrow(refImmutableToken('jobs', constraint.name))
  expect(await snapshot()).toEqual(before)
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
})
it('allows UPSERTs with omitted or differing proposals when the stored ref does not change on D1', async () => {
  const nullableConfig = defineInstance({ ...config, entities: { ...config.entities, jobs: { ...config.entities.jobs, fields: { ...config.entities.jobs.fields, client_id: { ...config.entities.jobs.fields.client_id, required: false } } } } })
  await setup(nullableConfig); await insertDomain()
  await env.DB.prepare("INSERT INTO reservation(id,organization_id,client,location,created_at,updated_at) VALUES('held','org-a','client-org-a','job-org-a','now','now')").run()
  await expect(env.DB.prepare("INSERT INTO jobs(id,organization_id,title,created_at,updated_at) VALUES('job-org-a','org-a','Renamed','now','now') ON CONFLICT(id) DO UPDATE SET title=excluded.title").run()).resolves.toMatchObject({ success: true })
  await expect(env.DB.prepare("INSERT INTO jobs(id,organization_id,title,client_id,created_at,updated_at) VALUES('job-org-a','org-a','Ignored','different','now','now') ON CONFLICT(id) DO NOTHING").run()).resolves.toMatchObject({ success: true })
  expect(await env.DB.prepare("SELECT title,client_id FROM jobs WHERE id='job-org-a'").first()).toEqual({ title: 'Renamed', client_id: 'client-org-a' })
})
