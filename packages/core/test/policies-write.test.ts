import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { setup, runtime, policyGraph, roles } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import { defineInstance, defaultOrganizationPermissions } from '../src/config'
import { createApp } from '../src/app'
import type { AtomicOperation, AtomicStore, GuardedStatement } from '../src/execution/types'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
const canarySafe = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/CANARY_(?:ORG|ROW|ACCOUNT)|SECRET_FILES_CANARY/)
async function live(role: string, config = policyGraph) {
  return requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${role}` } }), runtime(), new KernelRegistry(config).config), 'org-a', new KernelRegistry(config).config)
}

it('CRUD create/update post-image violations roll back row, audit and idempotency key', async () => {
  const count = (table: string) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n')
  const before = await Promise.all(['records', 'audit_outbox', 'idempotency_keys'].map(count))
  const create = await request(app, '/api/records', 'POST', { name: 'Outside', team_id: 'team-b' }, 'reviewer', 'org-a', { 'Idempotency-Key': 'outside' })
  expect(create.status).toBe(403); expect((await json(create)).error).toBe('policy_violation')
  expect(await Promise.all(['records', 'audit_outbox', 'idempotency_keys'].map(count))).toEqual(before)
  const update = await request(app, '/api/records/record-own', 'PATCH', { team_id: 'team-b', version: 1 }, 'reviewer')
  expect(update.status).toBe(403); expect((await json(update)).error).toBe('policy_violation')
  expect(await env.DB.prepare("SELECT team_id,version FROM records WHERE id='record-own'").first()).toEqual({ team_id: 'team-a', version: 1 })
  expect(await count('atomic_assert')).toBe(0); expect(await count('audit_outbox')).toBe(0)
})
it('CRUD authorized create/update/delete succeeds and audits each effect', async () => {
  const created = await request(app, '/api/records', 'POST', { name: 'New record', team_id: 'team-a' }, 'reviewer')
  expect(created.status).toBe(201); const row = await json(created)
  expect((await request(app, `/api/records/${row.id}`, 'PATCH', { name: 'Changed', version: 1 }, 'reviewer')).status).toBe(200)
  expect((await request(app, `/api/records/${row.id}`, 'DELETE', undefined, 'reviewer')).status).toBe(204)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(3)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM atomic_assert').first('n')).toBe(0)
})
it.each(['PATCH', 'DELETE'])('CRUD %s hides an out-of-team row with the same 404 as detail reads', async method => {
  const response = await request(app, '/api/records/record-CANARY_ROW', method, method === 'PATCH' ? { name: 'Bad', version: 1 } : undefined, 'reviewer')
  expect(response.status).toBe(404); canarySafe(await json(response))
  expect((await request(app, '/api/records/record-CANARY_ROW', 'GET', undefined, 'reviewer')).status).toBe(404)
})
it.each(['team_id', 'role'])('CRUD cannot change the actor users.%s dependency', async field => {
  const response = await request(app, '/api/users/reviewer', 'PATCH', { [field]: field === 'role' ? 'administrator' : 'team-b', version: 1 }, 'reviewer')
  expect(response.status).toBe(403); expect((await json(response)).error).toBe('field_forbidden')
})
it('administrator generic REST can manage another account assignment', async () => {
  const config = defineInstance({ ...policyGraph, account: { entity: 'users', managedBy: ['administrator'], assignments: ['role', 'team_id'] } })
  const declared = createApp(config, runtime())
  const response = await request(declared, '/api/users/reviewer-colleague', 'PATCH', { team_id: 'team-b', role: 'coordinator', version: 1 }, 'administrator')
  expect(response.status).toBe(200)
  expect(await env.DB.prepare("SELECT team_id,role FROM users WHERE id='reviewer-colleague'").first()).toEqual({ team_id: 'team-b',role: 'coordinator' })
})
function operation(statement: GuardedStatement, entity = 'records', name = 'records/move'): AtomicOperation {
  return { name, permission: { entity, operation: 'update' }, input: z.strictObject({}), plan: () => ({
    rules: [{ name: 'domain_change', statements: [statement] }], result: { status: 200, body: { ok: true } },
    event: { operation: 'fixture.changed', entity, entityId: 'record-own' },
  }) }
}
async function atomic(op: AtomicOperation, role = 'reviewer', key?: string, store: AtomicStore = new D1AtomicStore(env.DB), config = policyGraph) {
  const kernel = new KernelRegistry(config, { commands: createCommandRegistry([op]) })
  const scope = await live(role, kernel.config)
  return executeAtomic(op, {}, coreExecutionContext(kernel.config, scope, store, new D1AtomicReader(env.DB), key))
}
it.each([
  ['pre-image', 'UPDATE records SET name=? WHERE id=?', ['bad', 'record-CANARY_ROW']],
  ['post-image', 'UPDATE records SET team_id=? WHERE id=?', ['team-b', 'record-own']],
  ['bulk mixed scope', 'UPDATE records SET name=? WHERE organization_id=?', ['bad', 'org-a']],
  ['no matching row', 'DELETE FROM records WHERE id=?', ['absent']],
])('atomic %s policy failure rolls back domain data, audit and replay key', async (_label, sql, bindings) => {
  const before = (await env.DB.prepare('SELECT * FROM records ORDER BY id').all()).results
  await expect(atomic(operation({ sql: sql as string, bindings: bindings as string[], expectRows: 1 }), 'reviewer', 'denied-key')).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect((await env.DB.prepare('SELECT * FROM records ORDER BY id').all()).results).toEqual(before)
  for (const table of ['audit_outbox', 'idempotency_keys', 'atomic_assert']) expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0)
})
it('atomic bulk updates enforce every captured post-image and support authorized deletes', async () => {
  await atomic(operation({ sql: 'UPDATE records SET name=? WHERE team_id=?', bindings: ['allowed', 'team-a'], expectRows: '>=1' }))
  expect(await env.DB.prepare("SELECT count(*) AS n FROM records WHERE name='allowed'").first('n')).toBe(2)
  await env.DB.prepare("UPDATE jobs SET record_id=NULL WHERE record_id='record-colleague'").run()
  await atomic(operation({ sql: 'DELETE FROM records WHERE id=?', bindings: ['record-colleague'], expectRows: 1 }))
  expect(await env.DB.prepare("SELECT id FROM records WHERE id='record-colleague'").first()).toBeNull()
})
it.each(['team_id', 'role'])('atomic SQL and HTTP commands cannot change own users.%s', async field => {
  const op = operation({ sql: `UPDATE users SET ${field}=? WHERE id=?`, bindings: [field === 'role' ? 'administrator' : 'team-b', 'reviewer'], expectRows: 1 }, 'users', 'users/change')
  await expect(atomic(op)).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
  app = await setup({ commands: createCommandRegistry([op]) })
  const response = await request(app, '/commands/users/change', 'POST', {}, 'reviewer')
  expect(response.status).toBe(403); expect((await json(response)).error).toBe('field_forbidden')
})
it('atomic INSERT verifies the inserted row in the same batch', async () => {
  const sql = 'INSERT INTO records (id,organization_id,name,team_id,created_at,updated_at) VALUES (?,?,?,?,?,?)'
  const rejected = operation({ sql, bindings: ['created-denied', 'org-a', 'Denied', 'team-b', 'now', 'now'], expectRows: 1 }, 'records', 'records/create')
  await expect(atomic(rejected)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(await env.DB.prepare("SELECT id FROM records WHERE id='created-denied'").first()).toBeNull()
  const allowed = operation({ sql, bindings: ['created-allowed', 'org-a', 'Allowed', 'team-a', 'now', 'now'], expectRows: 1 }, 'records', 'records/create')
  expect((await atomic(allowed)).status).toBe(200)
})
it.each([
  "UPDATE users SET (role,team_id)=('administrator','team-b') WHERE id='reviewer'",
  "INSERT INTO records (id,organization_id,name,team_id,created_at,updated_at) VALUES ('a','org-a','a','team-a','now','now'),('b','org-a','b','team-b','now','now')",
  "UPDATE main.records SET name='bad' WHERE id='record-CANARY_ROW'",
])('unsupported policy SQL fails closed %#', async sql => {
  await expect(atomic(operation({ sql, expectRows: 1 }))).rejects.toMatchObject({ status: 422, code: 'unsupported_atomic_operation' })
})
it('uppercase domain names cannot bypass atomic row predicates', async () => {
  await expect(atomic(operation({ sql: 'UPDATE RECORDS SET name=? WHERE id=?', bindings: ['bad', 'record-CANARY_ROW'], expectRows: 1 }))).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
})
it('membership role dependency requires the owner-managed path for self and other members', async () => {
  const self = operation({ sql: 'UPDATE memberships SET role=? WHERE user_id=? AND organization_id=?', bindings: ['administrator', 'reviewer', 'org-a'], expectRows: 1 }, 'users', 'users/change')
  await expect(atomic(self)).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
  const other = operation({ sql: 'UPDATE memberships SET role=? WHERE user_id=? AND organization_id=?', bindings: ['coordinator', 'reviewer-colleague', 'org-a'], expectRows: 1 }, 'users', 'users/change')
  await expect(atomic(other, 'administrator')).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
})
it('quoted uppercase actor field names cannot bypass the write guard', async () => {
  await expect(atomic(operation({ sql: 'UPDATE "USERS" SET "TEAM_ID"=? WHERE id=?', bindings: ['team-b', 'reviewer'], expectRows: 1 }, 'users', 'users/change'))).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
})
it('an all policy still enforces tenancy on atomic pre-images and post-images', async () => {
  await env.DB.prepare("INSERT INTO records (id,organization_id,name,team_id,created_at,updated_at) VALUES ('unlinked','org-a','Unlinked','team-a','now','now')").run()
  for (const statement of [
    { sql: 'UPDATE records SET name=? WHERE id=?', bindings: ['bad', 'record-CANARY_ORG'], expectRows: 1 as const },
    { sql: 'UPDATE records SET organization_id=?,team_id=? WHERE id=?', bindings: ['org-b', 'team-canary', 'unlinked'], expectRows: 1 as const },
  ]) await expect(atomic(operation(statement), 'administrator')).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
})
it('post-image checks evaluate final batch state when a later rule changes a relation target', async () => {
  const first = operation({ sql: 'UPDATE reports SET name=? WHERE id=?', bindings: ['changed', 'report-own'], expectRows: 1 }, 'reports', 'records/move')
  const op: AtomicOperation = { ...first, additionalPermissions: [{ entity: 'jobs', operation: 'update' }], plan(ctx, input) {
    const plan = first.plan(ctx, input)
    return { ...plan, rules: [...plan.rules, { name: 'later_target_move', statements: [{ sql: 'UPDATE jobs SET reviewer_user_id=? WHERE id=?', bindings: ['reviewer-colleague', 'job-own'], expectRows: 1 }] }] }
  } }
  // Both job images are visible through the team policy, but the report
  // loses its actor-owned job after the later rule. Final assertions roll it back.
  await expect(atomic(op)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(await env.DB.prepare("SELECT name FROM reports WHERE id='report-own'").first('name')).toBe('own')
  expect(await env.DB.prepare("SELECT reviewer_user_id FROM jobs WHERE id='job-own'").first('reviewer_user_id')).toBe('reviewer')
})
it('mutation uses exactly the captured IDs when the original predicate changes after capture', async () => {
  const before = (await env.DB.prepare('SELECT * FROM records ORDER BY id').all()).results
  const op = operation({ sql: "UPDATE records SET team_id='team-b' WHERE id=CASE WHEN (SELECT count(*) FROM atomic_assert)=0 THEN 'record-own' ELSE 'record-colleague' END", expectRows: 1 })
  await expect(atomic(op)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect((await env.DB.prepare('SELECT * FROM records ORDER BY id').all()).results).toEqual(before)
})
it('membership captures preserve composite identity when a member belongs to two organizations', async () => {
  await env.DB.prepare("INSERT INTO memberships VALUES ('reviewer-colleague','org-b','reviewer')").run()
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='administrator'").run()
  const config = defineInstance({ ...policyGraph, roles: [...policyGraph.roles, 'owner', 'viewer'], organizationPermissions: { owner: defaultOrganizationPermissions.owner }, permissions: { ...policyGraph.permissions, owner: policyGraph.permissions.administrator } })
  const response = await request(createApp(config, runtime()), '/orgs/org-a/members/reviewer-colleague', 'PATCH', { role: 'viewer' }, 'administrator')
  expect(response.status).toBe(200)
  expect((await env.DB.prepare("SELECT organization_id,role FROM memberships WHERE user_id='reviewer-colleague' ORDER BY organization_id").all()).results).toEqual([{ organization_id: 'org-a', role: 'viewer' }, { organization_id: 'org-b', role: 'reviewer' }])
})
it('account updates expose configured readable fields and keep private identity columns out of responses', async () => {
  const response = await request(app, '/api/users/reviewer', 'PATCH', { name: 'Changed reviewer', version: 1 }, 'reviewer')
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body.name).toBe('Changed reviewer')
  for (const field of ['password_hash', 'salt', 'email']) expect(Object.hasOwn(body, field)).toBe(false)
})
it('job write responses omit unreadable internal files for team roles', async () => {
  const response = await request(app, '/api/jobs/job-own', 'PATCH', { title: 'Changed job', version: 1 }, 'reviewer')
  expect(response.status).toBe(200)
  expect(Object.hasOwn(await json(response), 'internal_files_ids')).toBe(false)
})
it('generic CRUD cannot provision protected account-extension fields', async () => {
  const response = await request(app, '/api/users', 'POST', { name: 'New member', role: 'reviewer', team_id: 'team-a' }, 'administrator')
  expect(response.status).toBe(403); expect((await json(response)).error).toBe('field_forbidden')
  expect(await env.DB.prepare("SELECT count(*) AS n FROM users WHERE name='New member'").first('n')).toBe(0)
})
it('CRUD replay rechecks the current row policy before returning a stored response', async () => {
  const body = { name: 'Replay record', team_id: 'team-a' }
  const headers = { 'Idempotency-Key': 'record-replay' }
  const first = await request(app, '/api/records', 'POST', body, 'reviewer', 'org-a', headers)
  expect(first.status).toBe(201); const created = await json(first)
  await env.DB.prepare('UPDATE records SET team_id=? WHERE id=?').bind('team-b', created.id).run()
  const replay = await request(app, '/api/records', 'POST', body, 'reviewer', 'org-a', headers)
  expect(replay.status).toBe(404); expect(await json(replay)).toEqual({ error: 'not_found' })
})
it('atomic replay rechecks all affected rows and does not expose its private policy receipt', async () => {
  const op = operation({ sql: 'UPDATE records SET name=? WHERE id=?', bindings: ['receipt name', 'record-own'], expectRows: 1 })
  const first = await atomic(op, 'reviewer', 'atomic-replay')
  expect(first).toEqual({ status: 200, body: { ok: true } })
  expect(await atomic(op, 'reviewer', 'atomic-replay')).toEqual(first)
  const stored = JSON.parse((await env.DB.prepare("SELECT response_json FROM idempotency_keys WHERE key='atomic-replay'").first<string>('response_json'))!)
  expect(stored.__workbase_policy.rows).toEqual([{ entity: 'records', id: 'record-own' }])
  await env.DB.prepare("UPDATE records SET team_id='team-b' WHERE id='record-own'").run()
  await expect(atomic(op, 'reviewer', 'atomic-replay')).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(1)
})
it('atomic replay rejects changed live actor attributes', async () => {
  const op = operation({ sql: 'UPDATE records SET name=? WHERE id=?', bindings: ['receipt name', 'record-own'], expectRows: 1 })
  await atomic(op, 'reviewer', 'actor-replay')
  await env.DB.prepare("UPDATE users SET team_id='team-b' WHERE id='reviewer'").run()
  await expect(atomic(op, 'reviewer', 'actor-replay')).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
})
it('an authorized atomic delete can replay its receipt after the row is gone', async () => {
  await env.DB.prepare("INSERT INTO records (id,organization_id,name,team_id,created_at,updated_at) VALUES ('delete-replay','org-a','Replay','team-a','now','now')").run()
  const op = operation({ sql: 'DELETE FROM records WHERE id=?', bindings: ['delete-replay'], expectRows: 1 }, 'records', 'records/delete')
  const first = await atomic(op, 'reviewer', 'delete-replay')
  expect(await atomic(op, 'reviewer', 'delete-replay')).toEqual(first)
})
it('an agent cannot write protected fields on its live issuer account', async () => {
  const { sha256 } = await import('../src/crypto')
  const token = 'wb_synthetic_protected_issuer'
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind('agent-reviewer', 'org-a', 'reviewer', 'Reviewer agent', await sha256(token), 'wb_synthetic', 'reviewer', '2099-01-01T00:00:00.000Z', 'now').run()
  const response = await request(app, '/api/users/reviewer', 'PATCH', { team_id: 'team-b', version: 1 }, 'reviewer', 'org-a', { Authorization: `Bearer ${token}` })
  expect(response.status).toBe(403); expect((await json(response)).error).toBe('field_forbidden')
})
it('write enforcement survives an AtomicStore cloning its declarative submission', async () => {
  const store: AtomicStore = { run: plan => new D1AtomicStore(env.DB).run(structuredClone(plan)) }
  const op = operation({ sql: 'UPDATE records SET team_id=? WHERE id=?', bindings: ['team-b', 'record-own'], expectRows: 1 })
  await expect(atomic(op, 'reviewer', undefined, store)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(await env.DB.prepare("SELECT team_id FROM records WHERE id='record-own'").first('team_id')).toBe('team-a')
})
it('commands cannot forge execution-owned policy guard metadata', async () => {
  const op = operation({ sql: 'UPDATE records SET team_id=? WHERE id=?', bindings: ['team-b', 'record-own'], policyGuard: { entity: 'records', operation: 'UPDATE', filter: { sql: '1=1' } } })
  await expect(atomic(op)).rejects.toMatchObject({ status: 422, code: 'unsupported_atomic_operation' })
})

it('administrator assignment allowance rejects self and rolls back a mixed bulk SET', async () => {
  const config = defineInstance({ ...policyGraph, account: { entity: 'users', managedBy: ['administrator'], assignments: ['team_id'] } })
  for (const where of ["id='administrator'", "organization_id='org-a'"]) {
    const before = (await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results
    await expect(atomic(operation({ sql: `UPDATE users SET [team_id]=COALESCE(?,[team_id]) WHERE ${where}`,bindings: ['team-b'],expectRows: '>=1' },'users','users/change'),'administrator', undefined, new D1AtomicStore(env.DB), config)).rejects.toMatchObject({ status: 403,code: 'field_forbidden' })
    expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(before)
  }
})
it('administrator account allowance cannot reassign principal identifiers', async () => {
  const config = defineInstance({ ...policyGraph, account: { entity: 'users', managedBy: ['administrator'], assignments: ['team_id'] } })
  await expect(atomic(operation({ sql: 'UPDATE users SET id=? WHERE id=?',bindings: ['replacement','reviewer-colleague'],expectRows: 1 },'users','users/change'),'administrator', undefined, new D1AtomicStore(env.DB), config)).rejects.toMatchObject({ status: 403,code: 'field_forbidden' })
})
