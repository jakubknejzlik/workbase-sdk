import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { createApp } from '@workbasehq/core/app'
import { defineInstance, organizationActions } from '@workbasehq/core/config'
import { sha256 } from '@workbasehq/core/crypto'
import { D1AtomicStore } from '@workbasehq/core/execution/d1'
import type { KernelCommand } from '@workbasehq/core/kernel/plugin'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'
import sample from '../../../core/test/fixtures/sample/config'
import accounts from '../../../core/test/fixtures/accounts/config'
import { createOrganizations } from '../src'

const config = defineInstance({ ...sample, plugins: sample.plugins!.map(plugin => plugin.name === 'organizations' ? createOrganizations({ allowCreate: false }) : plugin) })
const opsToken = 'synthetic-provision-ops'
let app: ReturnType<typeof createApp>
async function identity(id: string, verified = true, legacyAccount = true) {
  const email = `${id}@example.test`
  const now = new Date().toISOString()
  await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)').bind(id, id, email, Number(verified), now, now).run()
  if (legacyAccount) await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,created_at) VALUES (?,?,?,?,?)').bind(id, email, '', '', now).run()
  return email
}
async function session(id: string) {
  await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, new Date(Date.now() + 86400000).toISOString()).run()
}
function provision(ownerEmail = 'first@example.test', name = 'Provisioned organization', token: string | null = opsToken) {
  return app.request('http://localhost/internal/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-Internal-Token': token }) }, body: JSON.stringify({ name, ownerEmail }) })
}
async function counts() {
  const tables = ['organizations', 'organization_scopes', 'users', 'memberships', 'audit_outbox', 'email_outbox', 'access_tokens', 'invitations', 'idempotency_keys', 'atomic_assert']
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')])))
}
beforeEach(async () => {
  await setup(config, async () => {})
  app = createApp(config, { ...runtime(), OPS_TOKEN: opsToken })
  await identity('first')
})

it('provisions an organization for a verified identity with allowCreate=false', async () => {
  const response = await provision()
  expect(response.status).toBe(201)
  const body = await response.json() as any
  expect(body).toEqual({ id: expect.any(String), name: 'Provisioned organization', role: 'owner', replayed: false })
  expect(await env.DB.prepare('SELECT user_id,organization_id,role FROM memberships').first()).toEqual({ user_id: 'first', organization_id: body.id, role: 'owner' })
  const event = JSON.parse((await env.DB.prepare('SELECT payload FROM audit_outbox').first<string>('payload'))!)
  expect(event).toMatchObject({ operation: 'organization.provisioned', entity_id: body.id, organization_id: body.id, actor: { type: 'service' } })
  await session('first')
  expect((await request(app, '/orgs', 'POST', { name: 'Self service' }, 'first', body.id)).status).toBe(403)
  expect(await counts()).toMatchObject({ organizations: 2, memberships: 1, audit_outbox: 1, email_outbox: 0, access_tokens: 0, invitations: 0 })
})

it('rejects a missing or wrong ops token', async () => {
  const before = await counts()
  for (const token of [null, 'wrong']) {
    const response = await provision(undefined, undefined, token)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'internal_token_required' })
  }
  app = createApp(config, { ...runtime(), INTERNAL_TOKEN: undefined })
  const response = await provision()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'internal_token_not_configured' })
  expect(await counts()).toEqual(before)
})

it('rejects an unknown or unverified owner email', async () => {
  await identity('unverified', false)
  const before = await counts()
  const securityBefore = await env.DB.prepare('SELECT count(*) AS n FROM security_log').first('n')
  for (const email of ['missing@example.test', 'unverified@example.test']) {
    const response = await provision(email)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'owner_sign_in_required' })
    expect(await counts()).toEqual(before)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM security_log').first('n')).toBe(securityBefore)
  }
})

it('replays the same (ownerEmail, name)', async () => {
  const first = await provision()
  expect(first.status).toBe(201)
  const body = await first.json() as any
  const before = await counts()
  const replay = await provision('FIRST@example.test')
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ ...body, replayed: true })
  expect(await counts()).toEqual(before)
})

it('replays the original receipt after a rename or ownership change without restoring grants', async () => {
  const first = await provision()
  expect(first.status).toBe(201)
  const body = await first.json() as any
  await env.DB.batch([
    env.DB.prepare('UPDATE organizations SET name=? WHERE id=?').bind('Renamed organization', body.id),
    env.DB.prepare('UPDATE memberships SET role=? WHERE organization_id=? AND user_id=?').bind('viewer', body.id, 'first'),
  ])
  const before = await counts()
  const replay = await provision()
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ ...body, replayed: true })
  expect(await env.DB.prepare('SELECT role FROM memberships WHERE organization_id=? AND user_id=?').bind(body.id, 'first').first('role')).toBe('viewer')
  expect(await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind(body.id).first('name')).toBe('Renamed organization')
  expect(await counts()).toEqual(before)
})

it('isolates two provisioned organizations', async () => {
  await identity('second')
  const first = await provision()
  const second = await provision('second@example.test', 'Second organization')
  expect([first.status, second.status]).toEqual([201, 201])
  const a = await first.json() as any
  const b = await second.json() as any
  await session('first')
  await session('second')
  const created = await request(app, '/api/clients', 'POST', { name: 'Private record' }, 'second', b.id)
  expect(created.status).toBe(201)
  const record = await created.json() as any
  expect([403, 404]).toContain((await request(app, `/api/clients/${record.id}`, 'GET', undefined, 'first', b.id)).status)
  expect((await request(app, `/api/clients/${record.id}`, 'GET', undefined, 'first', a.id)).status).toBe(404)
})

it('rejects a second org for a single-account user', async () => {
  await setup(accounts, async () => {})
  app = createApp(accounts, { ...runtime(), OPS_TOKEN: opsToken })
  await identity('first', true, false)
  const first = await provision()
  expect(first.status).toBe(201)
  const body = await first.json() as any
  expect(body.role).toBe('administrator')
  expect(await env.DB.prepare('SELECT organization_id FROM users WHERE id=?').bind('first').first('organization_id')).toBe(body.id)
  expect((await provision()).status).toBe(200)
  const before = await counts()
  const second = await provision(undefined, 'Another organization')
  expect(second.status).toBe(409)
  expect(await second.json()).toEqual({ error: 'account_already_assigned' })
  expect(await counts()).toEqual(before)
})

it('allows a service actor exactly identity.write and organizations.provision system permissions', () => {
  type System = Extract<KernelCommand['permission'], { system: string }>['system']
  const systems: System[] = [...organizationActions, 'audit.read', 'workflows.read', 'workflows.resume', 'workflows.cancel', 'organizations.create', 'organizations.provision', 'members.leave', 'invitations.accept', 'identity.write']
  const scope = { actor: { type: 'service' as const, id: 'test-service' }, organizationId: 'test-org', role: 'owner', correlationId: 'test-correlation' }
  for (const kernel of [new KernelRegistry(config), new KernelRegistry(config, { authorization: 'trust' }), new KernelRegistry({ ...config, interactive: false, plugins: [], pluginConfig: undefined })]) {
    for (const system of systems) {
      const check = () => kernel.commandGuard({ name: 'test/permission', kind: 'command', permission: { system } }, scope, undefined)
      if (system === 'identity.write' || system === 'organizations.provision') expect(check).not.toThrow()
      else expect(check).toThrow(expect.objectContaining({ status: 403 }))
    }
    expect(() => kernel.permission(scope, 'clients', 'create')).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => kernel.commandGuard({ name: 'test/permission', kind: 'command', permission: { system: 'organizations.provision' } }, { ...scope, actor: { type: 'user', id: 'first' } }, undefined)).toThrow(expect.objectContaining({ status: 403 }))
  }
})

it('replays concurrent provisioning without duplicate rows or audit events', async () => {
  const responses = await Promise.all([provision(), provision()])
  expect(responses.map(response => response.status).sort()).toEqual([200, 201])
  const bodies = await Promise.all(responses.map(response => response.json())) as any[]
  expect(bodies[0].id).toBe(bodies[1].id)
  expect(await counts()).toMatchObject({ organizations: 2, memberships: 1, audit_outbox: 1 })
})

it('rolls back organization and account provisioning if owner membership insertion fails', async () => {
  await setup(accounts, async () => {})
  app = createApp(accounts, { ...runtime(), OPS_TOKEN: opsToken })
  await identity('first', true, false)
  await env.DB.exec('CREATE TRIGGER skip_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(IGNORE); END;')
  const before = await counts()
  const response = await provision()
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'organization_conflict' })
  expect(await counts()).toEqual(before)
})

it('rechecks owner verification in the atomic write', async () => {
  const before = await counts()
  const run = D1AtomicStore.prototype.run
  const commit = vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementation(async function (this: D1AtomicStore, plan) {
    if (plan.rules.some(rule => rule.name === 'organization_create')) await env.DB.prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=?').bind('first').run()
    return run.call(this, plan)
  })
  try {
    const response = await provision()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'owner_sign_in_required' })
    expect(await counts()).toEqual(before)
  } finally { commit.mockRestore() }
})
