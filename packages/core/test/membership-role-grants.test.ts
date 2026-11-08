import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import sample from './fixtures/sample/config'
import { setup, request, json, runtime, completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { defineInstance, organizationActions, type InstanceConfig } from '../src/config'
import { createApp } from '../src/app'
import * as rolePermissions from '../src/organization-permissions'
const canGrantRole = rolePermissions.canGrantRole

let app: Awaited<ReturnType<typeof setup>>
const config = (extra: Partial<InstanceConfig> = {}) => defineInstance({ ...sample, ...extra })
beforeEach(async () => { app = await setup() })

it('175 dispatcher cannot invite a same-rank role with extra entity permissions', async () => {
  const model = config({ permissions: { ...sample.permissions, dispatcher: { clients: ['read'] }, viewer: sample.permissions.owner } })
  app = createApp(model, runtime())
  const response = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'grant@example.test', role: 'viewer' }, 'dispatcher-a')
  expect({ status: response.status, body: await json(response) }).toEqual({ status: 403, body: { error: 'role_escalation' } })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM invitations').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM email_outbox').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(0)
})
it('175 members.update and remove use the delegated role permissions', async () => {
  const model = config({ organizationPermissions: { ...sample.organizationPermissions, dispatcher: [...organizationActions] } })
  app = createApp(model, runtime())
  expect((await request(app, '/orgs/org-a/members/viewer-a', 'PATCH', { role: 'dispatcher' }, 'dispatcher-a')).status).toBe(200)
  expect((await request(app, '/orgs/org-a/members/viewer-a', 'DELETE', undefined, 'dispatcher-a')).status).toBe(204)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE user_id='viewer-a'").first('n')).toBe(0)
})
it('175 built-in member and configured owner exist without default grants', () => {
  const model = defineInstance({ id: 'empty_roles', revision: 1, roles: ['reviewer'], entities: {}, permissions: {}, organizationPermissions: {} })
  expect(model.roles).toEqual(['reviewer', 'owner', 'member'])
  expect(model.permissions).toEqual({})
  expect(model.organizationPermissions).toEqual({ owner: [] })
  expect(defineInstance(model).organizationPermissions).toEqual(model.organizationPermissions)
})

it('175 subset compares effective privileges with absent grants empty and unknown roles denied', () => {
  const model = config({ permissions: { owner: { clients: ['read'] }, dispatcher: { clients: ['read', 'delete'] } },
    organizationPermissions: { owner: ['members.update'], dispatcher: ['members.update', 'members.remove'] } })
  expect(canGrantRole(model, 'owner', 'dispatcher')).toBe(false)
  expect(canGrantRole(model, 'dispatcher', 'owner')).toBe(false)
  expect(canGrantRole(model, 'dispatcher', 'dispatcher')).toBe(true)
  expect(canGrantRole(model, 'owner', 'member')).toBe(true)
  expect(canGrantRole(model, 'missing', 'member')).toBe(false)
  expect(canGrantRole(model, 'owner', 'missing')).toBe(false)
  expect(canGrantRole({ ...model, permissions: {} }, 'owner', 'dispatcher')).toBe(false)
  expect(canGrantRole({ ...model, organizationPermissions: {} }, 'owner', 'dispatcher')).toBe(false)
})
it.each(['invitations', 'members', 'tokens'])('175 %s rejects extra organization grants with zero writes', async path => {
  const model = config({ organizationPermissions: { ...sample.organizationPermissions, dispatcher: ['invitations.create', 'members.update', 'tokens.create'], viewer: ['members.remove'] } })
  app = createApp(model, runtime())
  const response = await request(app, path === 'members' ? '/orgs/org-a/members/viewer-a' : `/orgs/org-a/${path}`,
    path === 'members' ? 'PATCH' : 'POST', { ...(path === 'tokens' ? { name: 'Denied' } : path === 'invitations' ? { email: 'subset@example.test' } : {}), role: 'viewer' }, 'dispatcher-a')
  expect({ status: response.status, body: await json(response) }).toEqual({ status: 403, body: { error: 'role_escalation' } })
  expect(await env.DB.prepare('SELECT role FROM memberships WHERE user_id=?').bind('viewer-a').first('role')).toBe('viewer')
  for (const table of ['invitations', 'access_tokens', 'email_outbox', 'audit_outbox']) expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0)
})
it.each(['invitations', 'members', 'tokens'])('175 live issuer role at the batch controls %s, allowing equal grants after a role change', async path => {
  const model = config({ organizationPermissions: { owner: [...organizationActions], dispatcher: [...organizationActions], viewer: [] } })
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await target.prepare("UPDATE memberships SET role='dispatcher' WHERE user_id='owner-a' AND organization_id='org-a'").run()
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(model, { ...runtime(), DB: db })
  const response = await request(app, path === 'members' ? '/orgs/org-a/members/viewer-a' : `/orgs/org-a/${path}`,
    path === 'members' ? 'PATCH' : 'POST', { ...(path === 'tokens' ? { name: 'Allowed' } : path === 'invitations' ? { email: 'live@example.test' } : {}), role: 'dispatcher' })
  expect(response.status, await response.clone().text()).toBe(path === 'members' ? 200 : 201)
  expect(intercepted).toBe(true)
})
it.each(['invitations', 'members', 'tokens'])('175 live issuer role at the batch rejects %s escalation and rolls back every effect', async path => {
  const model = config({ permissions: { ...sample.permissions, dispatcher: { clients: ['read'] } },
    organizationPermissions: { owner: [...organizationActions], dispatcher: [...organizationActions], viewer: [] } })
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await target.prepare("UPDATE memberships SET role='dispatcher' WHERE user_id='owner-a' AND organization_id='org-a'").run()
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(model, { ...runtime(), DB: db })
  const response = await request(app, path === 'members' ? '/orgs/org-a/members/viewer-a' : `/orgs/org-a/${path}`,
    path === 'members' ? 'PATCH' : 'POST', { ...(path === 'tokens' ? { name: 'Denied' } : path === 'invitations' ? { email: 'live@example.test' } : {}), role: 'viewer' })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(intercepted).toBe(true)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='viewer-a'").first('role')).toBe('viewer')
  for (const table of ['invitations', 'access_tokens', 'email_outbox', 'audit_outbox', 'atomic_assert']) expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0)
})
it('175 last configured owner is protected from delegated removal and downgrade', async () => {
  const model = config({ organizationPermissions: { ...sample.organizationPermissions, dispatcher: [...organizationActions] } })
  app = createApp(model, runtime())
  for (const method of ['PATCH', 'DELETE']) {
    const response = await request(app, '/orgs/org-a/members/owner-a', method, method === 'PATCH' ? { role: 'viewer' } : undefined, 'dispatcher-a')
    expect({ status: response.status, body: await json(response) }).toEqual({ status: 409, body: { error: 'last_owner' } })
  }
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(0)
})
it('175 sixty entities, four operations and six roles keep atomic grants below D1 limits', async () => {
  const roles = ['owner', 'dispatcher', 'viewer', 'operator', 'auditor', 'member']
  const entities = { ...sample.entities, ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`entity_${i}`, { fields: { name: { type: 'string' as const, required: false } }, relations: {}, checks: [] }])) }
  const model = config({ entities, ui: { entities: {} }, policies: {}, permissions: Object.fromEntries(roles.map(role => [role, Object.fromEntries(Object.keys(entities).map(entity => [entity, ['read', 'create', 'update', 'delete']]))])),
    pluginConfig: { ...sample.pluginConfig, permissions: { roles, ownerRole: 'owner' } }, organizationPermissions: Object.fromEntries(roles.map(role => [role, [...organizationActions]])) })
  app = await setup(model)
  for (const [path, body] of [['invitations', { email: 'budget@example.test', role: 'operator' }], ['tokens', { name: 'Budget', role: 'operator' }]] as const) {
    const response = await request(app, `/orgs/org-a/${path}`, 'POST', body)
    expect(response.status, await response.clone().text()).toBe(201)
  }
  expect((await request(app, '/orgs/org-a/members/viewer-a', 'PATCH', { role: 'operator' })).status).toBe(200)
})
it('175 invitation acceptance checks the original issuer live subset and can retry after restoration', async () => {
  await completeInvitationProfiles()
  const invitation = await json(await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'dispatcher' }))
  const token = new URL(invitation.accept_url).searchParams.get('token')
  await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='owner-a'").run()
  const denied = await request(app, '/invitations/accept', 'POST', { token }, 'owner-b')
  expect(denied.status).toBe(409)
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(invitation.id).first('accepted_at')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first('n')).toBe(0)
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='owner-a'").run()
  expect((await request(app, '/auth/register', 'POST', { token }, 'owner-b')).status).toBe(201)
})

it.each(['invitations', 'members', 'tokens'])('175 subset %s grant cannot manufacture implicit owner resource permissions', async path => {
  const model = config({ permissions: { owner: { clients: ['read'] }, dispatcher: { clients: ['read'] } },
    organizationPermissions: { owner: [], dispatcher: ['members.update', 'invitations.create', 'tokens.create'] } })
  app = createApp(model, runtime())
  expect((await request(app, '/audit/events', 'GET', undefined, 'dispatcher-a')).status).toBe(403)
  const response = await request(app, path === 'members' ? '/orgs/org-a/members/dispatcher-a' : `/orgs/org-a/${path}`,
    path === 'members' ? 'PATCH' : 'POST', { role: 'owner', ...(path === 'tokens' ? { name: 'Denied' } : path === 'invitations' ? { email: 'implicit@example.test' } : {}) }, 'dispatcher-a')
  expect({ status: response.status, body: await json(response) }).toEqual({ status: 403, body: { error: 'role_escalation' } })
  expect((await request(app, '/audit/events', 'GET', undefined, 'dispatcher-a')).status).toBe(403)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='dispatcher-a' AND organization_id='org-a'").first('role')).toBe('dispatcher')
  for (const table of ['invitations', 'access_tokens', 'email_outbox', 'audit_outbox']) expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0)
})

it.each(['demoted', 'deleted'])('175 auth/register acceptance with batch %s issuer logs denial without audit or provisioning writes', async kind => {
  await completeInvitationProfiles()
  const invitation = await json(await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'dispatcher' }))
  const token = new URL(invitation.accept_url).searchParams.get('token')
  const counts = () => Promise.all(['users', 'email_outbox', 'audit_outbox', 'invitations', 'access_tokens', 'atomic_assert'].map(table => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')))
  const before = await counts()
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await target.prepare(kind === 'demoted'
          ? "UPDATE memberships SET role='viewer' WHERE user_id='owner-a' AND organization_id='org-a'"
          : "DELETE FROM memberships WHERE user_id='owner-a' AND organization_id='org-a'").run()
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(sample, { ...runtime(), DB: db })
  const denied = await request(app, '/auth/register', 'POST', { token }, 'owner-b')
  expect(denied.status).toBe(409)
  expect(intercepted).toBe(true)
  expect(await counts()).toEqual(before)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(invitation.id).first('accepted_at')).toBeNull()
  expect((await env.DB.prepare('SELECT status,correlation_id FROM security_log').all()).results).toEqual([
    { status: 409, correlation_id: denied.headers.get('X-Correlation-Id') },
  ])
})

it.each(['invitations', 'members', 'tokens', 'accept-token', 'accept-id', 'accept-register'])('175 live %s guard includes implicit owner privileges even with equal stored grants', async path => {
  const model = config({ permissions: { ...sample.permissions, dispatcher: sample.permissions.owner },
    organizationPermissions: { owner: [...organizationActions], dispatcher: [...organizationActions] } })
  app = createApp(model, runtime())
  const accepting = path.startsWith('accept-')
  let invitation: Record<string, any> | undefined
  if (accepting) {
    await completeInvitationProfiles()
    invitation = await json(await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'owner' }))
  }
  const counts = () => Promise.all(['users', 'memberships', 'invitations', 'access_tokens', 'email_outbox', 'audit_outbox', 'atomic_assert'].map(table => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')))
  const before = await counts()
  let intercepted = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true
        await target.prepare("UPDATE memberships SET role='dispatcher' WHERE user_id='owner-a' AND organization_id='org-a'").run()
      }
      return target.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  app = createApp(model, { ...runtime(), DB: db })
  const url = accepting ? path === 'accept-id' ? `/invitations/${invitation!.id}/accept` : path === 'accept-register' ? '/auth/register' : '/invitations/accept'
    : path === 'members' ? '/orgs/org-a/members/viewer-a' : `/orgs/org-a/${path}`
  const body = accepting ? path === 'accept-id' ? {} : { token: new URL(invitation!.accept_url).searchParams.get('token') }
    : { role: 'owner', ...(path === 'tokens' ? { name: 'Denied' } : path === 'invitations' ? { email: 'live-implicit@example.test' } : {}) }
  const response = await request(app, url, path === 'members' ? 'PATCH' : 'POST', body, accepting ? 'owner-b' : 'owner-a')
  expect(response.status).toBe(path === 'tokens' ? 403 : 409)
  expect(intercepted).toBe(true)
  expect(await counts()).toEqual(before)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='viewer-a' AND organization_id='org-a'").first('role')).toBe('viewer')
  if (accepting) {
    expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(invitation!.id).first('accepted_at')).toBeNull()
    expect(await env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first('n')).toBe(0)
  }
})
