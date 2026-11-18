import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { z } from 'zod'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { createCommandRegistry, defineCommand } from '../src/commands'
import { uniqueConflict } from '../src/constraint-errors'
import { json, request, runtime, setup } from '@workbasehq/test-support/helpers'

const constraint = { kind: 'unique' as const, name: 'assignment_slot_worker_unique', fields: ['slot', 'worker'] }
const config = defineInstance({ ...sample, entities: { ...sample.entities, assignment: { displayField: 'slot', fields: { slot: { type: 'text' }, worker: { type: 'text' } }, constraints: [constraint] } },
  policies: { ...sample.policies, assignment: { owner: 'all', dispatcher: 'all', viewer: 'all' } },
  permissions: Object.fromEntries(sample.roles.map(role => [role, { ...sample.permissions[role], assignment: role === 'viewer' ? ['read' as const] : ['read' as const, 'create' as const, 'update' as const, 'delete' as const] }])), commands: [...sample.commands, 'assignment/pair'],
})
const operation = defineCommand({ name: 'assignment/pair', permission: { entity: 'assignment', operation: 'create' }, idempotency: 'required', input: z.strictObject({}),
  plan: ctx => ({ rules: [{ name: 'pair', statements: [
    { sql: 'INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', bindings: [ctx.newId, ctx.scope.organizationId, 'rolled back', ctx.now, ctx.now], expectRows: 1 },
    { sql: 'INSERT INTO assignment (id,organization_id,slot,worker,created_at,updated_at) VALUES (?,?,?,?,?,?)', bindings: [ctx.newId, ctx.scope.organizationId, 's', 'w', ctx.now, ctx.now], expectRows: 1 },
  ] }], result: { status: 201, body: {} }, event: { entity: 'assignment', entityId: ctx.newId, operation: 'assignment.created' } }),
})
const snapshot = async () => Promise.all(['assignment', 'clients', 'audit_outbox', 'idempotency_keys', 'atomic_assert'].map(table => env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(r => r.results)))
const conflict = { error: 'unique_conflict', detail: { constraintId: 'assignment.assignment_slot_worker_unique' } }

it('enforces create/update tenant-scoped composite uniqueness, distinct NULLs, authorization/version precedence and retry on D1', async () => {
  const app = await setup(config)
  const create = (data: object, org = 'org-a', key?: string) => request(app, '/api/assignment', 'POST', data, org === 'org-a' ? 'owner-a' : 'owner-b', org, key ? { 'Idempotency-Key': key } : {})
  const first = await create({ slot: 's', worker: 'w' }); expect(first.status).toBe(201)
  const before = await snapshot()
  const duplicate = await create({ slot: 's', worker: 'w' }, 'org-a', 'duplicate-key')
  expect(duplicate.status).toBe(409); expect(await json(duplicate)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  const second = await create({ slot: 's', worker: 'other' }); expect(second.status).toBe(201)
  const row = await json(second)
  const update = (version: number, worker: string) => request(app, `/api/assignment/${row.id}`, 'PATCH', { worker }, 'owner-a', 'org-a', { 'If-Match': String(version) })
  const beforeUpdate = await snapshot()
  const rejected = await update(1, 'w'); expect(rejected.status).toBe(409); expect(await json(rejected)).toEqual(conflict)
  expect(await snapshot()).toEqual(beforeUpdate)
  expect((await update(1, 'retry')).status).toBe(200)
  expect(await json(await update(1, 'w'))).toEqual({ error: 'version_conflict' })
  expect((await create({ slot: 's', worker: 'w' }, 'org-b')).status).toBe(201)
  for (const data of [{ slot: 's' }, { slot: 's' }, { worker: 'w' }, { worker: 'w' }, {}, {}]) expect((await create(data)).status).toBe(201)
  expect((await request(app, '/api/assignment', 'POST', { slot: 's', worker: 'w' }, 'viewer-a')).status).toBe(403)
  expect((await create({ slot: 'new', worker: 'w' }, 'org-a', 'duplicate-key')).status).toBe(201)
})
it('maps actual D1 wrappers and rolls back every atomic domain/audit/idempotency write', async () => {
  await setup(config)
  const app = createApp(config, runtime(), { commands: createCommandRegistry([operation]) })
  expect((await request(app, '/api/assignment', 'POST', { slot: 's', worker: 'w' })).status).toBe(201)
  const before = await snapshot()
  const result = await request(app, '/commands/assignment/pair', 'POST', { idempotencyKey: 'atomic-duplicate' })
  expect(result.status).toBe(409); expect(await json(result)).toEqual(conflict)
  expect(await snapshot()).toEqual(before)
  const error = await env.DB.prepare("INSERT INTO assignment (id,organization_id,slot,worker,created_at,updated_at) VALUES ('probe','org-a','s','w','now','now')").run().catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(uniqueConflict(error, config)).toMatchObject({ status: 409, code: 'unique_conflict', detail: conflict.detail })
  await env.DB.prepare("DELETE FROM assignment WHERE slot='s'").run()
  expect((await request(app, '/commands/assignment/pair', 'POST', { idempotencyKey: 'atomic-duplicate' })).status).toBe(201)
})
it('uses only declared exact identities; ambiguous signatures omit ID; arbitrary text stays generic', () => {
  const wrapped = new Error('D1_ERROR', { cause: new Error('UNIQUE constraint failed: assignment.organization_id, assignment.slot, assignment.worker: SQLITE_CONSTRAINT') })
  expect(uniqueConflict(wrapped, config)).toMatchObject({ code: 'unique_conflict', detail: conflict.detail })
  const ambiguous = defineInstance({ ...config, entities: { ...config.entities, assignment: { ...config.entities.assignment, constraints: [constraint, { ...constraint, name: 'second_unique' }] } } })
  expect(uniqueConflict(wrapped, ambiguous)).toMatchObject({ code: 'unique_conflict', detail: undefined })
  for (const message of [
    'unique_conflict', 'D1_ERROR: custom unique_conflict: SQLITE_CONSTRAINT',
    'UNIQUE constraint failed: clients.organization_id, clients.name: SQLITE_CONSTRAINT',
    'UNIQUE constraint failed: assignment.organization_id, assignment.slot, assignment.worker: arbitrary text',
    'CHECK constraint failed: assignment_slot_worker_unique: SQLITE_CONSTRAINT',
    'prefix UNIQUE constraint failed: assignment.organization_id, assignment.slot, assignment.worker',
  ]) expect(uniqueConflict(new Error(message), config)).toBeUndefined()
})
it('retains generic constraint_conflict for unknown constraints and custom trigger text', async () => {
  const app = await setup(config)
  await env.DB.exec("CREATE TRIGGER arbitrary BEFORE INSERT ON assignment BEGIN SELECT RAISE(ABORT, 'unique_conflict'); END;")
  const result = await request(app, '/api/assignment', 'POST', { slot: 's', worker: 'w' })
  expect(result.status).toBe(409); expect(await json(result)).toEqual({ error: 'constraint_conflict' })
})
it('detects missing, nonunique, partial and changed generated indexes as schema drift', async () => {
  const { checkInstanceSchema } = await import('../src/kernel/schema-check')
  const { uniqueIndexName } = await import('../src/entity-constraints')
  const { pluginMigrationStatus } = await import('../src/kernel/migrations')
  await setup(config)
  const index = uniqueIndexName('assignment', constraint.name)
  await expect(checkInstanceSchema(env.DB, config, {})).resolves.toBeUndefined()
  for (const ddl of ['', `CREATE INDEX ${index} ON assignment(organization_id,slot,worker)`, `CREATE UNIQUE INDEX ${index} ON assignment(organization_id,slot,worker) WHERE worker IS NOT NULL`, `CREATE UNIQUE INDEX ${index} ON assignment(organization_id,worker,slot)`, `CREATE UNIQUE INDEX ${index} ON assignment(organization_id,slot COLLATE NOCASE,worker)`]) {
    await env.DB.prepare(`DROP INDEX IF EXISTS ${index}`).run()
    if (ddl) await env.DB.prepare(ddl).run()
    await expect(checkInstanceSchema(env.DB, config, {})).rejects.toThrow('Schema drift: missing or changed unique constraint assignment.assignment_slot_worker_unique')
    await expect(pluginMigrationStatus(env.DB, config.plugins ?? [], config)).rejects.toThrow('Schema drift')
  }
})
