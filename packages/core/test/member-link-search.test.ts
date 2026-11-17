import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it, vi, afterEach } from 'vitest'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { workerAccessFixture } from './fixtures/worker-access'
import { createApp } from '../src/app'
import { sha256 } from '../src/crypto'
import { D1AtomicStore } from '../src/execution/d1'

const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-access-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-access-secret-at-least-32', localPassword: true } })
let app: ReturnType<typeof createApp>
function request(path: string, role = 'admin', method = 'GET', body?: object, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer synthetic-${role}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}
const act = (id: string, name: string, body: object = {}, role = 'admin') => request(`/api/worker/${id}/actions/${name}`, role, 'POST', body)
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


it('120 admin capabilities advertise member search together with link authority', async () => {
  const response = await request('/o/org-a/capabilities')
  expect(response.status).toBe(200)
  const caps = await response.json() as any
  expect(caps.resources).toMatchObject({ 'members.read': true, 'members.search_link_account': true })
  expect(caps.commands).toContain('worker/access_link_account')
})

it('91 search alone leaves the pending invitation byte-identical', async () => {
  await state('invited')
  const before = await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()
  const search = await request('/orgs/org-a/members?eligible=link_account&target_entity=worker&target_row=local&q=staff')
  expect(search.status).toBe(200)
  expect((await search.json() as any).data.map((member: any) => member.user_id)).toContain('staff')
  expect(await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()).toEqual(before)
  expect(await env.DB.prepare("SELECT user FROM worker WHERE id='local'").first('user')).toBeNull()
})

it('91 search preserves pending invitation; confirmed action link revokes it and accept rejects', async () => {
  await state('invited')
  await env.DB.exec("DELETE FROM memberships WHERE user_id='recipient'")
  const before = await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()
  const search = await request('/orgs/org-a/members?eligible=link_account&target_entity=worker&target_row=local&q=staff')
  expect(search.status).toBe(200)
  expect((await search.json() as any).data.map((member: any) => member.user_id)).toContain('staff')
  expect(await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()).toEqual(before)
  const response = await act('local', 'link_account', { user_id: 'staff' })
  expect(response.status).toBe(200)
  expect(await env.DB.prepare("SELECT revoked_at FROM invitations WHERE id='pending'").first('revoked_at')).toBeTruthy()
  const accepted = await request('/invitations/pending/accept', 'recipient', 'POST', {})
  expect(accepted.status).toBe(409)
  expect(await accepted.json()).toMatchObject({ error: 'invitation_revoked' })
  const oldLink = await request('/invitations/accept', 'recipient', 'POST', { token: 'a'.repeat(64) })
  expect(oldLink.status).toBe(409)
  expect(await oldLink.json()).toMatchObject({ error: 'invitation_revoked' })
  expect(await env.DB.prepare("SELECT user FROM worker WHERE id='local'").first('user')).toBe('staff')
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='recipient'").first('n')).toBe(0)
})

it('107 legacy link leaves the pending invitation unchanged and visible in row-access status', async () => {
  await state('invited')
  await env.DB.exec("DELETE FROM memberships WHERE user_id='recipient'")
  const before = await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()
  const response = await request('/commands/worker/link_account', 'admin', 'POST', { rowId: 'local', userId: 'staff' })
  expect(response.status).toBe(200)
  expect(await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()).toEqual(before)
  expect(await env.DB.prepare("SELECT revoked_at FROM invitations WHERE id='pending'").first('revoked_at')).toBeNull()
  const status = await request('/orgs/org-a/row-access/worker/local')
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ state: 'signed_in', invitation: { id: before!.id, email: before!.email, expires_at: before!.expires_at } })
  expect(await env.DB.prepare("SELECT user FROM worker WHERE id='local'").first('user')).toBe('staff')
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='recipient'").first('n')).toBe(0)
})

afterEach(() => vi.restoreAllMocks())
it.each(['members.read', 'invitations.create', 'update', 'staff'])('91 search gate %s returns no identities or counts and capabilities agree', async gate => {
  const config = workerAccessFixture()
  if (gate === 'members.read' || gate === 'invitations.create') config.effectiveAccess = { ...config.effectiveAccess!, system: config.effectiveAccess!.system.map(rule => rule.role === 'admin' && rule.action === gate ? { ...rule, decision: 'deny' } : rule) }
  if (gate === 'update') config.effectiveAccess = { ...config.effectiveAccess!, entities: config.effectiveAccess!.entities.map(rule => rule.role === 'admin' && rule.entity === 'worker' && rule.operation === 'update' ? { ...rule, decision: 'deny' } : rule) }
  app = createApp(config, runtime())
  const role = gate === 'staff' ? 'staff' : 'admin'
  const response = await request('/orgs/org-a/members?eligible=link_account&target_entity=worker&target_row=local&q=staff&include=pending', role)
  expect(response.status).toBe(gate === 'members.read' || gate === 'staff' ? 403 : 400)
  expect(await response.json()).toEqual({ error: gate === 'members.read' || gate === 'staff' ? 'permission_denied' : 'invalid_link_target' })
  const caps = await (await request('/o/org-a/capabilities', role)).json() as any
  expect(caps.resources['members.search_link_account']).toBe(gate !== 'members.read' && gate !== 'staff')
  if (gate === 'update' || gate === 'invitations.create') expect(caps.commands).not.toContain('worker/access_link_account')
})
it('91 offered candidate becomes ineligible at commit; rejection preserves pending invitation', async () => {
  await state('invited')
  const response = await request('/orgs/org-a/members?eligible=link_account&target_entity=worker&target_row=local&q=staff')
  expect((await response.json() as any).data.map((member: any) => member.user_id)).toContain('staff')
  const before = await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()
  const original = D1AtomicStore.prototype.run
  vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementationOnce(async function(this: D1AtomicStore, plan) {
    await env.DB.exec("UPDATE worker SET user='staff' WHERE id='other'")
    return original.call(this, plan)
  })
  const refused = await act('local', 'link_account', { user_id: 'staff' })
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({ error: 'account_already_linked' })
  expect(await env.DB.prepare("SELECT user FROM worker WHERE id='local'").first('user')).toBeNull()
  expect(await env.DB.prepare("SELECT * FROM invitations WHERE id='pending'").first()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(0)
})
