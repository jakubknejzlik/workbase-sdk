import { z } from 'zod'
import { registerPostCommit, postCommitFor } from '../src/execution/post-commit'
import type { AtomicOperation } from '../src/execution/types'
import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { workerAccessFixture } from './fixtures/worker-access'
import { createApp } from '../src/app'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { KernelRegistry } from '../src/kernel/registry'
import { requireScope } from '../src/authorization'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
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
    // Slice 10 establishes GET's read authority first: a row staff cannot read
    // answers exactly like GET (no oracle); a readable row denies with 403.
    if (role === 'staff') expect(response.status).toBe(get.ok ? 403 : get.status)
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
  expect(Object.keys(result).sort()).toEqual(['accept_url', 'delivery', 'expires_at', 'invitation_id'])
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

it('review5 V3 accountLink publishes the whole family and dedicated handlers succeed with console input shapes', async () => {
  const contract = await (await request('/o/org-a/console-model')).json() as any
  expect(contract.model.entities.worker.accountLink).toEqual({ field: 'user', entity: 'users' })
  const family = ['link_account', 'remove_access', ...names.map(name => `access_${name}`)]
  expect(contract.model.commands.filter((command: any) => family.includes(command.name.split('/')[1])).map((command: any) => command.name).sort()).toEqual(family.map(name => `worker/${name}`).sort())
  for (const name of names) {
    const response = await request(`/commands/worker/access_${name}`, 'admin', 'POST', { id: 'local', ...bodyFor(name) })
    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: 'unsupported_command' })
  }
  for (const [name, body] of [['invite', { email: 'recipient@example.test' }], ['cancel_invite', {}], ['link_account', { user_id: 'recipient' }], ['unlink_account', {}]] as const) {
    const response = await act('local', name, body)
    expect(response.ok, `${name}: ${await response.clone().text()}`).toBe(true)
  }
  expect(await env.DB.prepare("SELECT user FROM worker WHERE id='local'").first('user')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) n FROM worker WHERE id='local'").first('n')).toBe(1)
})
it('V3 explicit link/unlink remain authorized when invitation status cannot be disclosed', async () => {
  const config = workerAccessFixture()
  config.effectiveAccess = { ...config.effectiveAccess!, system: config.effectiveAccess!.system.map(rule => rule.role === 'admin' && rule.action === 'invitations.read' ? { ...rule, decision: 'deny' } : rule) }
  app = createApp(config, runtime())
  const contract = await (await request('/o/org-a/console-model')).json() as any
  expect(contract.model.entities.worker.rowAccess).toBe(false)
  const row = await (await request('/api/worker/local')).json() as any
  expect(row).not.toHaveProperty('access')
  expect(row.actions.link_account.enabled).toBe(true)
  expect((await act('local', 'link_account', { user_id: 'recipient' })).status).toBe(200)
  expect((await act('local', 'unlink_account')).status).toBe(200)
})

// These regressions use the real V3 route and native send_email transport seam.
const mailRuntime = (send: (...args: any[]) => any) => ({ ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
async function invitationOutbox(id: string) {
  return env.DB.prepare(`SELECT o.* FROM email_outbox o JOIN invitations i ON i.delivery_outbox_id=o.id WHERE i.id=?`).bind(id)
    .first<{ id: string; delivery_status: string; attempts: number; last_error: string | null; body: string }>()
}
it('worker invite mail: delivers exactly once after commit, with Members rendering and delivered-email proof', async () => {
  const send = vi.fn(async (_message: unknown) => {
    expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(1)
    expect(await env.DB.prepare("SELECT count(*) n FROM audit_outbox WHERE json_extract(payload,'$.operation')='invitation.created'").first('n')).toBe(1)
  })
  app = createApp(workerAccessFixture(), mailRuntime(send))
  const response = await act('local', 'invite', { email: 'recipient@example.test' })
  expect(response.status).toBe(201)
  const result = await response.json() as any
  expect(send).toHaveBeenCalledTimes(1)
  expect(result.delivery).toMatchObject({ status: 'delivered', attempts: 1, error: null })
  const message = send.mock.calls[0][0] as any
  expect(message).toMatchObject({ to: 'recipient@example.test', from: '"admin" <noreply@example.test>' })
  expect(message.text).toContain('admin'); expect(message.html).toContain('admin')
  const outbox = (await invitationOutbox(result.invitation_id))!
  expect(outbox).toMatchObject({ delivery_status: 'sent', attempts: 1, last_error: null })
  const deliveredLink = message.text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)![0]
  expect(outbox.body).toBe(`Accept: ${result.accept_url}`);
  expect(message.text).toContain(deliveredLink); expect(message.html).toContain(deliveredLink.replaceAll('&', '&amp;'))
  const selector = new URL(result.accept_url).searchParams.get('token')!
  const proof = new URL(deliveredLink).searchParams.get('token')!
  expect(selector).toMatch(/^[a-f0-9]{64}$/)
  expect(proof).toMatch(new RegExp(`^${selector}\\.[a-f0-9]{64}$`))
  const anonymous = (token: string) => app.request('http://localhost/invitations/resolve', { method: 'POST', headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
  expect((await anonymous(selector)).status).toBe(401)
  expect((await anonymous(proof)).status).toBe(200)
  expect((await request(`/orgs/org-a/invitations/${result.invitation_id}/retry-delivery`, 'admin', 'POST', {})).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(1)
  const copied = await (await request(`/orgs/org-a/invitations/${result.invitation_id}/copy-link`, 'admin', 'POST', {})).json() as any
  expect(new URL(copied.accept_url).searchParams.get('token')).toMatch(/^[a-f0-9]{64}$/)
  expect(await env.DB.prepare('SELECT delivery_outbox_id FROM invitations WHERE id=?').bind(result.invitation_id).first('delivery_outbox_id')).toBeNull()
  expect((await anonymous(proof)).status).toBe(404)
})
it('worker invite mail: provider failure is failed and retry-delivery sends the same intent once', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('synthetic provider failure')).mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  app = createApp(workerAccessFixture(), mailRuntime(send))
  const response = await act('local', 'invite', { email: 'recipient@example.test' })
  expect(response.status).toBe(201)
  const result = await response.json() as any
  expect(result.delivery).toMatchObject({ status: 'failed', attempts: 1, error: 'email_send_failed' })
  const before = await invitationOutbox(result.invitation_id)
  expect(before).toMatchObject({ delivery_status: 'failed', attempts: 1, last_error: 'email_send_failed' })
  const retried = await request(`/orgs/org-a/invitations/${result.invitation_id}/retry-delivery`, 'admin', 'POST', {})
  expect(retried.status).toBe(200)
  expect(await retried.json()).toMatchObject({ delivery: { status: 'delivered', attempts: 2 } })
  expect(await invitationOutbox(result.invitation_id)).toMatchObject({ id: before!.id, delivery_status: 'sent', attempts: 2 })
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
  await request(`/orgs/org-a/invitations/${result.invitation_id}/retry-delivery`, 'admin', 'POST', {})
  expect(send).toHaveBeenCalledTimes(2)
})
it('worker invite mail: timeout fences retries even when the provider later completes', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let finish!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; started() }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  app = createApp(workerAccessFixture(), mailRuntime(send))
  const creation = Promise.resolve(act('local', 'invite', { email: 'recipient@example.test' }))
  try {
    await ready; await vi.advanceTimersByTimeAsync(60000)
    const response = await creation
    expect(response.status).toBe(201)
    const result = await response.json() as any
    expect(result.delivery).toMatchObject({ status: 'failed', attempts: 1 })
    expect(await invitationOutbox(result.invitation_id)).toMatchObject({ last_error: 'email_send_timeout' })
    for (const late of [false, true]) {
      if (late) finish()
      const retried = await request(`/orgs/org-a/invitations/${result.invitation_id}/retry-delivery`, 'admin', 'POST', {})
      expect(retried.status).toBe(200)
      expect(await retried.json()).toMatchObject({ delivery: { status: 'failed', attempts: 1 } })
      expect(send).toHaveBeenCalledTimes(1)
    }
  } finally { finish?.(); await creation.catch(() => {}); vi.useRealTimers() }
})
it.each([
  "UPDATE invitations SET revoked_at='now'",
  "UPDATE invitations SET accepted_at='now'",
  "UPDATE invitations SET declined_at='now'",
  "UPDATE invitations SET expired_at='now'",
  "UPDATE invitations SET expires_at='2000-01-01'",
  "UPDATE invitations SET token_hash='rotated',delivery_outbox_id=NULL",
  "UPDATE invitations SET id='replaced'",
  "UPDATE invitations SET organization_id='org-b'",
  "UPDATE worker SET user='recipient' WHERE id='local'",
  "UPDATE memberships SET role='staff' WHERE user_id='admin'",
])('worker invite mail: rechecks committed invitation and row guard before send: %s', async sql => {
  const send = vi.fn().mockResolvedValue(undefined)
  app = createApp(workerAccessFixture(), mailRuntime(send))
  const original = D1AtomicStore.prototype.run
  vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementationOnce(async function(this: D1AtomicStore, plan) {
    const outcome = await original.call(this, plan)
    await env.DB.exec(sql)
    return outcome
  })
  const response = await act('local', 'invite', { email: 'recipient@example.test' })
  expect(response.status).toBe(201)
  expect((await response.json() as any).delivery).toMatchObject({ status: 'queued', attempts: 0 })
  expect(send).not.toHaveBeenCalled()
  expect(await env.DB.prepare('SELECT delivery_status,attempts FROM email_outbox').first()).toMatchObject({ delivery_status: 'pending', attempts: 0 })
})
it('worker invite mail: failed atomic commit sends nothing and leaves no intent', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  app = createApp(workerAccessFixture(), mailRuntime(send))
  const original = D1AtomicStore.prototype.run
  vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementationOnce(async function(this: D1AtomicStore, plan) {
    await env.DB.exec("UPDATE memberships SET role='staff' WHERE user_id='admin'")
    return original.call(this, plan)
  })
  expect((await act('local', 'invite', { email: 'recipient@example.test' })).status).toBe(404)
  expect(send).not.toHaveBeenCalled()
  expect(await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')).toBe(0)
})
it('worker invite mail: a pre-existing pending intent stays untouched', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  app = createApp(workerAccessFixture(), mailRuntime(send))
  await env.DB.prepare(`INSERT INTO email_outbox (id,organization_id,recipient,subject,body,created_at,delivery_text,delivery_html,expires_at)
    VALUES ('historic','org-a','historic@example.test','Historic invitation','Accept: historic','2000','Historic text','<p>Historic</p>','2099-01-01')`).run()
  await env.DB.prepare(`INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,delivery_outbox_id,target_entity,target_row)
    VALUES ('historic','org-a','historic@example.test','staff',?,'2099-01-01','admin','2000','historic','worker','other')`).bind(await sha256('d'.repeat(64))).run()
  expect((await act('local', 'invite', { email: 'recipient@example.test' })).status).toBe(201)
  expect(send).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare("SELECT delivery_status,attempts,sent_at,last_error FROM email_outbox WHERE id='historic'").first())
    .toEqual({ delivery_status: 'pending', attempts: 0, sent_at: null, last_error: null })
})

it('worker invite mail: post-commit failure preserves the committed result and idempotent replay never sends twice', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = mailRuntime(send)
  const kernel = new KernelRegistry(workerAccessFixture(), {}, settings)
  const scope = await requireScope(await kernel.requireActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-admin' } }), settings), 'org-a', kernel.config)
  const operation = kernel.commands.get('worker/access_invite')!
  const context = coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB, { env: settings, config: kernel.config }), new D1AtomicReader(env.DB), 'invite-once')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const status = vi.spyOn(kernel.invitationMail, 'status').mockRejectedValueOnce(new Error('synthetic post-commit status failure'))
  const committed = await executeAtomic(operation, { id: 'local', email: 'recipient@example.test' }, context)
  expect(committed).toMatchObject({ status: 201, body: { delivery: { status: 'unknown' } } })
  expect(send).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare("SELECT delivery_status FROM email_outbox").first('delivery_status')).toBe('sent')
  const replay = await executeAtomic(operation, { id: 'local', email: 'recipient@example.test' }, context)
  expect(replay).toEqual(committed)
  expect(send).toHaveBeenCalledTimes(1); expect(status).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(1)
})

it('worker invite mail: status failure returns 201 and delivery recovery uses the committed invitation', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = mailRuntime(send)
  const port = new KernelRegistry(workerAccessFixture(), {}, settings).invitationMail
  vi.spyOn(port, 'status').mockRejectedValueOnce(new Error('synthetic status read failure with private details'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  app = createApp(workerAccessFixture(), settings)
  const response = await act('local', 'invite', { email: 'recipient@example.test' })
  expect(response.status).toBe(201)
  const result = await response.json() as any
  expect(result).toMatchObject({ invitation_id: expect.any(String), accept_url: expect.any(String), delivery: { status: 'unknown' } })
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(1)
  expect(await invitationOutbox(result.invitation_id)).toMatchObject({ delivery_status: 'sent', attempts: 1 })
  expect(send).toHaveBeenCalledTimes(1)
  const retry = await request(`/orgs/org-a/invitations/${result.invitation_id}/retry-delivery`, 'admin', 'POST', {})
  expect(retry.status).toBe(200)
  expect(await retry.json()).toMatchObject({ id: result.invitation_id, delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(1)
  expect(log.mock.calls).toEqual([[JSON.stringify({ event: 'invitation_post_commit_failed', outboxId: (await invitationOutbox(result.invitation_id))!.id })]])
})

it('worker invite mail: serialized StorePlans exclude the delivered mailbox proof on creation and retry', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('synthetic provider failure')).mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const config = workerAccessFixture()
  app = createApp(config, mailRuntime(send))
  const serializedPlans: string[] = []
  const original = D1AtomicStore.prototype.run
  vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementation(async function(this: D1AtomicStore, plan) {
    serializedPlans.push(JSON.stringify(plan))
    return original.call(this, plan)
  })
  const response = await act('local', 'invite', { email: 'recipient@example.test' })
  expect(response.status).toBe(201)
  const result = await response.json() as any
  expect(result.delivery.status).toBe('failed')
  const retried = await request(`/orgs/org-a/invitations/${result.invitation_id}/retry-delivery`, 'admin', 'POST', {})
  expect(retried.status).toBe(200)
  expect(await retried.json()).toMatchObject({ delivery: { status: 'delivered', attempts: 2 } })
  expect(send).toHaveBeenCalledTimes(2)
  const message = send.mock.calls[1][0]
  const deliveredLink = message.text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)![0]
  const proof = new URL(deliveredLink).searchParams.get('token')!
  expect(proof).toMatch(/^[a-f0-9]{64}\.[a-f0-9]{64}$/)
  expect(serializedPlans.length).toBeGreaterThan(0)
  expect(serializedPlans.some(plan => plan.includes(proof) || /[a-f0-9]{64}\.[a-f0-9]{64}/.test(plan))).toBe(false)
  expect(JSON.stringify(config).includes(proof)).toBe(false)
  expect(JSON.stringify(await env.DB.prepare('SELECT payload FROM audit_outbox').all()).includes(proof)).toBe(false)
  expect(JSON.stringify(result).includes(proof)).toBe(false)
  expect(JSON.stringify(await invitationOutbox(result.invitation_id)).includes(proof)).toBe(false)
  expect((await app.request('http://localhost/invitations/resolve', { method: 'POST', headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: proof }) })).status).toBe(200)
})

it('post-commit callbacks are isolated by operation identity even with a shared plan function', async () => {
  const kernel = new KernelRegistry(workerAccessFixture(), {}, runtime())
  const scope = await requireScope(await kernel.requireActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-admin' } }), runtime()), 'org-a', kernel.config)
  const context = coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB, { env: runtime(), config: kernel.config }), new D1AtomicReader(env.DB))
  const plan: AtomicOperation['plan'] = () => ({ rules: [{ name: 'touch', statements: [{ sql: "UPDATE worker SET name=name WHERE id='local'" }] }], event: { operation: 'worker.updated', entity: 'worker', entityId: 'local' }, result: { status: 200, body: {} } })
  const base = { permission: { system: 'invitations.create' as const }, input: z.object({}), plan }
  const callbackA = vi.fn(async (_prepared, result) => ({ ...result, body: { owner: 'a' } }))
  const callbackB = vi.fn(async (_prepared, result) => ({ ...result, body: { owner: 'b' } }))
  const a = registerPostCommit({ ...base, name: 'worker/probe_a' }, callbackA)
  const b = registerPostCommit({ ...base, name: 'worker/probe_b' }, callbackB)
  const unregistered = { ...base, name: 'worker/probe_unregistered' }
  expect(postCommitFor(a)).toBe(callbackA)
  expect(postCommitFor(b)).toBe(callbackB)
  expect(postCommitFor(unregistered)).toBeUndefined()
  expect(await executeAtomic(a, {}, context)).toMatchObject({ body: { owner: 'a' } })
  expect(await executeAtomic(b, {}, context)).toMatchObject({ body: { owner: 'b' } })
  expect(await executeAtomic(unregistered, {}, context)).toEqual({ status: 200, body: {} })
  expect(callbackA).toHaveBeenCalledTimes(1); expect(callbackB).toHaveBeenCalledTimes(1)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failing = registerPostCommit({ ...base, name: 'worker/probe_failure' }, async () => { throw new Error('private callback details') })
  expect(await executeAtomic(failing, {}, context)).toEqual({ status: 200, body: {} })
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'post_commit_failed', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
})

// Review2 probe: equivalent URL encoding must fail closed before native transport.
it.each(['text', 'html', 'both', 'html-one', 'body', 'text-extra', 'html-extra'])('worker invite mail: rejects unfinalized stored links in %s', async part => {
  const send = vi.fn().mockRejectedValueOnce(new Error('synthetic fail')).mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  app = createApp(workerAccessFixture(), mailRuntime(send))
  const result = await (await act('local', 'invite', { email: 'recipient@example.test' })).json() as any
  const row = (await env.DB.prepare('SELECT * FROM email_outbox').first<{ id: string; body: string; delivery_text: string; delivery_html: string }>())!
  const link = row.body.replace('Accept: ', '')
  const encodedLink = link.replace(/token=([a-f0-9])/, (_, ch) => `token=%${ch.charCodeAt(0).toString(16)}`)
  expect(new URL(encodedLink).searchParams.get('token')).toBe(new URL(link).searchParams.get('token'))
  let text = row.delivery_text, html = row.delivery_html, body = row.body
  if (part === 'text' || part === 'both') text = text.replaceAll(link, encodedLink)
  if (part === 'html' || part === 'both') html = html.replaceAll(link, encodedLink)
  if (part === 'html-one') html = html.replace(link, encodedLink)
  if (part === 'body') body = body.replace(link, encodedLink)
  if (part === 'text-extra') text += `\n${encodedLink}`
  if (part === 'html-extra') html += `<a href="${encodedLink}">Extra</a>`
  await env.DB.prepare('UPDATE email_outbox SET body=?,delivery_text=?,delivery_html=? WHERE id=?').bind(body, text, html, row.id).run()
  const retry = await request(`/orgs/org-a/invitations/${result.invitation_id}/retry-delivery`, 'admin', 'POST', {})
  expect(retry.status).toBe(200)
  expect(await retry.json()).toMatchObject({ delivery: { status: 'failed', attempts: 2, error: 'email_send_failed' } })
  expect(send).toHaveBeenCalledTimes(1)
  expect(await invitationOutbox(result.invitation_id)).toMatchObject({ delivery_status: 'failed', attempts: 2, last_error: 'email_send_failed' })
  expect(await env.DB.prepare('SELECT sent_at FROM email_outbox WHERE id=?').bind(row.id).first('sent_at')).toBeNull()
})

// Review3 V3_METADATA_REPRO: use the real worker action and native transport.
it('worker invite mail: acceptance path in organization display text delivers once', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  app = createApp(workerAccessFixture(), mailRuntime(send))
  expect((await request('/orgs/org-a', 'admin', 'PATCH', { name: 'Team /invitations/accept' })).status).toBe(200)
  const response = await act('local', 'invite', { email: 'recipient@example.test' })
  expect(response.status).toBe(201)
  const result = await response.json() as any
  expect(result.delivery).toMatchObject({ status: 'delivered', attempts: 1, error: null })
  expect(send).toHaveBeenCalledTimes(1)
  const message = send.mock.calls[0][0]
  expect(message.text).toContain('Team /invitations/accept')
  expect(message.html).toContain('Team /invitations/accept')
  const delivered = message.text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)![0]
  const proof = new URL(delivered).searchParams.get('token')!
  expect((await app.request('http://localhost/invitations/resolve', { method: 'POST', headers: {
    Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ token: proof }) })).status).toBe(200)
  expect(await invitationOutbox(result.invitation_id)).toMatchObject({ delivery_status: 'sent', attempts: 1, last_error: null })
})
