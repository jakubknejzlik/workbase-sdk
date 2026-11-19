import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { z } from 'zod'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { createCommandRegistry, defineCommand } from '../src/commands'
import { uniqueConflict } from '../src/constraint-errors'
import { checkInstanceSchema } from '../src/kernel/schema-check'
import { uniqueIndexName } from '../src/entity-constraints'
import { json, request, runtime, setup } from '@workbasehq/test-support/helpers'

const constraint = { kind: 'unique' as const, name: 'booking_slot_unique', fields: ['slot'], where: { field: 'status', op: 'eq' as const, value: 'confirmed' } }
const config = defineInstance({ ...sample, entities: { ...sample.entities, booking: { displayField: 'slot', fields: { slot: { type: 'text' }, status: { type: 'enum', values: ['confirmed', 'cancelled'] } }, constraints: [constraint] } },
  policies: { ...sample.policies, booking: { owner: 'all', dispatcher: 'all', viewer: 'all' } },
  permissions: Object.fromEntries(sample.roles.map(role => [role, { ...sample.permissions[role], booking: ['read' as const, 'create' as const, 'update' as const, 'delete' as const] }])), commands: [...sample.commands, 'booking/confirm'],
})
const operation = defineCommand({ name: 'booking/confirm', permission: { entity: 'booking', operation: 'update' }, idempotency: 'required', input: z.strictObject({ id: z.string() }),
  plan: (ctx, input) => ({ rules: [{ name: 'confirm', statements: [
    { sql: 'INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', bindings: [ctx.newId, ctx.scope.organizationId, 'rolled back', ctx.now, ctx.now], expectRows: 1 },
    { sql: "UPDATE booking SET status='confirmed' WHERE organization_id=? AND id=?", bindings: [ctx.scope.organizationId, input.id], expectRows: 1 },
  ] }], result: { status: 200, body: {} }, event: { entity: 'booking', entityId: input.id, operation: 'booking.confirmed' } }),
})
const snapshot = async () => Promise.all(['booking', 'clients', 'audit_outbox', 'idempotency_keys', 'atomic_assert'].map(table => env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(r => r.results)))
const conflict = { error: 'unique_conflict', detail: { constraintId: 'booking.booking_slot_unique' } }
const create = (app: ReturnType<typeof createApp>, slot: string, status = 'confirmed', org = 'org-a', key?: string) => request(app, '/api/booking', 'POST', { slot, status }, org === 'org-a' ? 'owner-a' : 'owner-b', org, key ? { 'Idempotency-Key': key } : {})
const update = (app: ReturnType<typeof createApp>, row: { id: string; version: number }, data: object) => request(app, `/api/booking/${row.id}`, 'PATCH', data, 'owner-a', 'org-a', { 'If-Match': String(row.version) })

it('enforces confirmed insert/update, cancel/reconfirm, moving slots, cancelled duplicates and tenant isolation with CRUD rollback and retry', async () => {
  const app = await setup(config)
  let one = await json(await create(app, 's'))
  const before = await snapshot()
  const duplicate = await create(app, 's', 'confirmed', 'org-a', 'duplicate-key')
  expect(duplicate.status).toBe(409); expect(await json(duplicate)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  let two = await json(await create(app, 's', 'cancelled'))
  expect((await create(app, 's', 'cancelled')).status).toBe(201)
  expect((await create(app, 's', 'confirmed', 'org-b')).status).toBe(201)
  const beforeUpdate = await snapshot()
  const rejected = await update(app, two, { status: 'confirmed' })
  expect(rejected.status).toBe(409); expect(await json(rejected)).toEqual(conflict)
  expect(await snapshot()).toEqual(beforeUpdate)
  one = await json(await update(app, one, { status: 'cancelled' }))
  const confirmed = await update(app, two, { status: 'confirmed' }); expect(confirmed.status).toBe(200); two = await json(confirmed)
  expect((await update(app, one, { status: 'confirmed' })).status).toBe(409)
  two = await json(await update(app, two, { slot: 'next' }))
  const reconfirmed = await update(app, one, { status: 'confirmed' }); expect(reconfirmed.status).toBe(200); one = await json(reconfirmed)
  expect((await update(app, two, { slot: 's' })).status).toBe(409)
  expect((await update(app, two, { slot: 'free' })).status).toBe(200)
  expect((await create(app, 'retry', 'confirmed', 'org-a', 'duplicate-key')).status).toBe(201)
})
it('allows exactly one of two competing confirmations', async () => {
  const app = await setup(config)
  const rows = await Promise.all([Promise.resolve(create(app, 's', 'cancelled')).then(json), Promise.resolve(create(app, 's', 'cancelled')).then(json)])
  const results = await Promise.all(rows.map(row => update(app, row, { status: 'confirmed' })))
  expect(results.map(result => result.status).sort()).toEqual([200, 409])
  expect(await json(results.find(result => result.status === 409)!)).toEqual(conflict)
  expect((await env.DB.prepare("SELECT id FROM booking WHERE status='confirmed'").all()).results).toHaveLength(1)
})
it('maps actual D1 partial-index wrappers on atomic updates and rolls back domain/audit/idempotency writes, then retries', async () => {
  await setup(config)
  const app = createApp(config, runtime(), { commands: createCommandRegistry([operation]) })
  expect((await create(app, 's')).status).toBe(201)
  const row = await json(await create(app, 's', 'cancelled'))
  const before = await snapshot()
  const result = await request(app, '/commands/booking/confirm', 'POST', { id: row.id, idempotencyKey: 'atomic-duplicate' })
  expect(result.status).toBe(409); expect(await json(result)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  const error = await env.DB.prepare("UPDATE booking SET status='confirmed' WHERE id=?").bind(row.id).run().catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(uniqueConflict(error, config)).toMatchObject({ status: 409, code: 'unique_conflict', detail: conflict.detail })
  await env.DB.prepare("DELETE FROM booking WHERE status='confirmed'").run()
  expect((await request(app, '/commands/booking/confirm', 'POST', { id: row.id, idempotencyKey: 'atomic-duplicate' })).status).toBe(200)
})
it('verifies the generated partial predicate and detects missing, full, changed, or injected predicates as schema drift', async () => {
  await setup(config)
  await expect(checkInstanceSchema(env.DB, config, {})).resolves.toBeUndefined()
  const index = uniqueIndexName('booking', constraint.name)
  for (const predicate of ['', " WHERE status='cancelled'", " WHERE status='confirmed' OR 1=1"]) {
    await env.DB.prepare(`DROP INDEX ${index}`).run()
    await env.DB.prepare(`CREATE UNIQUE INDEX ${index} ON booking(organization_id,slot)${predicate}`).run()
    await expect(checkInstanceSchema(env.DB, config, {})).rejects.toThrow('Schema drift')
  }
})
