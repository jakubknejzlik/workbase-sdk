import { effectiveEntityGrants } from '../src/access-evaluator'
import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { defineConfig, defineEntity, accountLink, defineAccess } from '../src/schema'
import { accessEntities, accessSystemActions, type EntityAccess } from '../src/access'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { hasOwnerRole } from '../src/policies'
import { effectiveRolePrivileges, organizationPermission } from '../src/organization-permissions'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { sha256 } from '../src/crypto'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'

const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
const self = { where: { use: 'self' }, fields: ['id', 'name', 'version'] }
function config(matrix: EntityAccess = { admin: all, staff: { read: self, create: 'deny', update: { where: { use: 'self' } }, delete: 'deny' } }) {
  return defineConfig({ id: 'access_test', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['en'],
    plugins: [identity, localAuth, legacyPermissions, members, organizations, machineCredentials(), mailOutbox()], interactive: false,
    entities: { worker: defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() }, access: matrix }) },
    access: defineAccess({ roles: Object.fromEntries(['admin', 'staff'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'allow'])) }])),
      entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: entity === 'memberships' || entity === 'invitations' ? 'deny' : all, staff: 'deny' }])),
      predicates: { self: { user: { eq: '$actor.id' } } },
    }),
  })
}
const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-access-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-access-secret-at-least-32', localPassword: true } })
async function setup(selected = config()) {
  await reset()
  await bootstrap(env.DB, selected)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B');")
  for (const [id, role, org] of [['admin', 'admin', 'org-a'], ['staff', 'staff', 'org-a'], ['other', 'staff', 'org-a'], ['foreign', 'staff', 'org-b']]) {
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, `${id}@example.test`, 'x', 'x', org, id, role, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `${id}@example.test`, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, org, role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, new Date(Date.now() + 86400000).toISOString()).run()
    await env.DB.prepare('INSERT INTO worker (id,organization_id,name,user,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(`worker-${id}`, org, id, id, 'now', 'now').run()
  }
  return { app: createApp(selected, runtime()), kernel: new KernelRegistry(selected) }
}
function request(path: string, role = 'staff', method = 'GET', body?: object) {
  return new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer synthetic-${role}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json', 'If-Match': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
beforeEach(async () => { await reset() })
it('staff reads only its linked worker through kernel CRUD and applies the read mask', async () => {
  const { app } = await setup()
  const list = await app.fetch(request('/api/worker'))
  expect(list.status).toBe(200)
  expect((await list.json() as any).data).toEqual([{ id: 'worker-staff', name: 'staff', version: 1 }])
  expect((await app.fetch(request('/api/worker/worker-other'))).status).toBe(404)
})
it('staff can update its linked worker but cannot update another worker through kernel CRUD', async () => {
  const { app } = await setup()
  expect((await app.fetch(request('/api/worker/worker-staff', 'staff', 'PATCH', { name: 'updated' }))).status).toBe(200)
  expect((await app.fetch(request('/api/worker/worker-other', 'staff', 'PATCH', { name: 'forbidden' }))).status).toBe(404)
  expect(await env.DB.prepare('SELECT name FROM worker WHERE id=?').bind('worker-other').first('name')).toBe('other')
})
it('admin and staff cannot read or mutate rows from another organization through kernel CRUD', async () => {
  const { app } = await setup()
  for (const role of ['admin', 'staff']) {
    expect((await app.fetch(request('/api/worker/worker-foreign', role))).status).toBe(404)
    const list = await app.fetch(request('/api/worker', role))
    expect(JSON.stringify(await list.json())).not.toContain('worker-foreign')
    expect((await app.fetch(request('/api/worker/worker-foreign', role, 'PATCH', { name: 'forbidden' }))).status).toBe(404)
  }
})
it('write grants do not imply read, and each mutation uses its own policy', async () => {
  const { app } = await setup(config({ admin: all, staff: { read: 'deny', create: 'allow', update: { where: { use: 'self' } }, delete: 'deny' } }))
  expect((await app.fetch(request('/api/worker'))).status).toBe(403)
  const updated = await app.fetch(request('/api/worker/worker-staff', 'staff', 'PATCH', { name: 'written' }))
  expect(updated.status).toBe(200)
  expect(await updated.json()).toEqual({})
  expect((await app.fetch(request('/api/worker', 'staff', 'POST', { name: 'created' }))).status).toBe(201)
  expect((await app.fetch(request('/api/worker/worker-staff', 'staff', 'DELETE'))).status).toBe(403)
})
it('authored SDK system denial beats members.read and invitations.read default privileges', async () => {
  const { app, kernel } = await setup()
  expect(kernel.config.roles).toEqual(['admin', 'staff'])
  for (const action of ['members.read', 'invitations.read'] as const) {
    const scope = await requireScope(await resolveActor(request('/'), runtime(), kernel.config), 'org-a', kernel.config)
    expect(() => kernel.resourcePermission(scope, action)).toThrow('permission_denied')
  }
  expect((await app.fetch(request('/orgs/org-a/members', 'admin'))).status).toBe(403)
  expect((await app.fetch(request('/orgs/org-a/invitations', 'admin'))).status).toBe(403)
})
it('combined admin and explicitly denied staff stays denied at the kernel authorization port', async () => {
  const { app, kernel } = await setup(config({ admin: all, staff: 'deny' }))
  const token = 'wb_synthetic_combined'
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind('combined', 'org-a', 'staff', 'Combined roles', await sha256(token), 'wb_synthetic', 'admin', '2099-01-01T00:00:00.000Z', 'now').run()
  const credential = request('/')
  credential.headers.set('Authorization', `Bearer ${token}`)
  const combined = await requireScope(await resolveActor(credential, runtime(), kernel.config), 'org-a', kernel.config)
  expect(kernel.tableFilter('worker', combined).kind).toBe('none')
  expect(kernel.fieldMask('worker', combined)).toEqual([])
  expect(() => kernel.permission(combined, 'worker', 'update')).toThrow('permission_denied')
  const update = request('/api/worker/worker-staff', 'staff', 'PATCH', { name: 'forbidden' })
  update.headers.set('Authorization', `Bearer ${token}`)
  expect((await app.fetch(update)).status).toBe(403)
})
it('combines grants by union while none and unknown roles cannot create grants', async () => {
  const selected = config({ admin: { ...all, read: 'none' }, staff: { ...all, update: 'none' } })
  const policy = selected.effectiveAccess!
  expect(effectiveEntityGrants(policy, ['admin', 'staff'], 'worker', 'read')).toHaveLength(1)
  expect(effectiveEntityGrants(policy, ['admin', 'staff'], 'worker', 'update')).toHaveLength(1)
  expect(effectiveEntityGrants(policy, ['unknown'], 'worker', 'read')).toEqual([])
})

it('create, update and delete evaluate their own predicates independently of read', async () => {
  const { app } = await setup(config({ admin: all, staff: {
    read: 'allow', create: { where: { name: { eq: 'permitted' } } },
    update: { where: { use: 'self' } }, delete: { where: { use: 'self' } },
  } }))
  expect((await app.fetch(request('/api/worker/worker-other'))).status).toBe(200)
  expect((await app.fetch(request('/api/worker', 'staff', 'POST', { name: 'forbidden' }))).status).toBe(403)
  expect(await env.DB.prepare('SELECT count(*) AS count FROM worker WHERE name=?').bind('forbidden').first('count')).toBe(0)
  expect((await app.fetch(request('/api/worker', 'staff', 'POST', { name: 'permitted' }))).status).toBe(201)
  expect((await app.fetch(request('/api/worker/worker-other', 'staff', 'PATCH', { name: 'forbidden' }))).status).toBe(404)
  expect((await app.fetch(request('/api/worker/worker-other', 'staff', 'DELETE'))).status).toBe(404)
  expect((await app.fetch(request('/api/worker/worker-staff', 'staff', 'DELETE'))).status).toBe(204)
})
it('direct organization permission and effective privileges share authored system denials', async () => {
  const { kernel } = await setup()
  const scope = await requireScope(await resolveActor(request('/', 'admin'), runtime(), kernel.config), 'org-a', kernel.config)
  expect(() => organizationPermission(kernel.config, scope, 'members.read')).toThrow('permission_denied')
  expect(effectiveRolePrivileges(kernel.config, 'admin').has('system:members.read')).toBe(false)
  expect(kernel.config.organizationPermissions.admin).not.toContain('members.read')
})
it('schema-only slice-1 declarations cannot acquire legacy authorization defaults when executed', () => {
  const declaration = defineConfig({ id: 'schema_only', roles: ['admin'], organizationOwnerRole: 'admin', languages: ['en'], entities: {} })
  expect(() => new KernelRegistry(declaration)).toThrow('explicit entity access and shared access.ts')
})

it('atomic writes and idempotent replay use the write policy when read is denied', async () => {
  const { kernel } = await setup(config({ admin: all, staff: { read: 'deny', create: 'deny', update: { where: { use: 'self' } }, delete: 'deny' } }))
  const { z } = await import('zod')
  const { executeAtomic } = await import('../src/execution/atomic')
  const { coreExecutionContext } = await import('../src/execution/context')
  const { D1AtomicStore, D1AtomicReader } = await import('../src/execution/d1')
  const { createCommandRegistry } = await import('../src/commands')
  const operation = {
    name: 'worker/change', permission: { entity: 'worker', operation: 'update' as const }, input: z.strictObject({}),
    plan: () => ({ rules: [{ name: 'change', statements: [{ sql: 'UPDATE worker SET name=? WHERE id=?', bindings: ['atomic', 'worker-staff'], expectRows: 1 as const }] }],
      result: { status: 200, body: { ok: true } }, event: { entity: 'worker', entityId: 'worker-staff', operation: 'worker.changed' } }),
  }
  const bound = new KernelRegistry({ ...kernel.config, commands: [operation.name] }, { commands: createCommandRegistry([operation]) })
  const scope = await requireScope(await resolveActor(request('/'), runtime(), bound.config), 'org-a', bound.config)
  const context = () => coreExecutionContext(bound.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB), 'synthetic-write-replay')
  expect(await executeAtomic(operation, {}, context())).toMatchObject({ status: 200 })
  expect(await executeAtomic(operation, {}, context())).toMatchObject({ status: 200 })
  expect(await env.DB.prepare('SELECT name FROM worker WHERE id=?').bind('worker-staff').first('name')).toBe('atomic')
})

it('authored system grants admit custom-role audit readers and explicit denial beats built-in owner privileges', async () => {
  const { kernel } = await setup()
  const admin = await requireScope(await resolveActor(request('/', 'admin'), runtime(), kernel.config), 'org-a', kernel.config)
  expect(hasOwnerRole(admin, kernel.config)).toBe(true)
  expect(() => kernel.resourcePermission(admin, 'audit.read')).not.toThrow()
  const owner = defineConfig({ id: 'owner_probe', roles: ['owner'], organizationOwnerRole: 'owner', languages: ['en'], entities: {},
    access: defineAccess({ predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: 'deny' }])),
      roles: { owner: { system: Object.fromEntries(accessSystemActions.map(action => [action, 'allow'])) } },
    }),
  })
  expect([...effectiveRolePrivileges(owner, 'owner')]).toEqual([])
})

it('normalizes registered command guards and enforces their additional permissions from the audit input', async () => {
  const { kernel } = await setup()
  const { z } = await import('zod')
  const { createCommandRegistry } = await import('../src/commands')
  const operation = {
    name: 'worker/guarded', permission: { entity: 'worker', operation: 'update' as const },
    additionalPermissions: [{ entity: 'memberships', operation: 'read' as const }], input: z.strictObject({}),
    plan: () => ({ rules: [], result: { status: 200, body: {} }, event: { entity: 'worker', entityId: '', operation: 'worker.guarded' } }),
  }
  const bound = new KernelRegistry({ ...kernel.config, commands: [operation.name] }, { commands: createCommandRegistry([operation]) })
  const policy = bound.config.effectiveAccess!
  expect(policy.guards.find(guard => guard.name === operation.name)).toEqual({ name: operation.name, permission: operation.permission, additionalPermissions: operation.additionalPermissions, opaque: true })
  expect(policy.opaqueHooks).toContain('members.tableFilter')
  const scope = await requireScope(await resolveActor(request('/'), runtime(), bound.config), 'org-a', bound.config)
  // Even a caller omitting the additional grant cannot evade the registered guard.
  expect(() => bound.atomicPermission(scope, { ...operation, additionalPermissions: [] })).toThrow('permission_denied')
  const admin = await requireScope(await resolveActor(request('/', 'admin'), runtime(), bound.config), 'org-a', bound.config)
  expect(() => bound.atomicPermission(admin, { ...operation, permission: { system: 'tokens.read' }, additionalPermissions: [] })).toThrow('permission_denied')
})
it('normalizes command declaration order and marks unresolved executable guards explicitly', async () => {
  const selected = config()
  const { accessGuards } = await import('../src/access-guards')
  const policy = selected.effectiveAccess!
  const a = accessGuards(policy, ['worker/b', 'worker/a'], [], selected.plugins!)
  const b = accessGuards(policy, ['worker/a', 'worker/b'], [], [...selected.plugins!].reverse())
  expect(a).toEqual(b)
  expect(a.guards).toEqual(['worker/a', 'worker/b'].map(name => ({ name, permission: null, additionalPermissions: [], opaque: true })))
})

async function reviewToken(app: ReturnType<typeof createApp>, issuer: string, role: string, operations: string[] = ['worker.read', 'worker.update']) {
  const token = `wb_review_${issuer}_${role}`
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,operations,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(`review-${issuer}-${role}`, 'org-a', issuer, 'Review probe', await sha256(token), 'wb_review', role, JSON.stringify(operations), '2099-01-01T00:00:00.000Z', 'now').run()
  return (path: string, method = 'GET', body?: object) => { const req = request(path, issuer, method, body); req.headers.set('Authorization', `Bearer ${token}`); return app.fetch(req) }
}
it.each([['admin', 'staff'], ['staff', 'admin']])('credential and principal independently cap rows, fields and writes: issuer=%s credential=%s', async (issuer, role) => {
  const { app } = await setup(config({ admin: all, staff: { read: self, create: 'none', update: { where: { use: 'self' } }, delete: 'none' } }))
  const call = await reviewToken(app, issuer, role)
  const list = await call('/api/worker')
  const data = await list.json() as any
  expect(list.status).toBe(200)
  expect(data.data).toEqual([{ id: `worker-${issuer}`, name: issuer, version: 1 }])
  const update = await call('/api/worker/worker-other', 'PATCH', { name: 'escalated' })
  expect(update.status).toBe(404)
  expect(await env.DB.prepare('SELECT name FROM worker WHERE id=?').bind('worker-other').first('name')).toBe('other')
  const excludedOperation = await call('/api/worker', 'POST', { name: 'blocked-by-name' })
  expect(excludedOperation.status).toBe(403)
})
it.each([['admin', 'staff'], ['staff', 'admin']])('none in either authority layer caps create: issuer=%s credential=%s', async (issuer, role) => {
  const { app } = await setup(config({ admin: all, staff: { read: self, create: 'none', update: 'none', delete: 'none' } }))
  const call = await reviewToken(app, issuer, role, ['worker.create'])
  const created = await call('/api/worker', 'POST', { name: 'credential-has-no-create' })
  expect(created.status).toBe(403)
  expect(await env.DB.prepare('SELECT count(*) AS count FROM worker WHERE name=?').bind('credential-has-no-create').first('count')).toBe(0)
})
it('relation update binds child predicates correctly', async () => {
  const { app } = await setup(config({ admin: { ...all, update: { where: { user_account: { name: { eq: 'other' } } } } }, staff: 'deny' }))

  const response = await app.fetch(request('/api/worker/worker-other', 'admin', 'PATCH', { name: 'cross-org' }))
  expect(response.status).toBe(200)
  expect(await env.DB.prepare('SELECT name FROM worker WHERE id=?').bind('worker-other').first('name')).toBe('cross-org')
})

it.each([false, true])('custom permissions allow hooks remain bound by authored row filters, masks and grants (mask hook=%s)', async (maskHook) => {
  const selected = config()
  const provider = { name: 'custom-permissions', version: '1.0.0', provides: { permissions: '1.x' as const }, authorization: true,
    tableFilter: () => ({ kind: 'all' as const }), commandGuard: () => ({ allow: true as const }),
    ...(maskHook ? { fieldMask: () => ['id', 'name', 'user', 'organization_id', 'version', 'created_at', 'updated_at'] } : {}) }
  const { app } = await setup({ ...selected, plugins: selected.plugins!.map(p => p.name === 'rbac' ? provider : p) })
  const response = await app.fetch(request('/api/worker'))
  const data = await response.json() as any
  expect(response.status).toBe(200)
  expect(data.data).toEqual([{ id: 'worker-staff', name: 'staff', version: 1 }])
  const update = await app.fetch(request('/api/worker/worker-other', 'staff', 'PATCH', { name: 'custom-bypass' }))
  expect(update.status).toBe(404)
  expect(await env.DB.prepare('SELECT name FROM worker WHERE id=?').bind('worker-other').first('name')).toBe('other')
  expect((await app.fetch(request('/api/worker', 'staff', 'POST', { name: 'custom-create' }))).status).toBe(403)
})
it('direct atomic update enforces organization pin even without SQL organization predicate', async () => {
  const { kernel } = await setup()
  const { z } = await import('zod')
  const { executeAtomic } = await import('../src/execution/atomic')
  const { coreExecutionContext } = await import('../src/execution/context')
  const { D1AtomicStore, D1AtomicReader } = await import('../src/execution/d1')
  const { createCommandRegistry } = await import('../src/commands')
  const operation = {
    name: 'worker/review_foreign', permission: { entity: 'worker', operation: 'update' as const }, input: z.strictObject({}),
    plan: () => ({ rules: [{ name: 'change', statements: [{ sql: 'UPDATE worker SET name=? WHERE id=?', bindings: ['foreign-write', 'worker-foreign'], expectRows: 1 as const }] }],
      result: { status: 200, body: {} }, event: { entity: 'worker', entityId: 'worker-foreign', operation: 'worker.changed' } }),
  }
  const bound = new KernelRegistry({ ...kernel.config, commands: [operation.name] }, { commands: createCommandRegistry([operation]) })
  const scope = await requireScope(await resolveActor(request('/', 'admin'), runtime(), bound.config), 'org-a', bound.config)
  const ctx = coreExecutionContext(bound.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  await expect(executeAtomic(operation, {}, ctx)).rejects.toThrow('policy_violation')
  expect(await env.DB.prepare('SELECT name FROM worker WHERE id=?').bind('worker-foreign').first('name')).toBe('foreign')
})

it('relation renderer pins child/root org and keeps positional binding order', async () => {
  const { kernel } = await setup()
  const { writeFilter } = await import('../src/execution/policies')
  const scope = await requireScope(await resolveActor(request('/', 'admin'), runtime(), kernel.config), 'org-a', kernel.config)
  const fakeKernel = { config: kernel.config, tableFilter: (entity: string) => entity === 'worker'
    ? { kind: 'where', predicate: { exists: { entity: 'users', field: 'id', parentField: 'name', predicate: { name: { eq: 'foreign' } } } } }
    : { kind: 'all' } } as unknown as KernelRegistry
  const filter = writeFilter(fakeKernel, scope, 'worker', 'worker', 'update')
  expect(filter.bindings).toEqual(['foreign', 'org-a', 'org-a'])
  await env.DB.prepare('UPDATE worker SET name=? WHERE id=?').bind('foreign', 'worker-other').run()
  const rows = await env.DB.prepare(`SELECT id FROM worker WHERE ${filter.sql}`).bind(...filter.bindings!).all()
  expect(rows.results).toEqual([])
})
it('unknown actor roles/resources and unresolved entity commands fail closed', async () => {
  const { kernel } = await setup()
  const scope = await requireScope(await resolveActor(request('/', 'admin'), runtime(), kernel.config), 'org-a', kernel.config)
  const { systemAccessTarget } = await import('../src/access-evaluator')
  for (const action of accessSystemActions) expect(systemAccessTarget(action).entity).toBeTypeOf('string')
  expect(systemAccessTarget('unmapped.read').entity).toBeUndefined()
  expect(() => kernel.resourcePermission(scope, 'unmapped.read' as any)).toThrow('permission_denied')
  expect(effectiveEntityGrants(kernel.config.effectiveAccess!, ['admin', 'unknown'], 'worker', 'read')).toEqual([])
  expect(() => kernel.commandGuard({ kind: 'command', name: 'worker/unresolved', permission: { entity: 'worker', operation: 'update' } }, scope, undefined)).toThrow('unsupported_command')
})

it('capabilities list allowed mutations using each operation filter when read is denied', async () => {
  const { app } = await setup(config({ admin: all, staff: { read: 'deny', create: 'allow', update: { where: { use: 'self' } }, delete: 'deny' } }))
  const response = await app.fetch(request('/o/org-a/capabilities'))
  expect(response.status).toBe(200)
  const data = await response.json() as any
  expect(data.entities.worker.operations).toEqual(['create', 'update'])
  expect((await app.fetch(request('/api/worker', 'staff', 'POST', { name: 'actually-allowed' }))).status).toBe(201)
  expect((await app.fetch(request('/api/worker/worker-staff', 'staff', 'PATCH', { name: 'also-allowed' }))).status).toBe(200)
})

it('narrow credential cannot inherit principal sensitive field grant', async () => {
  const selected = defineConfig({ id: 'secret_probe', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['en'],
    plugins: config().plugins, interactive: false,
    entities: { worker: defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink(), secret: { type: 'text', sensitive: true } },
      access: { admin: { ...all, read: { where: {}, fields: ['id', 'name', 'secret'] } }, staff: { read: self, create: 'none', update: { where: { use: 'self' } }, delete: 'none' } } }) },
    access: defineAccess({ roles: Object.fromEntries(['admin', 'staff'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) }])),
      entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: all, staff: 'deny' }])), predicates: { self: { user: { eq: '$actor.id' } } } }),
  })
  const { app } = await setup(selected)
  await env.DB.prepare('UPDATE worker SET secret=? WHERE id=?').bind('synthetic-confidential', 'worker-other').run()
  const staffResponse = await app.fetch(request('/api/worker'))
  expect((await staffResponse.json() as any).data).toEqual([{ id: 'worker-staff', name: 'staff', version: 1 }])
  const call = await reviewToken(app, 'admin', 'staff')
  const response = await call('/api/worker/worker-other')
  expect(response.status).toBe(404)
  const own = await call('/api/worker/worker-admin')
  expect(own.status).toBe(200)
  expect(await own.json()).toEqual({ id: 'worker-admin', name: 'admin' })
})

it.each([['admin', 'staff', 'none'], ['staff', 'admin', 'none'], ['admin', 'staff', 'deny'], ['staff', 'admin', 'deny']] as const)(
  'system and command guards require both layers: issuer=%s credential=%s staff=%s', async (issuer, role, decision) => {
    const selected = config({ admin: all, staff: all })
    // Permit the target entity in both roles to isolate the system-action cap.
    selected.effectiveAccess = { ...selected.effectiveAccess!,
      entities: selected.effectiveAccess!.entities.map(rule => rule.entity === 'audit_events' ? { ...rule, decision: 'allow' as const } : rule),
      system: selected.effectiveAccess!.system.map(rule => rule.role === 'staff' && rule.action === 'audit.read' ? { ...rule, decision } : rule),
    }
    const { app, kernel } = await setup(selected)
    await reviewToken(app, issuer, role, ['audit.read', 'worker/system_guard'])
    const req = request('/')
    req.headers.set('Authorization', `Bearer wb_review_${issuer}_${role}`)
    const scope = await requireScope(await resolveActor(req, runtime(), kernel.config), 'org-a', kernel.config)
    expect(hasOwnerRole(scope, kernel.config)).toBe(false)
    expect(() => kernel.resourcePermission(scope, 'audit.read')).toThrow('permission_denied')
    expect(() => kernel.commandGuard({ name: 'worker/system_guard', kind: 'command', permission: { system: 'audit.read' } }, scope, {})).toThrow('permission_denied')
  },
)
it('custom provider hooks can further narrow compiled rows, masks and commands', async () => {
  const selected = config()
  const provider = { name: 'custom-permissions', version: '1.0.0', provides: { permissions: '1.x' as const }, authorization: true,
    tableFilter: () => ({ kind: 'where' as const, predicate: { name: { eq: 'other' } } }),
    fieldMask: () => ['id', 'organization_id'], commandGuard: () => ({ allow: false as const, code: 'custom_denial' }),
  }
  const { kernel } = await setup({ ...selected, plugins: selected.plugins!.map(p => p.name === 'rbac' ? provider : p) })
  const scope = await requireScope(await resolveActor(request('/'), runtime(), kernel.config), 'org-a', kernel.config)
  expect(kernel.fieldMask('worker', scope)).toEqual(['id'])
  expect(() => kernel.permission(scope, 'worker', 'update')).toThrow('custom_denial')
  const { writeFilter } = await import('../src/execution/policies')
  const filter = writeFilter(kernel, scope, 'worker', 'worker', 'update')
  expect((await env.DB.prepare(`SELECT id FROM worker WHERE ${filter.sql}`).bind(...filter.bindings!).all()).results).toEqual([])
})
it('atomic write guards intersect credential and issuer predicates', async () => {
  const { app, kernel } = await setup()
  const { z } = await import('zod')
  const { executeAtomic } = await import('../src/execution/atomic')
  const { coreExecutionContext } = await import('../src/execution/context')
  const { D1AtomicStore, D1AtomicReader } = await import('../src/execution/d1')
  const { createCommandRegistry } = await import('../src/commands')
  const operation = {
    name: 'worker/credential_guard', permission: { entity: 'worker', operation: 'update' as const }, input: z.strictObject({}),
    plan: () => ({ rules: [{ name: 'change', statements: [{ sql: 'UPDATE worker SET name=? WHERE id=?', bindings: ['escalated', 'worker-other'], expectRows: 1 as const }] }],
      result: { status: 200, body: {} }, event: { entity: 'worker', entityId: 'worker-other', operation: 'worker.changed' } }),
  }
  const bound = new KernelRegistry({ ...kernel.config, commands: [operation.name] }, { commands: createCommandRegistry([operation]) })
  await reviewToken(app, 'admin', 'staff', [operation.name])
  const req = request('/')
  req.headers.set('Authorization', 'Bearer wb_review_admin_staff')
  const scope = await requireScope(await resolveActor(req, runtime(), bound.config), 'org-a', bound.config)
  const ctx = coreExecutionContext(bound.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  await expect(executeAtomic(operation, {}, ctx)).rejects.toThrow('policy_violation')
  expect(await env.DB.prepare('SELECT name FROM worker WHERE id=?').bind('worker-other').first('name')).toBe('other')
})
it('credential authority fails closed without a live issuer projection', async () => {
  const { kernel } = await setup()
  const scope = { organizationId: 'org-a', actor: { type: 'agent' as const, id: 'missing' }, role: 'admin', correlationId: 'missing' }
  const { effectiveAuthority } = await import('../src/access-evaluator')
  const authority = effectiveAuthority(kernel.config.effectiveAccess!, scope)
  expect(authority.permits({ entity: 'worker', operation: 'create' })).toBe(false)
  expect(authority.permits({ system: 'audit.read' })).toBe(false)
  expect(kernel.tableFilter('worker', scope).kind).toBe('none')
  expect(kernel.fieldMask('worker', scope)).toEqual([])
  expect(hasOwnerRole(scope, kernel.config)).toBe(false)
})
