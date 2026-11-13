import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { workerAccessFixture } from './fixtures/worker-access'
import { createApp } from '../src/app'
import { sha256 } from '../src/crypto'

const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-access-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-access-secret-at-least-32', localPassword: true } })
let app: ReturnType<typeof createApp>
function request(path: string, role = 'admin', method = 'GET', body?: object) {
  return app.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer synthetic-${role}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}
beforeEach(async () => {
  await reset()
  const config = workerAccessFixture()
  await bootstrap(env.DB, config)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')")
  for (const role of ['admin', 'staff']) {
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(role, `${role}@example.test`, 'x', 'x', 'org-a', role, role, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${role}`), role, '2099-01-01T00:00:00.000Z').run()
    await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(role, role).run()
  }
  await completeInvitationProfiles()
  for (const state of ['no_account', 'invited', 'expired', 'linked']) await env.DB.prepare('INSERT INTO worker (id,organization_id,name,user,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(state, 'org-a', 'Jana', state === 'linked' ? 'staff' : null, 'now', 'now').run()
  for (const state of ['invited', 'expired', 'linked']) await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,target_entity,target_row) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(`inv-${state}`, 'org-a', `${state}@example.test`, 'staff', `hash-${state}`, state === 'expired' ? '2000-01-01T00:00:00.000Z' : '2099-11-20T10:00:00.000Z', 'admin', 'now', 'worker', state).run()
  app = createApp(config, runtime())
})
it('detail supplies all four access states and a public account projection; staff has no access key', async () => {
  for (const state of ['no_account', 'invited', 'expired', 'linked']) {
    const response = await request(`/api/worker/${state}`)
    expect(response.status, await response.clone().text()).toBe(200)
    const row = await response.json() as any
    expect(row.access.state).toBe(state)
    expect(row.actions).toHaveProperty('invite')
    if (state === 'linked') expect(row.access).toEqual({ state, account: { id: 'staff', display_name: 'staff', email: 'staff@example.test' }, invitation: null })
    else expect(row.access.account).toBeNull()
    expect(JSON.stringify(row.access)).not.toMatch(/token|accept_url|inviter_id/)
  }
  const staff = await (await request('/api/worker/linked', 'staff')).json() as any
  expect(staff).not.toHaveProperty('access')
  expect(staff.actions).toEqual({})
  expect(await (await request('/api/worker/no_account?fields=id')).json()).toHaveProperty('access.state', 'no_account')
  expect((await request('/api/worker/no_account', 'staff')).status).toBe(404)
  const list = await (await request('/api/worker')).json() as any
  expect(list.data.every((row: any) => !Object.hasOwn(row, 'access'))).toBe(true)
})
it('legacy row-access consumes shared state while preserving its response contract', async () => {
  for (const state of ['no_account', 'invited', 'expired', 'linked']) {
    const response = await request(`/orgs/org-a/row-access/worker/${state}`)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ state: state === 'linked' ? 'signed_in' : state, can_invite: true, can_cancel: true })
  }
})
it('row invitations use staff at issue and recheck the configured role at accept; admin remains admin', async () => {
  const issued = await request('/orgs/org-a/invitations', 'admin', 'POST', { email: 'admin@example.test', target: { entity: 'worker', row: 'no_account' } })
  expect(issued.status, await issued.clone().text()).toBe(201)
  const invitation = await issued.json() as any
  expect(invitation.role).toBe('staff')
  const accepted = await request(`/invitations/${invitation.id}/accept`, 'admin', 'POST', {})
  expect(accepted.status, await accepted.clone().text()).toBe(201)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='admin'").first('role')).toBe('admin')
  const bad = await request('/orgs/org-a/invitations', 'admin', 'POST', { email: 'staff@example.test', role: 'admin', target: { entity: 'worker', row: 'expired' } })
  expect(bad.status).toBe(400)
})
it('persisted role tampering or issuer demotion denies acceptance without linking', async () => {
  for (const tamper of ['role', 'issuer']) {
    const issued = await request('/orgs/org-a/invitations', 'admin', 'POST', { email: 'staff@example.test', target: { entity: 'worker', row: 'no_account' } })
    expect(issued.status, await issued.clone().text()).toBe(201)
    const invitation = await issued.json() as any
    if (tamper === 'role') await env.DB.prepare("UPDATE invitations SET role='admin' WHERE id=?").bind(invitation.id).run()
    else await env.DB.exec("UPDATE memberships SET role='staff' WHERE user_id='admin'")
    expect((await request(`/invitations/${invitation.id}/accept`, 'staff', 'POST', {})).status).toBe(tamper === 'role' ? 403 : 409)
    expect(await env.DB.prepare("SELECT user FROM worker WHERE id='no_account'").first('user')).toBeNull()
    await env.DB.prepare('DELETE FROM invitations WHERE id=?').bind(invitation.id).run()
  }
})
