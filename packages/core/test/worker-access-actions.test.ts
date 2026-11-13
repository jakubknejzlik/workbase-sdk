import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { workerAccessFixture } from './fixtures/worker-access'
import { createApp } from '../src/app'
import { D1AtomicStore } from '../src/execution/d1'
import invited from './fixtures/worker-access/detail.invited.json'
import expired from './fixtures/worker-access/detail.expired.json'
import linked from './fixtures/worker-access/detail.linked.json'
import noAccount from './fixtures/worker-access/detail.no_account.json'
import { sha256 } from '../src/crypto'

const names = ['invite', 'cancel_invite', 'link_account', 'unlink_account'] as const
const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-access-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-access-secret-at-least-32', localPassword: true } })
let app: ReturnType<typeof createApp>
function request(path: string, role = 'admin', method = 'GET', body?: object, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer synthetic-${role}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}
const act = (id: string, name: string, body: object = {}, role = 'admin') => request(`/api/worker/${id}/actions/${name}`, role, 'POST', body)
const bodyFor = (name: string) => name === 'invite' ? { email: 'recipient@example.test' } : name === 'link_account' ? { user_id: 'recipient' } : {}
async function account(id: string, org = 'org-a', role = 'staff', membership = true) {
  await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, `${id}@example.test`, 'x', 'x', org, id, role, 'now', 'now').run()
  await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `${id}@example.test`, 'now', 'now').run()
  if (membership) await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, org, role).run()
  await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, '2099-01-01T00:00:00.000Z').run()
  await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(id, id).run()
}
async function state(value: string) {
  await env.DB.exec("DELETE FROM invitations; UPDATE worker SET user=NULL,version=1 WHERE organization_id='org-a'")
  if (value === 'linked') await env.DB.exec("UPDATE worker SET user='staff' WHERE id='local'")
  if (value === 'invited' || value === 'expired') await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,target_entity,target_row) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('pending', 'org-a', 'recipient@example.test', 'staff', await sha256('a'.repeat(64)), value === 'invited' ? '2099-11-20T10:00:00.000Z' : '2000-01-01T00:00:00.000Z', 'admin', '2000', 'worker', 'local').run()
}
beforeEach(async () => {
  await reset()
  const config = workerAccessFixture()
  await bootstrap(env.DB, config)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')")
  await account('admin', 'org-a', 'admin'); await account('staff'); await account('recipient'); await account('foreign-account', 'org-b')
  await completeInvitationProfiles()
  for (const id of ['local', 'other', 'foreign']) await env.DB.prepare('INSERT INTO worker (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind(id, id === 'foreign' ? 'org-b' : 'org-a', 'Jana', 'now', 'now').run()
  app = createApp(config, runtime())
})
afterEach(() => vi.restoreAllMocks())
it.each(['admin', 'staff'])('enabled iff 2xx: %s × four states × four access actions', async role => {
  for (const value of ['no_account', 'invited', 'expired', 'linked']) for (const name of names) {
    await state(value)
    const get = await request('/api/worker/local', role)
    const row = await get.json() as any
    if (role === 'admin') expect(row.actions).toEqual(({ invited, expired, linked, no_account: noAccount } as any)[value].actions)
    const response = await act('local', name, bodyFor(name), role)
    expect(response.ok, `${role}/${value}/${name}: ${await response.clone().text()}`).toBe(row.actions?.[name]?.enabled === true)
    if (role === 'staff') expect(response.status).toBe(403)
    else if (!response.ok) expect(await response.json()).toEqual({ error: 'action_unavailable', reason: row.actions[name].reason })
  }
})
it('foreign row and user selectors are byte-identical to nonexistent selectors', async () => {
  for (const name of names) {
    const missing = await act('missing', name, bodyFor(name)), foreign = await act('foreign', name, bodyFor(name))
    expect(missing.status).toBe(404); expect(foreign.status).toBe(404)
    expect(await foreign.text()).toBe(await missing.text())
  }
  const missing = await act('local', 'link_account', { user_id: 'missing' }), foreign = await act('local', 'link_account', { user_id: 'foreign-account' })
  expect(missing.status).toBe(404); expect(foreign.status).toBe(404)
  expect(await foreign.text()).toBe(await missing.text())
})
it('forged generic links and action selectors/grants/tokens are rejected without writes; legacy commands retain rowId', async () => {
  for (const user of [null, 'recipient']) {
    const response = await request('/api/worker/local', 'admin', 'PATCH', { user }, { 'If-Match': '1' })
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'protected_field' })
  }
  for (const name of names) for (const injected of [{ id: 'foreign' }, { rowId: 'foreign' }, { role: 'admin' }, JSON.parse('{"__proto__":{"role":"admin"}}')]) {
    expect((await act('local', name, { ...bodyFor(name), ...injected })).status).toBe(400)
  }
  expect((await request('/commands/worker/access_invite', 'admin', 'POST', { id: 'local', email: 'recipient@example.test' })).status).toBe(405)
  expect((await act('local', 'invite', {})).status).toBe(400)
  expect((await act('local', 'link_account', { userId: 'recipient' })).status).toBe(400)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM worker WHERE user IS NOT NULL').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
  expect((await request('/commands/worker/link_account', 'admin', 'POST', { rowId: 'local', userId: 'recipient' })).status).toBe(200)
  expect((await request('/commands/worker/remove_access', 'admin', 'POST', { rowId: 'local' })).status).toBe(200)
  expect((await request('/commands/worker/link_account', 'admin', 'POST', { id: 'local', user_id: 'recipient' })).status).toBe(400)
})
it('invite is atomic, returns its credential once with no-store, and supersedes expired history', async () => {
  await state('expired')
  const response = await act('local', 'invite', bodyFor('invite'))
  expect(response.status, await response.clone().text()).toBe(201)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const result = await response.json() as any
  expect(Object.keys(result).sort()).toEqual(['accept_url', 'expires_at', 'invitation_id'])
  expect(await env.DB.prepare("SELECT expired_at FROM invitations WHERE id='pending'").first('expired_at')).toBeTruthy()
  const detail = await request('/api/worker/local')
  expect(await detail.text()).not.toMatch(/accept_url|token_hash|invitations\/accept/)
  const audit = await env.DB.prepare('SELECT payload FROM audit_outbox').all()
  expect(JSON.stringify(audit.results)).not.toContain(new URL(result.accept_url).searchParams.get('token'))
  expect(JSON.stringify(audit.results)).not.toContain('accept_url')
})
it('two invites commit exactly one invitation, outbox intent and audit event', async () => {
  const results = await Promise.all([act('local', 'invite', bodyFor('invite')), act('local', 'invite', bodyFor('invite'))])
  expect(results.map(result => result.status).sort()).toEqual([201, 409])
  for (const table of ['invitations', 'email_outbox', 'audit_outbox']) expect(await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(1)
})
it('two links of an account to distinct workers commit only one link', async () => {
  const results = await Promise.all([act('local', 'link_account', { user_id: 'recipient' }), act('other', 'link_account', { user_id: 'recipient' })])
  expect(results.map(result => result.status).sort()).toEqual([200, 409])
  expect(await env.DB.prepare("SELECT count(*) n FROM worker WHERE user='recipient'").first('n')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
})
it('unlink bumps version, preserves staff membership, immediately revokes the same session and permits reinvite/relink', async () => {
  await state('linked')
  expect((await request('/api/worker/local', 'staff')).status).toBe(200)
  expect((await act('local', 'unlink_account')).status).toBe(200)
  expect((await request('/api/worker/local', 'staff')).status).toBe(404)
  expect(await (await request('/api/worker', 'staff')).json()).toMatchObject({ data: [] })
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='staff'").first('role')).toBe('staff')
  expect((await request('/api/worker/local', 'admin', 'PATCH', { name: 'stale' }, { 'If-Match': '1' })).status).toBe(409)
  expect((await act('local', 'invite', { email: 'staff@example.test' })).status).toBe(201)
  expect((await act('local', 'link_account', { user_id: 'staff' })).status).toBe(200)
  expect((await request('/api/worker/local', 'staff')).status).toBe(200)
  expect((await act('local', 'unlink_account')).status).toBe(200)
  expect(await env.DB.prepare("SELECT count(*) n FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL").first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='staff'").first('role')).toBe('staff')
})
it.each(['cancel_invite', 'unlink_account'])('accept × %s uses one D1 batch; losing accept creates no staff membership', async action => {
  await env.DB.exec("DELETE FROM memberships WHERE user_id='recipient'")
  const issued = await act('local', 'invite', { email: 'recipient@example.test' })
  expect(issued.status).toBe(201)
  const result = await issued.json() as any
  if (action === 'unlink_account') await env.DB.exec("UPDATE worker SET user='recipient' WHERE id='local'")
  const [accepted, revoked] = await Promise.all([
    request(`/invitations/${result.invitation_id}/accept`, 'recipient', 'POST', {}), act('local', action),
  ])
  if (accepted.ok) {
    // Variant A deliberately retains a membership after a subsequent unlink.
    expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='recipient'").first('role')).toBe('staff')
    if (action === 'cancel_invite') expect(revoked.status).toBe(409)
  } else {
    expect(revoked.status).toBe(200)
    expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='recipient'").first('n')).toBe(0)
    expect(await env.DB.prepare("SELECT user FROM worker WHERE id='local'").first('user')).toBeNull()
  }
})
it('availability SQL rechecks pending state and issuer role after prepare with no writes or audit', async () => {
  const original = D1AtomicStore.prototype.run
  const spy = vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementationOnce(async function(this: D1AtomicStore, plan) {
    await env.DB.exec("UPDATE memberships SET role='staff' WHERE user_id='admin'")
    return original.call(this, plan)
  })
  expect((await act('local', 'invite', bodyFor('invite'))).ok).toBe(false)
  spy.mockRestore()
  for (const table of ['invitations', 'email_outbox', 'audit_outbox']) expect(await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0)
})
it('cancelled invitation cannot be accepted, and an accepted invitation cannot be cancelled', async () => {
  for (const first of ['cancel', 'accept']) {
    await state('no_account')
    await env.DB.exec("DELETE FROM memberships WHERE user_id='recipient'")
    const issued = await (await act('local', 'invite', { email: 'recipient@example.test' })).json() as any
    const accept = () => request(`/invitations/${issued.invitation_id}/accept`, 'recipient', 'POST', {})
    if (first === 'cancel') {
      expect((await act('local', 'cancel_invite')).status).toBe(200)
      expect((await accept()).status).toBe(409)
      expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='recipient'").first('n')).toBe(0)
    } else {
      expect((await accept()).status).toBe(201)
      expect((await act('local', 'cancel_invite')).status).toBe(409)
      expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='recipient'").first('role')).toBe('staff')
    }
  }
})
it('SQL conditions recheck invitation state changed after GET and before the batch', async () => {
  await state('invited')
  expect(await (await request('/api/worker/local')).json()).toMatchObject({ actions: { cancel_invite: { enabled: true } } })
  const original = D1AtomicStore.prototype.run
  vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementationOnce(async function(this: D1AtomicStore, plan) {
    await env.DB.exec("UPDATE invitations SET revoked_at='now' WHERE id='pending'")
    return original.call(this, plan)
  })
  const response = await act('local', 'cancel_invite')
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'action_unavailable', reason: 'access.no_invitation' })
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})
it('card issues the configured staff role, preserves an admin recipient and rejects a changed grant or demoted issuer at accept', async () => {
  const adminInvite = await (await act('local', 'invite', { email: 'admin@example.test' })).json() as any
  expect(await env.DB.prepare('SELECT role FROM invitations WHERE id=?').bind(adminInvite.invitation_id).first('role')).toBe('staff')
  expect((await request(`/invitations/${adminInvite.invitation_id}/accept`, 'admin', 'POST', {})).status).toBe(201)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='admin'").first('role')).toBe('admin')
  const staffInvite = await (await act('other', 'invite', { email: 'recipient@example.test' })).json() as any
  await env.DB.prepare("UPDATE invitations SET role='admin' WHERE id=?").bind(staffInvite.invitation_id).run()
  expect((await request(`/invitations/${staffInvite.invitation_id}/accept`, 'recipient', 'POST', {})).status).toBe(403)
  await env.DB.prepare("UPDATE invitations SET role='staff' WHERE id=?").bind(staffInvite.invitation_id).run()
  await env.DB.exec("UPDATE memberships SET role='staff' WHERE user_id='admin'; DELETE FROM memberships WHERE user_id='recipient'")
  expect((await request(`/invitations/${staffInvite.invitation_id}/accept`, 'recipient', 'POST', {})).status).toBe(409)
  expect(await env.DB.prepare("SELECT user FROM worker WHERE id='other'").first('user')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='recipient'").first('n')).toBe(0)
})
it('cloned and JSON round-tripped effective policy is rebound by the kernel before detail and execution', async () => {
  for (const clone of [(value: any) => structuredClone(value), (value: any) => JSON.parse(JSON.stringify(value))]) {
    await state('no_account')
    const config = workerAccessFixture()
    const copied = { ...config, effectiveAccess: clone(config.effectiveAccess) }
    app = createApp(copied, runtime())
    expect(await (await request('/api/worker/local')).json()).toMatchObject({ actions: { invite: { enabled: true } } })
    expect((await act('local', 'invite', bodyFor('invite'))).status).toBe(201)
  }
})
it('foreign invitation credentials against a local row have nonexistent 404 bytes and cannot select a different invitation', async () => {
  await state('invited')
  const foreignToken = 'b'.repeat(64), missingToken = 'c'.repeat(64)
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,target_entity,target_row) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('foreign-invitation', 'org-b', 'foreign-account@example.test', 'staff', await sha256(foreignToken), '2099-01-01T00:00:00.000Z', 'foreign-account', 'now', 'worker', 'foreign').run()
  for (const name of names) {
    const foreign = await act('local', name, { ...bodyFor(name), token: foreignToken })
    const missing = await act('local', name, { ...bodyFor(name), token: missingToken })
    expect(foreign.status).toBe(404); expect(missing.status).toBe(404)
    expect(await foreign.text()).toBe(await missing.text())
  }
  expect(await env.DB.prepare("SELECT count(*) n FROM invitations WHERE revoked_at IS NOT NULL").first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})
it('authored action input is strict, keeps the path id and runs field transforms exactly once', async () => {
  const { z } = await import('zod')
  const { actionFixture, closeRecord } = await import('./fixtures/record-actions')
  const command = { ...closeRecord, input: z.strictObject({ id: z.string(), value: z.string().transform(value => value + '!') }).transform(input => ({ ...input, value: input.value + '?' })),
    plan: (_ctx: unknown, input: { id: string; value: string }) => ({ rules: [{ name: 'set', statements: [{ sql: 'UPDATE record SET state=?,version=version+1 WHERE id=?', bindings: [input.value, input.id], expectRows: 1 as const }] }],
      event: { entity: 'record', entityId: input.id, operation: 'record.changed' }, result: { status: 200, body: { value: input.value } } }),
  }
  await reset()
  const inputless = { ...closeRecord, name: 'record/inputless' }
  const config = actionFixture({ change: { command: command.name }, touch: { command: inputless.name } }, [command, inputless] as any)
  await bootstrap(env.DB, config)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A')")
  await account('admin', 'org-a', 'admin')
  await env.DB.exec("INSERT INTO record (id,organization_id,state,created_at,updated_at) VALUES ('local','org-a','open','now','now')")
  app = createApp(config, runtime())
  const badEmpty = await request('/api/record/local/actions/touch', 'admin', 'POST', JSON.parse('{"__proto__":{"role":"admin"}}'))
  expect(badEmpty.status).toBe(400)
  expect(await env.DB.prepare("SELECT state FROM record WHERE id='local'").first('state')).toBe('open')
  for (const extra of [{ id: 'foreign' }, { rowId: 'foreign' }, { role: 'admin' }, { unknown: true }, JSON.parse('{"__proto__":{"role":"admin"}}')]) {
    expect((await request('/api/record/local/actions/change', 'admin', 'POST', { value: 'changed', ...extra })).status).toBe(400)
  }
  const result = await request('/api/record/local/actions/change', 'admin', 'POST', { value: 'changed' })
  expect(result.status, await result.clone().text()).toBe(200)
  expect(await result.json()).toEqual({ value: 'changed!?' })
  expect(await env.DB.prepare("SELECT state FROM record WHERE id='local'").first('state')).toBe('changed!?')
})
it('accept winning before unlink retains its staff membership and clears only the account link', async () => {
  await env.DB.exec("DELETE FROM memberships WHERE user_id='recipient'")
  const result = await (await act('local', 'invite', { email: 'recipient@example.test' })).json() as any
  expect((await request(`/invitations/${result.invitation_id}/accept`, 'recipient', 'POST', {})).status).toBe(201)
  expect((await act('local', 'unlink_account')).status).toBe(200)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='recipient'").first('role')).toBe('staff')
  expect(await env.DB.prepare("SELECT user FROM worker WHERE id='local'").first('user')).toBeNull()
  expect((await request('/api/worker/local', 'recipient')).status).toBe(404)
  expect(await (await request('/api/worker', 'recipient')).json()).toMatchObject({ data: [] })
})
