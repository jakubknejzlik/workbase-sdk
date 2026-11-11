import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { permissions } from '@workbasehq/plugins/permissions'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { request, json, runtime, completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { initialSchema } from '../src/migrations/schema'
import { sha256 } from '../src/crypto'
import { KernelRegistry } from '../src/kernel/registry'
import { defineCommand, createCommandRegistry } from '../src/commands'
import { executeAtomic } from '../src/execution/atomic'
import { createWorkflowRegistry, D1WorkflowRuntime } from '../src/workflow-runtime'
import { linkAccountRow, invitationAccountLink, userLinkCommands } from '../src/user-links'
import { compile } from '../src/execution/compiler'
import { writeFilter } from '../src/execution/policies'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { requireScope, resolveActor } from '../src/authorization'
import type { WorkbasePlugin } from '../src/kernel/plugin'

const config = () => defineInstance({ id: 'account_links', revision: 1, interactive: true,
  plugins: [createIdentity(), createLocalAuth(), permissions({ roles: ['owner', 'dispatcher', 'viewer'] }), createMembers(), createOrganizations(), mailOutbox()],
  account: { entity: 'users' }, roles: ['owner', 'dispatcher', 'viewer'],
  entities: {
    users: { fields: { name: { type: 'string' }, role: { type: 'enum', values: ['owner', 'dispatcher', 'viewer'] } } },
    people: { fields: { name: { type: 'string' }, user: { type: 'ref', entity: 'users', userLink: true } }, relations: { user_account: { field: 'user', entity: 'users' } } },
    teams: { fields: { name: { type: 'string' }, user: { type: 'ref', entity: 'users', userLink: true } }, relations: { user_account: { field: 'user', entity: 'users' } } },
    tasks: { fields: { title: { type: 'string' }, person: { type: 'ref', entity: 'people' } }, relations: { person: { field: 'person', entity: 'people' } } },
  },
  permissions: Object.fromEntries(['owner', 'dispatcher', 'viewer'].map(role => [role, Object.fromEntries(['users', 'people', 'teams', 'tasks'].map(entity => [entity, ['read', 'create', 'update', 'delete'] as const]))])),
  policies: Object.fromEntries(['users', 'people', 'teams', 'tasks'].map(entity => [entity, { owner: 'all', dispatcher: 'all', viewer: 'all' }])),
})
let app: ReturnType<typeof createApp>
beforeEach(async () => {
  await reset()
  const c = config()
  await env.DB.exec(initialSchema(c).replaceAll('\n', ' '))
  await new KernelRegistry(c).applyMigrations(env.DB)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B');")
  for (const [id, role, org] of [['owner-a', 'owner', 'org-a'], ['dispatcher-a', 'dispatcher', 'org-a'], ['viewer-a', 'viewer', 'org-a'], ['owner-b', 'owner', 'org-b']]) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(id, org, `${id}@example.test`, id, role, 'now', 'now'),
      env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `${id}@example.test`, 'now', 'now'),
      env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, org, role),
      env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, '2099-01-01T00:00:00.000Z'),
      env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(id, id),
    ])
  }
  await completeInvitationProfiles()
  await env.DB.exec("INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p1','org-a','One','now','now'),('p2','org-a','Two','now','now'),('foreign','org-b','Foreign','now','now'); INSERT INTO teams (id,organization_id,name,created_at,updated_at) VALUES ('t1','org-a','Team','now','now');")
  app = createApp(c, runtime())
})
const linked = (entity = 'people', id = 'p1') => env.DB.prepare(`SELECT user FROM ${entity} WHERE id=?`).bind(id).first('user')
const link = (id = 'p1', userId = 'viewer-a', actor = 'owner-a', entity = 'people') => request(app, `/commands/${entity}/link_account`, 'POST', { rowId: id, userId }, actor)

it('R5 regression: Link and Remove access share the ordinary write policy depth budget', async () => {
  const probe = (comparisons: number) => {
    const c = config()
    c.policies.people.owner = { where: { or: Array.from({ length: comparisons }, () => ({ name: { eq: 'One' } })) } }
    const observed = { sqlError: '', maxBindings: 0 }
    const db = new Proxy(env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        observed.maxBindings = Math.max(observed.maxBindings, ...statements.map(statement =>
          (statement as D1PreparedStatement & { params?: unknown[] }).params?.length ?? 0))
        try { return await target.batch(statements) }
        catch (error) { observed.sqlError = String(error); throw error }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    return { instance: createApp(c, { ...runtime(), DB: db }), observed }
  }
  const ordinary = async (comparisons: number) => {
    await env.DB.exec("UPDATE people SET name='One',user=NULL,version=1 WHERE id='p1'; DELETE FROM audit_outbox;")
    const { instance, observed } = probe(comparisons)
    const response = await request(instance, '/api/people/p1', 'PATCH', { name: 'One', version: 1 })
    return { status: response.status, ...observed }
  }
  // Discover the ordinary path's ceiling without treating expected depth errors as test failures.
  let nMax = 0
  let ordinaryMaxBindings = 0
  let firstFailure = 61
  for (let n = 10; n <= 60; n += 5) {
    const result = await ordinary(n)
    if (result.status !== 200) { firstFailure = n; break }
    nMax = n
    ordinaryMaxBindings = result.maxBindings
  }
  for (let n = nMax + 1; n < firstFailure; n++) {
    const result = await ordinary(n)
    if (result.status !== 200) break
    nMax = n
    ordinaryMaxBindings = result.maxBindings
  }
  expect(nMax).toBeGreaterThanOrEqual(10)
  console.log(`R5 depth parity: nMax=${nMax}, ordinary maxBindings=${ordinaryMaxBindings}`)
  await env.DB.exec("UPDATE people SET name='One',user=NULL,version=1 WHERE id='p1'; DELETE FROM audit_outbox;")
  const { instance, observed } = probe(nMax)
  const response = await request(instance, '/commands/people/link_account', 'POST', { rowId: 'p1', userId: 'dispatcher-a' })
  console.log(`R5 Link: status=${response.status}, maxBindings=${observed.maxBindings}, sqlError=${observed.sqlError}`)
  expect({ status: response.status, sqlError: observed.sqlError }).toEqual({ status: 200, sqlError: '' })
  expect(await linked()).toBe('dispatcher-a')
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
  const K = 0 // Issuer capture uses n+8 bindings, below ordinary's n+11: no added per-statement maximum.
  expect(observed.maxBindings).toBeLessThanOrEqual(ordinaryMaxBindings + K)
  await env.DB.exec('DELETE FROM audit_outbox;')
  observed.maxBindings = 0
  const removed = await request(instance, '/commands/people/remove_access', 'POST', { rowId: 'p1' })
  console.log(`R5 Remove: status=${removed.status}, maxBindings=${observed.maxBindings}, sqlError=${observed.sqlError}`)
  expect({ status: removed.status, sqlError: observed.sqlError }).toEqual({ status: 200, sqlError: '' })
  expect(await linked()).toBeNull()
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
  expect(observed.maxBindings).toBeLessThanOrEqual(ordinaryMaxBindings + K)
})

it.each(['POST', 'PATCH'])('regular CRUD %s rejects even an explicit null protected user link', async method => {
  for (const user of ['viewer-a', null]) {
    const response = await request(app, `/api/people${method === 'PATCH' ? '/p1' : ''}`, method, { name: 'Attempt', user, ...(method === 'PATCH' ? { version: 1 } : {}) })
    expect([response.status, await json(response)]).toEqual([400, { error: 'protected_field' }])
  }
  expect(await linked()).toBeNull()
})
it('ordinary CRUD without the link remains usable and the link is read-only metadata', async () => {
  expect(config().entities.people.fields.user).toMatchObject({ userLink: true, readOnly: true, required: false })
  const emitted = await json(await request(app, '/o/org-a/console-model'))
  expect(emitted.model.entities.people.fields.user).toMatchObject({ type: 'ref', entity: 'users', readOnly: true, required: false })
  expect(emitted.model.entities.people.writeSchema.properties).not.toHaveProperty('user')
  expect(emitted.model.entities.people.updateSchema.properties).not.toHaveProperty('user')
  expect((await request(app, '/api/people', 'POST', { name: 'New' })).status).toBe(201)
  expect((await request(app, '/api/people/p1', 'PATCH', { name: 'Changed', version: 1 })).status).toBe(200)
  const caps = await json(await request(app, '/o/org-a/capabilities'))
  expect(caps.entities.people.writable).not.toContain('user')
  expect(caps.entities.people.readable).toContain('user')
})

const write = (sql: string, bindings: string[] = []) => defineCommand({ name: 'people/unsafe_write', permission: { entity: 'people', operation: 'update' }, input: z.strictObject({}),
  plan: () => ({ rules: [{ name: 'write', statements: [{ sql, bindings, expectRows: 1 }] }], result: { status: 200, body: {} }, event: { operation: 'people.changed', entity: 'people', entityId: 'p1' } }),
})
it.each([
  ['update', "UPDATE people SET user='viewer-a' WHERE id='p1'"],
  ['bulk/import update', "UPDATE people SET user='viewer-a' WHERE organization_id='org-a'"],
  ['insert', "INSERT INTO people (id,organization_id,name,user,created_at,updated_at) VALUES ('new','org-a','New','viewer-a','now','now')"],
  ['tuple update', "UPDATE people SET (name,user)=('Bad','viewer-a') WHERE id='p1'"],
])('commands reject protected-field %s with 400 before any effects', async (_name, sql) => {
  const op = write(sql)
  app = createApp({ ...config(), commands: [op.name] }, runtime(), { commands: createCommandRegistry([op]) })
  const response = await request(app, `/commands/${op.name}`, 'POST', {})
  expect([response.status, await json(response)]).toEqual([400, { error: 'protected_field' }])
  expect(await linked()).toBeNull()
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})
it('durable workflow effects reject the same protected write', async () => {
  const op = write("UPDATE people SET user='viewer-a' WHERE id='p1'")
  let rejection: unknown
  const undo = { ...write("UPDATE people SET name=name WHERE id='p1'"), name: 'people/unsafe_write_undo' }
  const workflows = createWorkflowRegistry([{ name: 'people/unsafe_workflow', version: '1', input: z.strictObject({}), steps: [{ id: 'write', operation: op, sideEffect: true,
    policy: { maxAttempts: 1, backoffMs: 1, timeoutMs: 10000, deadlineMs: 20000 },
    run: async ({ context }) => { try { return await executeAtomic(op, {}, context) } catch (error) { rejection = error; throw error } },
    compensate: { operation: undo, run: ({ context }) => executeAtomic(undo, {}, context) },
  }] }])
  const c = { ...config(), commands: [op.name, undo.name] }
  app = createApp(c, runtime(), { workflows })
  const response = await request(app, '/workflows/people/unsafe_workflow', 'POST', {}, 'owner-a', 'org-a', { 'Idempotency-Key': 'workflow' })
  expect(response.status).toBe(202)
  await new D1WorkflowRuntime(runtime(), new KernelRegistry(c).config, workflows).tick()
  expect(rejection).toMatchObject({ status: 400, code: 'protected_field' })
  expect(await linked()).toBeNull()
})
it('Link rejects the second row for one account with 409 and permits different entities', async () => {
  expect((await link()).status).toBe(200)
  const conflict = await link('p2')
  expect([conflict.status, await json(conflict)]).toEqual([409, { error: 'account_already_linked' }])
  expect(await linked()).toBe('viewer-a'); expect(await linked('people', 'p2')).toBeNull()
  expect((await link('t1', 'viewer-a', 'owner-a', 'teams')).status).toBe(200)
})
it('concurrent Link requests have one winner with no second success event', async () => {
  const results = await Promise.all([link('p1'), link('p2')])
  expect(results.map(r => r.status).sort()).toEqual([200, 409])
  expect(await env.DB.prepare("SELECT count(*) n FROM people WHERE user='viewer-a'").first('n')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
})
it.each(['owner', 'dispatcher', 'viewer'].flatMap(role => [true, false].flatMap(update => [true, false].flatMap(invite =>
  ['link_account', 'remove_access'].map(action => ({ role, update, invite, action }))))))
('row actions match entity update AND the invitation gate: $action $role update=$update invite=$invite', async ({ role, update, invite, action }) => {
  const c = config()
  c.permissions[role].people = update ? ['read', 'update'] : ['read']
  c.organizationPermissions[role] = invite ? ['invitations.create'] : []
  app = createApp(c, runtime())
  const actor = `${role}-a`
  const invitation = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'new-member@example.test', role: 'member' }, actor)
  expect(invitation.status).toBe(invite ? 201 : 403)
  if (!invite) expect(await json(invitation)).toEqual({ error: 'permission_denied' })
  if (action === 'remove_access') await env.DB.exec("UPDATE people SET user='viewer-a' WHERE id='p1';")
  const caps = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, actor))
  const response = await request(app, `/commands/people/${action}`, 'POST', { rowId: 'p1', ...(action === 'link_account' ? { userId: 'viewer-a' } : {}) }, actor)
  expect([response.status, await json(response)]).toEqual(update && invite ? [200, { id: 'p1' }] : [403, { error: 'permission_denied' }])
  expect(caps.commands.includes(`people/${action}`)).toBe(update && invite)
  expect(await linked()).toBe((update && invite) === (action === 'link_account') ? 'viewer-a' : null)
})
it('Link requires a scoped member and row', async () => {
  expect((await link('foreign')).status).toBe(404)
  expect((await link('p1', 'owner-b')).status).toBe(404)
})
it.each(['link_account', 'remove_access'].flatMap(action => [
  { from: 'owner', to: 'dispatcher', invite: true },
  { from: 'owner', to: 'viewer', invite: true },
  { from: 'owner', to: 'viewer', invite: false },
  { from: 'dispatcher', to: 'viewer', invite: false },
  { from: 'dispatcher', to: 'owner', invite: false },
].map(change => ({ action, ...change }))))
('SQL issuer gate pins the prepare-time role: $action $from->$to invite=$invite', async ({ action, from, to, invite }) => {
  const c = config()
  c.organizationPermissions[from] = ['invitations.create']
  c.organizationPermissions[to] = invite ? ['invitations.create'] : []
  await env.DB.exec("UPDATE people SET user='viewer-a' WHERE id='p1'; UPDATE teams SET user='viewer-a' WHERE id='t1';")
  const rows = async () => (await env.DB.prepare('SELECT id,user,version,updated_at FROM people UNION ALL SELECT id,user,version,updated_at FROM teams ORDER BY id').all()).results
  const before = await rows()
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await env.DB.prepare("UPDATE memberships SET role=? WHERE user_id=? AND organization_id='org-a'").bind(to, `${from}-a`).run()
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(c, { ...runtime(), DB: db })
  const response = await request(app, `/commands/people/${action}`, 'POST', { rowId: 'p1', ...(action === 'link_account' ? { userId: 'dispatcher-a' } : {}) }, `${from}-a`)
  expect(intercepted).toBe(true)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id=? AND organization_id='org-a'").bind(`${from}-a`).first('role')).toBe(to)
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(await rows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})
it.each(['link_account', 'remove_access'])('SQL issuer gate rechecks entity update at commit: %s', async action => {
  const c = config()
  c.organizationPermissions.viewer = ['invitations.create']
  c.permissions.viewer.people = ['read']
  await env.DB.exec("UPDATE people SET user='viewer-a' WHERE id='p1'; UPDATE teams SET user='viewer-a' WHERE id='t1';")
  const rows = async () => (await env.DB.prepare('SELECT id,user,version,updated_at FROM people UNION ALL SELECT id,user,version,updated_at FROM teams ORDER BY id').all()).results
  const before = await rows()
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await env.DB.exec("UPDATE memberships SET role='viewer' WHERE user_id='owner-a' AND organization_id='org-a';")
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(c, { ...runtime(), DB: db })
  const input = { rowId: 'p1', ...(action === 'link_account' ? { userId: 'dispatcher-a' } : {}) }
  const response = await request(app, `/commands/people/${action}`, 'POST', input)
  expect(intercepted).toBe(true)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='owner-a' AND organization_id='org-a'").first('role')).toBe('viewer')
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(await rows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
  const fresh = await request(app, `/commands/people/${action}`, 'POST', input)
  expect([fresh.status, await json(fresh)]).toEqual([403, { error: 'permission_denied' }])
})
it.each(['link_account', 'remove_access'])('prepare denies when no role has both grants: %s', async action => {
  const c = config()
  for (const role of c.roles) {
    c.organizationPermissions[role] = role === 'owner' ? ['invitations.create'] : []
    c.permissions[role] = { ...c.permissions[role], people: role === 'owner' ? ['read'] : ['read', 'update'] }
  }
  await env.DB.exec("UPDATE people SET user='viewer-a' WHERE id='p1'; UPDATE teams SET user='viewer-a' WHERE id='t1';")
  const rows = async () => (await env.DB.prepare('SELECT id,user,version,updated_at FROM people UNION ALL SELECT id,user,version,updated_at FROM teams ORDER BY id').all()).results
  const before = await rows()
  const kernel = new KernelRegistry(c)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const command = userLinkCommands(kernel.config).find(command => command.name === `people/${action}`)!
  // Even a wrapper with a weaker permission cannot bypass the actual action grant in prepare.
  let issuerSql: string | undefined
  const operation = defineCommand({ ...command, permission: { entity: 'people', operation: 'read' }, plan: (ctx, input) => {
    const plan = command.plan(ctx, input)
    issuerSql = plan.rules[0].statements[0].sql
    return plan
  } })
  const context = coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  await expect(executeAtomic(operation, { rowId: 'p1', ...(action === 'link_account' ? { userId: 'dispatcher-a' } : {}) }, context)).rejects.toMatchObject({ status: 403, code: 'permission_denied' })
  expect(issuerSql).toBeUndefined()
  expect(await rows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})
it('Link relinks the same row with version increments and audits; only another row conflicts', async () => {
  for (const [index, user] of ['viewer-a', 'viewer-a', 'dispatcher-a'].entries()) {
    expect((await link('p1', user)).status).toBe(200)
    expect(await env.DB.prepare("SELECT user,version FROM people WHERE id='p1'").first()).toEqual({ user, version: index + 2 })
    expect(await env.DB.prepare("SELECT count(*) n FROM audit_outbox WHERE json_extract(payload,'$.operation')='account.linked'").first('n')).toBe(index + 1)
  }
  const conflict = await link('p2', 'dispatcher-a')
  expect([conflict.status, await json(conflict)]).toEqual([409, { error: 'account_already_linked' }])
  expect(await env.DB.prepare("SELECT user,version FROM people WHERE id='p1'").first()).toEqual({ user: 'dispatcher-a', version: 4 })
  expect(await env.DB.prepare("SELECT user,version FROM people WHERE id='p2'").first()).toEqual({ user: null, version: 1 })
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(3)
})
it.each(['remove_access', 'remove_member', 'leave'])('%s clears every registered link but keeps the account', async action => {
  const user = action === 'leave' ? 'dispatcher-a' : 'viewer-a'
  expect((await link('p1', user)).status).toBe(200)
  expect((await link('t1', user, 'owner-a', 'teams')).status).toBe(200)
  const response = action === 'remove_access' ? await request(app, '/commands/people/remove_access', 'POST', { rowId: 'p1' })
    : action === 'leave' ? await request(app, '/orgs/org-a/leave', 'POST', {}, user)
    : await request(app, `/orgs/org-a/members/${user}`, 'DELETE')
  expect(response.status).toBe(action === 'remove_access' ? 200 : 204)
  expect(await linked()).toBeNull(); expect(await linked('teams', 't1')).toBeNull()
  expect(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(user).first('id')).toBe(user)
})
it('last-owner removal rolls back link cleanup', async () => {
  expect((await link('p1', 'owner-a')).status).toBe(200)
  expect((await request(app, '/orgs/org-a/leave', 'POST', {})).status).toBe(409)
  expect(await linked()).toBe('owner-a')
})
it('direct and relation-nested $actor.id policies filter through the user link', async () => {
  await env.DB.exec("UPDATE people SET user='viewer-a' WHERE id='p1'; UPDATE people SET user='dispatcher-a' WHERE id='p2'; INSERT INTO tasks (id,organization_id,title,person,created_at,updated_at) VALUES ('own','org-a','Own','p1','now','now'),('other','org-a','Other','p2','now','now');")
  const c = config()
  c.policies.people.viewer = { where: { user: { eq: '$actor.id' } } }
  c.policies.tasks.viewer = { where: { person: { user: { eq: '$actor.id' } } } }
  app = createApp(c, runtime())
  for (const [entity, id] of [['people', 'p1'], ['tasks', 'own']]) {
    const response = await request(app, `/api/${entity}`, 'GET', undefined, 'viewer-a')
    expect(response.status).toBe(200)
    expect((await json(response)).data.map((row: { id: string }) => row.id)).toEqual([id])
  }
  c.policies.people.viewer = { where: { user_account: { id: { eq: '$actor.id' } } } }
  app = createApp(c, runtime())
  expect((await json(await request(app, '/api/people', 'GET', undefined, 'viewer-a'))).data.map((row: { id: string }) => row.id)).toEqual(['p1'])
})

it.each(['link', 'acceptance'] as const)('shared core %s writer rejects a duplicate in real D1 with 409', async caller => {
  const kernel = new KernelRegistry(config())
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const operation = defineCommand({ name: 'people/core_link_test', permission: { entity: 'people', operation: 'update' }, input: z.strictObject({ rowId: z.string() }), plan(ctx, input) {
    return { rules: caller === 'acceptance' ? invitationAccountLink(ctx, { entity: 'people', row: input.rowId }, 'viewer-a') : [linkAccountRow(ctx, 'people', input.rowId, 'viewer-a')],
      result: { status: 200, body: {} }, event: { operation: 'account.linked', entity: 'people', entityId: input.rowId } }
  } })
  kernel.config.commands.push(operation.name)
  const context = () => coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  await executeAtomic(operation, { rowId: 'p1' }, context())
  await expect(executeAtomic(operation, { rowId: 'p2' }, context())).rejects.toMatchObject({ status: 409, code: 'account_already_linked' })
  expect(await linked()).toBe('viewer-a')
  expect(await linked('people', 'p2')).toBeNull()
  expect(invitationAccountLink({ config: kernel.config, scope, now: 'now' }, {}, 'viewer-a')).toEqual([])
})
it('revocation and linking roll back together with their success audit', async () => {
  expect((await link()).status).toBe(200)
  expect((await link('t1', 'viewer-a', 'owner-a', 'teams')).status).toBe(200)
  await env.DB.exec("CREATE TRIGGER refuse_link_audit BEFORE INSERT ON audit_outbox BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;")
  expect((await request(app, '/orgs/org-a/members/viewer-a', 'DELETE')).status).toBe(409)
  expect(await linked()).toBe('viewer-a'); expect(await linked('teams', 't1')).toBe('viewer-a')
  expect(await env.DB.prepare("SELECT user_id FROM memberships WHERE user_id='viewer-a'").first('user_id')).toBe('viewer-a')
  expect((await link('p2', 'dispatcher-a')).status).toBe(409)
  expect(await linked('people', 'p2')).toBeNull()
})
it('config rejects malformed, defaulted, backfilled or undeclared user links', () => {
  for (const change of [
    { required: true }, { default: 'viewer-a' }, { backfillFrom: { refField: 'user', valueField: 'id' } }, { computed: 'name' },
    { type: 'string' }, { entity: 'people' }, { renameFrom: 'previous' },
  ]) {
    const c = config()
    Object.assign(c.entities.people.fields.user, change)
    expect(() => defineInstance(c)).toThrow(/Invalid user link/)
  }
  const c = config(); c.entities.people.relations = {}
  expect(() => defineInstance(c)).toThrow(/Invalid user link/)
})

it.each([
  "UPDATE OR REPLACE people SET user='viewer-a' WHERE id='p1'",
  "UPDATE main.people SET user='viewer-a' WHERE id='p1'",
  "UPDATE people SET 'user'='viewer-a' WHERE id='p1'",
  "INSERT OR REPLACE INTO people (id,organization_id,name,user,created_at,updated_at) VALUES ('new','org-a','New','viewer-a','now','now')",
  "INSERT INTO main.people (id,organization_id,name,user,created_at,updated_at) VALUES ('new','org-a','New','viewer-a','now','now')",
  "INSERT INTO people VALUES ('new','org-a','now','now',1,'New','viewer-a')",
  "INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p1','org-a','New','now','now') ON CONFLICT(id) DO UPDATE SET user='viewer-a'",
])('service workflow authority cannot bypass link protection with SQL variant %#', async sql => {
  const kernel = new KernelRegistry(config())
  const context = coreExecutionContext(kernel.config, { organizationId: 'org-a', role: 'SYSTEM', actor: { type: 'service', id: 'system' }, correlationId: 'service-link' }, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  await expect(executeAtomic({ ...write(sql), permission: { system: 'identity.write' } }, {}, context)).rejects.toMatchObject({ status: 400, code: 'protected_field' })
  expect(await linked()).toBeNull()
})
it('commands may read the link in an expression without assigning it', async () => {
  const op = write("UPDATE people SET name=COALESCE(user,'Unlinked') WHERE id='p1'")
  app = createApp({ ...config(), commands: [op.name] }, runtime(), { commands: createCommandRegistry([op]) })
  expect((await request(app, `/commands/${op.name}`, 'POST', {})).status).toBe(200)
  expect(await linked()).toBeNull()
})
it('replacement INSERT cannot implicitly clear an existing link, even with service authority', async () => {
  expect((await link()).status).toBe(200)
  const kernel = new KernelRegistry(config())
  const context = coreExecutionContext(kernel.config, { organizationId: 'org-a', role: 'SYSTEM', actor: { type: 'service', id: 'system' }, correlationId: 'replacement-link' }, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  const op = { ...write("INSERT OR REPLACE INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p1','org-a','Replaced','now','now')"), permission: { system: 'identity.write' as const } }
  await expect(executeAtomic(op, {}, context)).rejects.toMatchObject({ status: 400, code: 'protected_field' })
  expect(await linked()).toBe('viewer-a')
})
it.each(['create', 'edit'])('legacy admin %s rejects a tampered protected field with 400', async action => {
  const login = await request(app, '/auth/sign-in/magic-link', 'POST', { email: 'owner-a@example.test', callbackURL: '/admin' })
  expect(login.status).toBe(200)
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='owner-a@example.test' AND subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").first<string>('body')
  const verified = await app.request(url!)
  const cookie = verified.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))!.split(';')[0]
  const path = '/admin/o/org-a/entities/people' + (action === 'edit' ? '/p1/edit' : '')
  const page = await app.request(`http://localhost${action === 'edit' ? path : `${path}/new`}`, { headers: { Cookie: cookie } })
  const csrf = /name="_csrf" value="([a-f0-9]+)"/.exec(await page.text())![1]
  const response = await app.request(`http://localhost${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, name: 'Tampered', user: 'viewer-a', ...(action === 'edit' ? { version: '1' } : {}) }) })
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('protected_field')
  expect(await linked()).toBeNull()
})
it('revocation clears links even when other linked entities are outside the remover entity grants', async () => {
  expect((await link()).status).toBe(200)
  expect((await link('t1', 'viewer-a', 'owner-a', 'teams')).status).toBe(200)
  const c = config(); c.permissions.owner.teams = []; c.policies.teams.owner = 'none'
  app = createApp(c, runtime())
  expect((await request(app, '/commands/people/remove_access', 'POST', { rowId: 'p1' })).status).toBe(200)
  expect(await linked('teams', 't1')).toBeNull()
})
it('service multi-clause upsert cannot write a link through a later conflict arm', async () => {
  await env.DB.exec('CREATE UNIQUE INDEX people_name_unique_test ON people(name);')
  const kernel = new KernelRegistry(config())
  const context = coreExecutionContext(kernel.config, { organizationId: 'org-a', role: 'SYSTEM', actor: { type: 'service', id: 'system' }, correlationId: 'upsert-link' }, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  const op = { ...write("INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p1','org-a','New','now','now') ON CONFLICT(name) DO UPDATE SET name='Unchanged' ON CONFLICT(id) DO UPDATE SET user='viewer-a'"), permission: { system: 'identity.write' as const } }
  await expect(executeAtomic(op, {}, context)).rejects.toMatchObject({ status: 400, code: 'protected_field' })
  expect(await linked()).toBeNull()
})

const accountLinkRows = async () => (await env.DB.prepare('SELECT id,user,version,updated_at FROM people UNION ALL SELECT id,user,version,updated_at FROM teams ORDER BY id').all()).results
const resetAccountLinkRows = () => env.DB.exec("UPDATE people SET user='viewer-a',version=1,updated_at='now' WHERE id='p1'; UPDATE teams SET user='viewer-a',version=1,updated_at='now' WHERE id='t1'; DELETE FROM audit_outbox;")
function raceIssuerRole(c: ReturnType<typeof config>) {
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await env.DB.exec("UPDATE memberships SET role='viewer' WHERE user_id='owner-a' AND organization_id='org-a';")
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(c, { ...runtime(), DB: db })
  return () => expect(intercepted).toBe(true)
}
const accountLinkInput = (action: string) => ({ rowId: 'p1', ...(action === 'link_account' ? { userId: 'dispatcher-a' } : {}) })

it.each(['link_account', 'remove_access'].flatMap(action => ['actor.id', 'actor.role', 'field', 'none'].map(policy => ({ action, policy }))))
('live issuer policy denies without writes: $action $policy', async ({ action, policy }) => {
  const c = config()
  c.organizationPermissions.viewer = ['invitations.create']
  c.permissions.viewer.people = ['read', 'update']
  c.policies.people.viewer = policy === 'none' ? 'none' : { where: policy === 'actor.id'
    ? { user: { eq: '$actor.id' } } : policy === 'actor.role' ? { name: { eq: '$actor.role' } } : { name: { eq: 'Allowed' } } }
  await resetAccountLinkRows()
  const before = await accountLinkRows()
  const assertRaced = raceIssuerRole(c)
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  const after = await accountLinkRows()
  const audits = await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')
  assertRaced()
  // Compare a fresh request under the new role against the identical pre-image.
  await resetAccountLinkRows()
  const fresh = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect([fresh.status, await json(fresh)]).toEqual([403, { error: policy === 'none' ? 'permission_denied' : 'policy_violation' }])
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(after).toEqual(before)
  expect(audits).toBe(0)
  expect(await accountLinkRows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})

it.each(['link_account', 'remove_access'])('live issuer permission uses the actual action input: %s', async action => {
  const c = config()
  c.organizationPermissions.viewer = ['invitations.create']
  const observed: unknown[] = []
  const guard: WorkbasePlugin = { name: 'action-input-guard', version: '0.1.0', commandGuard(command, scope, input) {
    if (command.kind === 'command' && command.name === `people/${action}` && scope.role === 'viewer') {
      observed.push(input)
      if ((input as { rowId?: string } | undefined)?.rowId === 'p1') return { allow: false, code: 'permission_denied' }
    }
    return { allow: true }
  } }
  c.plugins = [...(c.plugins ?? []), guard]
  await resetAccountLinkRows()
  const before = await accountLinkRows()
  const assertRaced = raceIssuerRole(c)
  const input = accountLinkInput(action)
  const response = await request(app, `/commands/people/${action}`, 'POST', input)
  assertRaced()
  const fresh = await request(app, `/commands/people/${action}`, 'POST', input)
  expect([fresh.status, await json(fresh)]).toEqual([403, { error: 'permission_denied' }])
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(await accountLinkRows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
  expect(observed).toEqual([input])
})

it.each(['link_account', 'remove_access'])('input guard admits a valid owner action: %s', async action => {
  const c = config()
  const guard: WorkbasePlugin = { name: 'action-input-guard', version: '0.1.0', commandGuard(command, _scope, input) {
    return command.kind === 'command' && command.name === `people/${action}` && (input as { rowId?: string } | undefined)?.rowId !== 'p1'
      ? { allow: false, code: 'permission_denied' } : { allow: true }
  } }
  app = createApp({ ...c, plugins: [...(c.plugins ?? []), guard] }, runtime())
  await resetAccountLinkRows()
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect([response.status, await json(response)]).toEqual([200, { id: 'p1' }])
  expect(await linked()).toBe(action === 'link_account' ? 'dispatcher-a' : null)
  expect(await linked('teams', 't1')).toBe(action === 'link_account' ? 'viewer-a' : null)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
})

it.each(['actor.id', 'relation', 'field'])('Link checks the live policy on its post-image: %s', async policy => {
  const c = config()
  c.organizationPermissions.owner = ['invitations.create']
  c.policies.people.owner = { where: policy === 'actor.id' ? { user: { eq: '$actor.id' } }
    : policy === 'relation' ? { user_account: { id: { eq: '$actor.id' } } } : { user: { eq: 'owner-a' } } }
  await resetAccountLinkRows()
  await env.DB.exec("UPDATE people SET user='owner-a' WHERE id='p1';")
  const before = await accountLinkRows()
  app = createApp(c, runtime())
  const response = await link('p1', 'dispatcher-a')
  const after = await accountLinkRows()
  const audits = await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')
  await resetAccountLinkRows()
  await env.DB.exec("UPDATE people SET user='owner-a' WHERE id='p1';")
  const fresh = await link('p1', 'dispatcher-a')
  expect([fresh.status, await json(fresh)]).toEqual([403, { error: 'policy_violation' }])
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(after).toEqual(before)
  expect(audits).toBe(0)
  expect(await accountLinkRows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})

it.each(['link_account', 'remove_access'].flatMap(action => ['all', 'relation', 'actor.role'].map(policy => ({ action, policy }))))
('changed role is rejected even when its policy allows: $action $policy', async ({ action, policy }) => {
  const c = config()
  c.organizationPermissions.viewer = ['invitations.create']
  c.policies.people.owner = { where: { user: { eq: 'viewer-a' } } }
  c.policies.people.viewer = policy === 'all' ? 'all' : { where: policy === 'relation'
    ? { user_account: { organization_id: { eq: '$actor.organization_id' } } } : { name: { eq: '$actor.role' } } }
  if (policy === 'relation') c.policies.users.viewer = { where: { role: { ne: 'owner' } } }
  await resetAccountLinkRows()
  if (policy === 'actor.role') await env.DB.exec("UPDATE people SET name='viewer' WHERE id='p1';")
  const before = await accountLinkRows()
  const assertRaced = raceIssuerRole(c)
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  assertRaced()
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(await accountLinkRows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
  const fresh = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect([fresh.status, await json(fresh)]).toEqual([200, { id: 'p1' }])
  expect(await linked()).toBe(action === 'link_account' ? 'dispatcher-a' : null)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
})

it.each(['link_account', 'remove_access'])('live related-entity policy denies without writes: %s', async action => {
  const c = config()
  c.organizationPermissions.viewer = ['invitations.create']
  c.policies.people.viewer = { where: { user_account: { id: { eq: 'viewer-a' } } } }
  c.policies.users.viewer = { where: { id: { eq: '$actor.id' } } }
  await resetAccountLinkRows()
  const before = await accountLinkRows()
  const assertRaced = raceIssuerRole(c)
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  assertRaced()
  const after = await accountLinkRows()
  const audits = await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')
  await resetAccountLinkRows()
  const fresh = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect([fresh.status, await json(fresh)]).toEqual([403, { error: 'policy_violation' }])
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(after).toEqual(before)
  expect(audits).toBe(0)
})

it.each(['link_account', 'remove_access'].flatMap(action => ['bindings', 'references'].map(budget => ({ action, budget }))))
('prepare propagates its own policy compiler budget: $action $budget', async ({ action, budget }) => {
  const c = config()
  c.organizationPermissions.viewer = ['invitations.create']
  if (budget === 'bindings') {
    c.policies.people.viewer = { where: { or: Array.from({ length: 101 }, () => ({ name: { eq: 'One' } })) } }
  } else {
    // Each individual policy is valid, but their scoped relation expansion cycles.
    c.entities.users.relations.people = { entity: 'people', field: 'user', many: true }
    c.policies.people.viewer = { where: { user_account: { id: { eq: 'viewer-a' } } } }
    c.policies.users.viewer = { where: { people: { some: { name: { eq: 'One' } } } } }
  }
  await resetAccountLinkRows()
  const before = await accountLinkRows()
  let batches = 0
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return (...args: Parameters<D1Database['batch']>) => { batches++; return target.batch(...args) }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(c, { ...runtime(), DB: db })
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action), 'viewer-a')
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(batches).toBe(0)
  expect(await accountLinkRows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})

it.each(['link_account', 'remove_access'].flatMap(action => [10, 60, 98].map(comparisons => ({ action, comparisons }))))
('variant C ignores a non-actor policy: $action $comparisons comparisons', async ({ action, comparisons }) => {
  const c = config()
  c.organizationPermissions.viewer = ['invitations.create']
  c.policies.people.viewer = { where: { or: Array.from({ length: comparisons }, () => ({ name: { eq: 'One' } })) } }
  app = createApp(c, runtime())
  await resetAccountLinkRows()
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect([response.status, await json(response)]).toEqual([200, { id: 'p1' }])
  expect(await linked()).toBe(action === 'link_account' ? 'dispatcher-a' : null)
  expect(await linked('teams', 't1')).toBe(action === 'link_account' ? 'viewer-a' : null)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
})

it.each(['link_account', 'remove_access'])('variant C bounds the emitted batch to one of eight role policies: %s', async action => {
  const c = config()
  c.roles = ['owner', 'dispatcher', 'viewer', 'member', 'role4', 'role5', 'role6', 'role7']
  c.pluginConfig = { ...c.pluginConfig, permissions: { roles: c.roles, ownerRole: 'owner' } }
  for (const role of c.roles) {
    c.organizationPermissions[role] = ['invitations.create']
    c.permissions[role] = { users: ['read'], people: ['read', 'update'] }
    c.policies.people[role] = { where: { or: Array.from({ length: 40 }, () => ({ name: { eq: 'One' } })) } }
  }
  await resetAccountLinkRows()
  const kernel = new KernelRegistry(c)
  expect(kernel.config.roles).toHaveLength(8)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const command = userLinkCommands(kernel.config).find(command => command.name === `people/${action}`)!
  const ownerFilter = writeFilter(kernel, scope, 'people')
  let captured = false
  const context = coreExecutionContext(kernel.config, scope, { async run(plan) {
    captured = true
    // Match the complete compiled owner filter, including its organization scope.
    const occurrences = (sql: string) => sql.split(ownerFilter.sql).length - 1
    expect(plan.rules.filter(rule => ['account_link_issuer', 'account_link', 'account_unlink'].includes(rule.name))
      .flatMap(rule => rule.statements.map(statement => ({ rule: rule.name,
        where: occurrences(statement.sql), filter: statement.policyGuard ? occurrences(statement.policyGuard.filter.sql) : 0 }))))
      .toEqual(action === 'link_account'
        ? [{ rule: 'account_link_issuer', where: 1, filter: 0 }, { rule: 'account_link', where: 0, filter: 1 }]
        : [{ rule: 'account_link_issuer', where: 1, filter: 0 },
          { rule: 'account_unlink', where: 0, filter: 0 }, { rule: 'account_unlink', where: 0, filter: 0 },
          { rule: 'account_unlink', where: 0, filter: 0 }])
    const statements = compile(plan)
    expect(statements.every(statement => !statement.sql.includes('policy_issuer'))).toBe(true)
    expect(statements.filter(statement => occurrences(statement.sql)).map(statement => occurrences(statement.sql)))
      .toEqual(Array(action === 'link_account' ? 4 : 1).fill(1))
    const bindingCounts = statements.map(statement => statement.bindings?.length ?? 0)
    expect(bindingCounts.every(count => count <= 100)).toBe(true)
    expect(Math.max(...bindingCounts)).toBe(action === 'link_account' ? 51 : 48)
    return { changes: [] }
  } }, new D1AtomicReader(env.DB))
  expect((await executeAtomic(command, accountLinkInput(action), context)).status).toBe(200)
  expect(captured).toBe(true)
})

it.each(['link_account', 'remove_access'])('variant C rejects owner to equally eligible dispatcher with no writes: %s', async action => {
  const c = config()
  c.organizationPermissions.dispatcher = ['invitations.create']
  await resetAccountLinkRows()
  const before = await accountLinkRows()
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await env.DB.exec("UPDATE memberships SET role='dispatcher' WHERE user_id='owner-a' AND organization_id='org-a';")
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(c, { ...runtime(), DB: db })
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect(intercepted).toBe(true)
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(await accountLinkRows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
  // The new role passes the same request after the client reloads its scope.
  const fresh = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect([fresh.status, await json(fresh)]).toEqual([200, { id: 'p1' }])
  expect(await linked()).toBe(action === 'link_account' ? 'dispatcher-a' : null)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
})

it.each(['link_account', 'remove_access'])('variant C rejects deleted issuer membership with no writes: %s', async action => {
  await resetAccountLinkRows()
  const before = await accountLinkRows()
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await env.DB.exec("DELETE FROM memberships WHERE user_id='owner-a' AND organization_id='org-a';")
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(config(), { ...runtime(), DB: db })
  const response = await request(app, `/commands/people/${action}`, 'POST', accountLinkInput(action))
  expect(intercepted).toBe(true)
  expect([response.status, await json(response)]).toEqual([403, { error: 'policy_violation' }])
  expect(await accountLinkRows()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})
