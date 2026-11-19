import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { z } from 'zod'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { createCommandRegistry, defineCommand } from '../src/commands'
import { refEqualityMismatch } from '../src/constraint-errors'
import { refEqualityToken } from '../src/entity-constraints'
import { checkEntityConstraints } from '../src/kernel/schema-check'
import { json, request, runtime, setup, insertDomain } from '@workbasehq/test-support/helpers'

const constraint = { kind: 'ref_equality' as const, name: 'location_client', field: 'client', through: 'location', targetField: 'client_id' }
const config = defineInstance({ ...sample, entities: { ...sample.entities, reservation: { displayField: 'id', fields: { client: { type: 'ref', entity: 'clients' }, location: { type: 'ref', entity: 'jobs' } }, constraints: [constraint] } },
  policies: { ...sample.policies, reservation: { owner: 'all', dispatcher: 'all', viewer: 'all' } },
  permissions: Object.fromEntries(sample.roles.map(role => [role, { ...sample.permissions[role], reservation: role === 'viewer' ? ['read' as const] : ['read' as const, 'create' as const, 'update' as const, 'delete' as const] }])), commands: [...sample.commands, 'reservation/pair'],
})
const operation = defineCommand({ name: 'reservation/pair', permission: { entity: 'reservation', operation: 'create' }, idempotency: 'required', input: z.strictObject({ client: z.string() }),
  plan: (ctx, input) => ({ rules: [{ name: 'pair', statements: [
    { sql: 'INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', bindings: [ctx.newId, ctx.scope.organizationId, 'rolled back', ctx.now, ctx.now], expectRows: 1 },
    { sql: 'INSERT INTO reservation (id,organization_id,client,location,created_at,updated_at) VALUES (?,?,?,?,?,?)', bindings: [ctx.newId, ctx.scope.organizationId, input.client, 'job-org-a', ctx.now, ctx.now], expectRows: 1 },
  ] }], result: { status: 201, body: {} }, event: { entity: 'reservation', entityId: ctx.newId, operation: 'reservation.created' } }),
})
const snapshot = async () => Promise.all(['reservation', 'clients', 'jobs', 'audit_outbox', 'idempotency_keys', 'atomic_assert'].map(table => env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(r => r.results)))
const conflict = { error: 'ref_equality_mismatch', detail: { constraintId: 'reservation.location_client' } }

it('returns HTTP 422 for CRUD and reverse guard, retaining rows, audits, receipts and allowing retry', async () => {
  const app = await setup(config); await insertDomain(); await insertDomain('org-b')
  await env.DB.prepare("INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES ('other','org-a','Other','now','now')").run()
  const create = (data: object, key?: string) => request(app, '/api/reservation', 'POST', data, 'owner-a', 'org-a', key ? { 'Idempotency-Key': key } : {})
  const first = await create({ client: 'client-org-a', location: 'job-org-a' }); expect(first.status).toBe(201)
  const row = await json(first), before = await snapshot()
  const mismatch = await create({ client: 'other', location: 'job-org-a' }, 'mismatch')
  expect(mismatch.status).toBe(422); expect(await json(mismatch)).toEqual(conflict)
  const update = await request(app, `/api/reservation/${row.id}`, 'PATCH', { client: 'other' }, 'owner-a', 'org-a', { 'If-Match': '1' })
  expect(update.status).toBe(422); expect(await json(update)).toEqual(conflict)
  const reverse = await request(app, '/api/jobs/job-org-a', 'PATCH', { client_id: 'other' }, 'owner-a', 'org-a', { 'If-Match': '1' })
  expect(reverse.status).toBe(422); expect(await json(reverse)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  for (const data of [{ client: 'client-org-a', location: 'missing' }, { client: 'client-org-a', location: 'job-org-b' }, { client: 'client-org-b', location: 'job-org-a' }]) expect((await create(data)).status).toBeGreaterThanOrEqual(400)
  expect(await snapshot()).toEqual(before)
  expect((await create({ client: 'client-org-a', location: 'job-org-a' }, 'mismatch')).status).toBe(201)
  expect((await create({})).status).toBe(201)
})
it('maps actual D1 trigger wrappers and atomically rolls back domain/audit/idempotency writes', async () => {
  await setup(config); await insertDomain()
  await env.DB.prepare("INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES ('other','org-a','Other','now','now')").run()
  const app = createApp(config, runtime(), { commands: createCommandRegistry([operation]) })
  const before = await snapshot()
  const result = await request(app, '/commands/reservation/pair', 'POST', { client: 'other', idempotencyKey: 'atomic-mismatch' })
  expect(result.status).toBe(422); expect(await json(result)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  const error = await env.DB.prepare("INSERT INTO reservation (id,organization_id,client,location,created_at,updated_at) VALUES ('probe','org-a','other','job-org-a','now','now')").run().catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(refEqualityMismatch(error, config)).toMatchObject({ status: 422, code: 'ref_equality_mismatch', detail: conflict.detail })
  expect((await request(app, '/commands/reservation/pair', 'POST', { client: 'client-org-a', idempotencyKey: 'atomic-mismatch' })).status).toBe(201)
})
it('maps exact generated tokens only, bounds causes, and preserves generic fallback', async () => {
  const token = refEqualityToken('reservation', constraint.name)
  for (const suffix of ['', ': SQLITE_CONSTRAINT', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)']) {
    expect(refEqualityMismatch(new Error(`D1_ERROR: ${token}${suffix}`), config)).toMatchObject({ code: 'ref_equality_mismatch' })
    expect(refEqualityMismatch(new Error('D1_ERROR', { cause: new Error(`${token}${suffix}`) }), config)).toMatchObject({ code: 'ref_equality_mismatch' })
  }
  for (const message of [`prefix ${token}`, `${token}: arbitrary text`, 'ref_equality_mismatch', token.replace('location_client', 'unknown'), 'x'.repeat(10000)]) expect(refEqualityMismatch(new Error(message), config)).toBeUndefined()
  const cycle = new Error('unknown'); cycle.cause = cycle; expect(refEqualityMismatch(cycle, config)).toBeUndefined()
  const app = await setup(config)
  await env.DB.prepare("CREATE TRIGGER arbitrary AFTER INSERT ON reservation BEGIN SELECT RAISE(ABORT, 'ref_equality_mismatch'); END").run()
  const result = await request(app, '/api/reservation', 'POST', {})
  expect(result.status).toBe(409); expect(await json(result)).toEqual({ error: 'constraint_conflict' })
})
it('detects missing and modified equality triggers as schema drift', async () => {
  await setup(config)
  await expect(checkEntityConstraints(env.DB, config)).resolves.toBeUndefined()
  const token = refEqualityToken('reservation', constraint.name)
  await env.DB.prepare(`DROP TRIGGER "${token}_reverse"`).run()
  await expect(checkEntityConstraints(env.DB, config)).rejects.toThrow('Schema drift')
  await env.DB.prepare(`CREATE TRIGGER "${token}_reverse" AFTER UPDATE OF client_id ON jobs BEGIN SELECT 1; END`).run()
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
    const first = await call('create_record', { entity: 'reservation', data: { client: 'client-org-a', location: 'job-org-a' } })
    const before = await snapshot()
    for (const [name, args] of [
      ['create_record', { entity: 'reservation', data: { client: 'other', location: 'job-org-a' }, idempotencyKey: 'mcp-create' }],
      ['update_record', { entity: 'reservation', id: first.data.id, data: { client: 'other' }, version: 1 }],
      ['update_record', { entity: 'jobs', id: 'job-org-a', data: { client_id: 'other' }, version: 1 }],
      ['run_command', { name: 'reservation/pair', input: { client: 'other' }, idempotencyKey: 'mcp-atomic' }],
    ] as const) {
      expect(await call(name, args)).toEqual({ ok: false, code: 'ref_equality_mismatch', status: 422 })
      expect(await snapshot()).toEqual(before)
    }
    await expect(call('run_command', { name: 'reservation/pair', input: { client: 'client-org-a' }, idempotencyKey: 'mcp-atomic' })).resolves.toEqual({ ok: true, data: {} })
  } finally { await mcp.close() }
})
