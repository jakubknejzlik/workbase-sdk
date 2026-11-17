import { responseContract } from '../../../core/test/fixtures/openapi-contract'
import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it, vi } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { createApp } from '@workbasehq/core/app'
import { initialSchema } from '../../../core/src/migrations/schema'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { requireScope } from '../../../core/src/authorization'
import { sha256 } from '@workbasehq/core/crypto'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { consoleUI, consoleRegistry } from '@workbasehq/plugins/console'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { permissions } from '@workbasehq/plugins/permissions'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { runtime, request, json, completeInvitationProfiles } from '@workbasehq/test-support/helpers'

function configuration() {
  return defineInstance({ id: 'row_invitations', revision: 1, interactive: true, account: { entity: 'users' },
    plugins: [createIdentity(), createLocalAuth(), permissions({ roles: ['owner', 'member', 'creator', 'inviter'] }), createMembers(), consoleUI(), createOrganizations(), machineCredentials(), mailOutbox()],
    roles: ['owner', 'member', 'creator', 'inviter'],
    entities: {
      users: { displayField: 'name', fields: { name: { type: 'string' } } },
      people: { fields: { name: { type: 'string' }, user: { type: 'ref', entity: 'users', userLink: true } }, relations: { account: { entity: 'users', field: 'user' } } },
      teams: { fields: { name: { type: 'string' }, user: { type: 'ref', entity: 'users', userLink: true } }, relations: { account: { entity: 'users', field: 'user' } } },
    },
    permissions: Object.fromEntries(['owner', 'member', 'creator', 'inviter'].map(role => [role, Object.fromEntries(['users', 'people', 'teams'].map(entity => [entity, role === 'owner' ? ['read', 'create', 'update', 'delete'] : role === 'creator' ? ['read', 'create'] : ['read']]))])),
    organizationPermissions: { owner: ['members.read', 'members.remove', 'invitations.create', 'invitations.read', 'invitations.revoke'], inviter: ['invitations.create'] },
    policies: Object.fromEntries(['users', 'people', 'teams'].map(entity => [entity, { owner: 'all', member: { where: { id: { eq: '$actor.id' } } }, creator: 'all', inviter: 'all' }])),
  })
}
let app: ReturnType<typeof createApp>
beforeEach(async () => {
  await reset()
  const config = configuration()
  await env.DB.exec(initialSchema(config).replaceAll('\n', ' '))
  await new KernelRegistry(config).applyMigrations(env.DB)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B');")
  for (const [id, role] of [['owner-a', 'owner'], ['member-a', 'member'], ['creator-a', 'creator'], ['inviter-a', 'inviter']]) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,organization_id,email,name,created_at,updated_at) VALUES (?,\'org-a\',?,?,\'now\',\'now\')').bind(id, `${id}@example.test`, id),
      env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,\'now\',\'now\')').bind(id, id, `${id}@example.test`),
      env.DB.prepare('INSERT INTO memberships VALUES (?,\'org-a\',?)').bind(id, role),
      env.DB.prepare('INSERT INTO sessions VALUES (?, ?,\'2099-01-01T00:00:00.000Z\')').bind(await sha256(`synthetic-${id}`), id),
      env.DB.prepare('INSERT INTO identities VALUES (?,\'local\',\'local\',?,\'now\')').bind(id, id),
    ])
  }
  await completeInvitationProfiles()
  await env.DB.exec("INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p1','org-a','One','now','now'),('p2','org-a','Two','now','now'),('foreign','org-b','Foreign','now','now'); INSERT INTO teams (id,organization_id,name,created_at,updated_at) VALUES ('t1','org-a','Team','now','now');")
  app = createApp(config, runtime())
})
const linked = () => env.DB.prepare("SELECT user FROM people WHERE id='p1'").first('user')
const invite = (email = 'member-a@example.test', row = 'p1', actor = 'owner-a') => request(app, '/orgs/org-a/invitations', 'POST', { email, target: { entity: 'people', row } }, actor)
async function invitation(email?: string, row?: string) {
  const response = await invite(email, row)
  expect(response.status, await response.clone().text()).toBe(201)
  return json(response)
}
const accept = (id: string) => request(app, `/invitations/${id}/accept`, 'POST', {}, 'member-a')
const status = () => request(app, '/orgs/org-a/row-access/people/p1')

it('targeted preflight redacts anonymous and other accounts; only the verified recipient gets the full preview', async () => {
  const i = await invitation()
  const token = new URL(i.accept_url).searchParams.get('token')
  const response = await app.request('http://localhost/invitations/preflight', {
    method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  })
  expect(response.status).toBe(200)
  expect(await json(response)).toEqual({ id: i.id, account_match: null })
  const other = await request(app, '/invitations/preflight', 'POST', { token }, 'owner-a')
  expect(other.status).toBe(200)
  expect(await json(other)).toEqual({ id: i.id, account_match: false })
  const denied = await request(app, `/invitations/${i.id}/preview`, 'GET', undefined, 'owner-a')
  expect(denied.status).toBe(404)
  expect(await json(denied)).toEqual({ error: 'invitation_not_found' })
  const preflight = await request(app, '/invitations/preflight', 'POST', { token }, 'member-a')
  expect(preflight.status).toBe(200)
  const body = await json(preflight)
  expect(Object.keys(body).sort()).toEqual(['account_match', 'expires_at', 'id', 'inviter', 'organization', 'role', 'state', 'target'])
  expect(Object.keys(body.organization).sort()).toEqual(['id', 'name'])
  expect(Object.keys(body.inviter)).toEqual(['display_name'])
  expect(body).toMatchObject({ organization: { id: 'org-a', name: 'A' }, role: i.role, target: { entity: 'people', row: 'p1' }, account_match: true })
  const preview = await request(app, `/invitations/${i.id}/preview`, 'GET', undefined, 'member-a')
  expect(preview.status).toBe(200)
  expect(await json(preview)).toEqual({ ...body, navigation_target: `/invitation?id=${i.id}`,
    return_to: '/o/org-a', profile_complete: true, next: 'preview', actions: ['accept', 'decline'] })
})

it('legacy row-access retains the pending invitation after manual account linking', async () => {
  const i = await invitation()
  const before = await status()
  expect(before.status).toBe(200)
  const pending = await json(before)
  expect(pending).toEqual({ inconsistency: null, linked_accounts: [], can_cancel: true, state: 'invited', invitation: { id: i.id, email: i.email, expires_at: i.expires_at }, can_invite: true })
  const response = await request(app, '/commands/people/link_account', 'POST', { rowId: 'p1', userId: 'member-a' })
  expect(response.status, await response.clone().text()).toBe(200)
  const after = await status()
  expect(after.status).toBe(200)
  expect(await json(after)).toEqual({ ...pending, state: 'signed_in', linked_accounts: [{ id: 'member-a', label: 'Existing Person' }] })
  expect(await env.DB.prepare('SELECT revoked_at FROM invitations WHERE id=?').bind(i.id).first('revoked_at')).toBeNull()
})

it('176 existing member confirms: invitation and resolve do not link; acceptance links atomically without changing membership role', async () => {
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='member-a'").run()
  const i = await invitation()
  expect(i.role).toBe('member')
  expect(await linked()).toBeNull()
  expect(await json(await status())).toMatchObject({ state: 'invited', invitation: { id: i.id } })
  expect((await request(app, `/invitations/${i.id}/resolve`, 'POST', {}, 'member-a')).status).toBe(200)
  expect(await linked()).toBeNull()
  expect((await accept(i.id)).status).toBe(201)
  expect(await linked()).toBe('member-a')
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='member-a'").first('role')).toBe('owner')
  expect(await json(await status())).toMatchObject({ state: 'signed_in' })
})
it.each(['creator-a', 'inviter-a'])('176 invite requires entity create AND invite permission: %s', async actor => {
  expect((await invite(undefined, undefined, actor)).status).toBe(403)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
})
it('176 acceptance uniqueness 409 rolls back invitation claim and membership creation', async () => {
  const i = await invitation()
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p2'").run()
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='member-a'").run()
  const response = await accept(i.id)
  expect(response.status, await response.clone().text()).toBe(409)
  expect(await json(response)).toEqual({ error: 'account_already_linked' })
  expect(await linked()).toBeNull()
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(i.id).first('accepted_at')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='member-a'").first('n')).toBe(0)
})
it.each(['remove_access', 'member'])('176 %s clears all links, retains users; re-invite and accepted replay cannot restore links', async action => {
  const i = await invitation(); expect((await accept(i.id)).status).toBe(201)
  await env.DB.prepare("UPDATE teams SET user='member-a' WHERE id='t1'").run()
  const response = action === 'member' ? await request(app, '/orgs/org-a/members/member-a', 'DELETE') : await request(app, '/commands/people/remove_access', 'POST', { rowId: 'p1' })
  expect(response.status).toBe(action === 'member' ? 204 : 200)
  expect(await linked()).toBeNull()
  expect(await env.DB.prepare("SELECT user FROM teams WHERE id='t1'").first('user')).toBeNull()
  expect(await env.DB.prepare("SELECT id FROM users WHERE id='member-a'").first('id')).toBe('member-a')
  expect((await accept(i.id)).status).toBe(200)
  await invitation()
  expect(await linked()).toBeNull()
})
it('176 resend rotates target token; cancel frees row and permits another email without granting access', async () => {
  const i = await invitation()
  expect((await request(app, `/orgs/org-a/invitations/${i.id}/resend`, 'POST', {})).status).toBe(200)
  expect((await request(app, '/invitations/resolve', 'POST', { token: new URL(i.accept_url).searchParams.get('token') }, 'member-a')).status).toBe(404)
  expect((await invite('another@example.test')).status).toBe(409)
  expect((await request(app, `/orgs/org-a/invitations/${i.id}`, 'DELETE')).status).toBe(204)
  expect(await json(await status())).toMatchObject({ state: 'no_account' })
  await invitation('another@example.test')
  expect(await linked()).toBeNull()
})
it('176 row target rejects foreign rows, nonlinks and role escalation', async () => {
  expect((await invite(undefined, 'foreign')).status).toBe(404)
  expect((await request(app, '/orgs/org-a/invitations', 'POST', { email: 'a@example.test', role: 'owner', target: { entity: 'people', row: 'p1' } })).status).toBe(400)
  expect((await request(app, '/orgs/org-a/invitations', 'POST', { email: 'a@example.test', target: { entity: 'users', row: 'member-a' } })).status).toBe(400)
})

it('176 fresh mailbox login accepts as member and reads only linked own rows, including after a new login', async () => {
  const c = configuration()
  c.policies.people.member = { where: { user: { eq: '$actor.id' } } }
  const send = vi.fn().mockResolvedValue(undefined)
  app = createApp(c, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
  const created = await request(app, '/api/people', 'POST', { name: 'Invited person' })
  expect(created.status).toBe(201)
  const person = await json(created)
  const i = await invitation('fresh@example.test', person.id)
  expect(send).toHaveBeenCalledTimes(1)
  const link = send.mock.calls[0][0].text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)![0]
  const token = new URL(link).searchParams.get('token')!
  const anonymous = () => app.request('http://localhost/invitations/resolve', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
  const login = await anonymous()
  expect(login.status, await login.clone().text()).toBe(200)
  let bearer = login.headers.get('set-auth-token')!
  const call = (path: string, body: unknown) => app.request(`http://localhost${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const me = await app.request('http://localhost/me', { headers: { Authorization: `Bearer ${bearer}` } })
  const userId = (await json(me)).user.id
  const kernel = new KernelRegistry(c)
  await kernel.identity.updateProfile(runtime(), kernel.config, userId, { firstName: 'Fresh', lastName: 'Person' })
  expect(await env.DB.prepare('SELECT user FROM people WHERE id=?').bind(person.id).first('user')).toBeNull()
  expect((await call(`/invitations/${i.id}/accept`, {})).status).toBe(201)
  expect(await env.DB.prepare('SELECT role FROM memberships WHERE user_id=?').bind(userId).first('role')).toBe('member')
  const own = await call('/query', { entity: 'people', select: ['id'], limit: 100 })
  expect(await json(own)).toMatchObject({ data: [{ id: person.id }] })
  expect(await env.DB.prepare('SELECT user FROM people WHERE id=?').bind(person.id).first('user')).toBe(userId)
  // A fresh verified session resolves authority from the accepted link, not an invitation side effect.
  await env.DB.prepare('INSERT INTO sessions VALUES (?, ?,\'2099-01-01T00:00:00.000Z\')').bind(await sha256('synthetic-fresh-login'), userId).run()
  bearer = 'synthetic-fresh-login'
  expect(await json(await call('/query', { entity: 'people', select: ['id'], limit: 100 }))).toMatchObject({ data: [{ id: person.id }] })
})
it('176 console model declares row invitation support only on registered linked domain entities', async () => {
  const response = await request(app, '/o/org-a/console-model')
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body.model.entities.people.rowInvitations).toBe(true)
  expect(body.model.entities.users.rowInvitations).toBeUndefined()
})

async function agentToken(role = 'owner', operations: string[] | null = null) {
  const raw = 'wb_' + 'a'.repeat(64)
  await env.DB.prepare(`INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,operations,expires_at,created_at)
    VALUES ('credential','org-a','owner-a','Agent',?,'wb_aaaaaaaa',?,?, '2099-01-01T00:00:00.000Z','now')`).bind(await sha256(raw), role, operations && JSON.stringify(operations)).run()
  return (path: string, method = 'POST', data: unknown = { email: 'member-a@example.test', target: { entity: 'people', row: 'p1' } }) =>
    app.request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer ${raw}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(data) }) })
}
it('176 delegated MCP token can invite, stores its human issuer, and still requires recipient acceptance', async () => {
  const call = await agentToken()
  const response = await call('/orgs/org-a/invitations')
  expect(response.status, await response.clone().text()).toBe(201)
  const i = await json(response)
  expect(await env.DB.prepare('SELECT inviter_id FROM invitations WHERE id=?').bind(i.id).first('inviter_id')).toBe('owner-a')
  expect(await linked()).toBeNull()
  expect((await accept(i.id)).status).toBe(201)
  expect(await linked()).toBe('member-a')
})
it.each(['role', 'issuer', 'operations', 'revoked', 'expired'])('176 delegated token denies lost %s authority without invitations or links', async loss => {
  const call = await agentToken(loss === 'role' ? 'member' : 'owner', loss === 'operations' ? ['people.read'] : null)
  if (loss === 'issuer') await env.DB.prepare("UPDATE memberships SET role='member' WHERE user_id='owner-a'").run()
  if (loss === 'revoked') await env.DB.prepare("UPDATE access_tokens SET revoked_at='now'").run()
  if (loss === 'expired') await env.DB.prepare("UPDATE access_tokens SET expires_at='2000'").run()
  expect([401,403]).toContain((await call('/orgs/org-a/invitations')).status)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
  expect(await linked()).toBeNull()
})
it('176 removal revokes outstanding invitations for the account before clearing every link', async () => {
  const other = await invitation(undefined, 'p2')
  expect((await request(app, '/commands/people/link_account', 'POST', { rowId: 'p1', userId: 'member-a' })).status).toBe(200)
  expect((await request(app, '/commands/people/remove_access', 'POST', { rowId: 'p1' })).status).toBe(200)
  expect((await accept(other.id)).status).toBe(409)
  expect(await env.DB.prepare("SELECT user FROM people WHERE id='p2'").first('user')).toBeNull()
})
it('176 an issuer that loses invite permission cannot have an old invitation accepted', async () => {
  const i = await invitation()
  await env.DB.prepare("UPDATE memberships SET role='creator' WHERE user_id='owner-a'").run()
  expect([403,409]).toContain((await accept(i.id)).status)
  expect(await linked()).toBeNull()
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(i.id).first('accepted_at')).toBeNull()
})
it('176 concurrent invitations to one row have one winner; expiry frees the row for a different email', async () => {
  const responses = await Promise.all([invite('one@example.test'), invite('two@example.test')])
  expect(responses.map(response => response.status).sort()).toEqual([201,409])
  await env.DB.prepare("UPDATE invitations SET expires_at='2000'").run()
  expect((await invite('three@example.test')).status).toBe(201)
  expect(await linked()).toBeNull()
})
it('176 an explicit Link made while invitation is pending cannot be overwritten by acceptance', async () => {
  const i = await invitation()
  expect((await request(app, '/commands/people/link_account', 'POST', { rowId: 'p1', userId: 'creator-a' })).status).toBe(200)
  expect((await accept(i.id)).status).toBe(409)
  expect(await linked()).toBe('creator-a')
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(i.id).first('accepted_at')).toBeNull()
})

it('176b expired token is refused; expired row can resend a fresh seven-day token and accept', async () => {
  const i = await invitation()
  const token = new URL(i.accept_url).searchParams.get('token')
  await env.DB.prepare("UPDATE invitations SET created_at='2000-01-01',expires_at='2000-01-08' WHERE id=?").bind(i.id).run()
  expect(await json(await status())).toMatchObject({ state: 'expired', invitation: { id: i.id } })
  const refused = await request(app, '/invitations/accept', 'POST', { token }, 'member-a')
  expect(refused.status).toBe(410)
  expect(await json(refused)).toMatchObject({ error: 'invitation_expired' })
  expect(await linked()).toBeNull()
  const resent = await request(app, `/orgs/org-a/invitations/${i.id}/resend`, 'POST', {})
  expect(resent.status).toBe(200)
  expect(Date.parse((await json(resent)).expires_at) - Date.now()).toBeGreaterThan(6.99 * 86400000)
  expect((await request(app, '/invitations/accept', 'POST', { token }, 'member-a')).status).toBe(404)
  expect(await json(await status())).toMatchObject({ state: 'invited' })
  expect((await accept(i.id)).status).toBe(201)
})
it.each(['creator-a', 'inviter-a', 'member-a'])('176b copy-link denies non-inviter %s without rotating or disclosing token', async actor => {
  const i = await invitation()
  const hash = await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(i.id).first('token_hash')
  expect((await request(app, `/orgs/org-a/invitations/${i.id}/copy-link`, 'POST', {}, actor)).status).toBe(403)
  expect(await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(i.id).first('token_hash')).toBe(hash)
  const list = await request(app, '/orgs/org-a/invitations', 'GET', undefined, actor)
  expect(await list.text()).not.toMatch(/accept_url|token_hash|[a-f0-9]{64}/)
})
it('176b constrained token supports row read, invite, resend, copy and cancel with exact allowlists', async () => {
  const call = await agentToken('owner', ['people.read', 'people.create', 'invitations.read', 'invitations.create', 'invitations.revoke', 'invitations/create', 'invitations/resend', 'invitations/copy_link', 'invitations/revoke'])
  const i = await json(await call('/orgs/org-a/invitations'))
  expect(i.id).toBeTruthy()
  expect((await call('/orgs/org-a/row-access/people/p1', 'GET')).status).toBe(200)
  expect((await call(`/orgs/org-a/invitations/${i.id}/resend`)).status).toBe(200)
  const copy = await call(`/orgs/org-a/invitations/${i.id}/copy-link`)
  expect(copy.status).toBe(200)
  expect((await json(copy)).accept_url).toContain('token=')
  expect((await call(`/orgs/org-a/invitations/${i.id}`, 'DELETE', {})).status).toBe(204)
})
it('176b access filter runs before pagination and keeps row policy and credentials private', async () => {
  const i = await invitation()
  await env.DB.prepare("UPDATE invitations SET expires_at='2000' WHERE id=?").bind(i.id).run()
  for (const [rowAccess, ids] of [['expired', ['p1']], ['no_account', ['p2']], ['invited', []], ['signed_in', []]] as const) {
    const response = await request(app, '/query', 'POST', { entity: 'people', select: ['id'], rowAccess, limit: 1 })
    expect(response.status).toBe(200)
    expect((await json(response)).data.map((row: { id: string }) => row.id)).toEqual(ids)
  }
  const hidden = await request(app, '/query', 'POST', { entity: 'people', select: ['id'], rowAccess: 'expired', limit: 10 }, 'member-a')
  expect((await json(hidden)).data).toEqual([])
  const call = await agentToken('owner', ['people.read'])
  expect((await call('/query', 'POST', { entity: 'people', select: ['id'], rowAccess: 'expired', limit: 10 })).status).toBe(403)
})
it('176b member navigation contains only policy-readable entities and no settings or admin pages', async () => {
  const c = configuration()
  c.policies.teams.member = 'none'
  app = createApp(c, runtime())
  const response = await request(app, '/o/org-a/console-model', 'GET', undefined, 'member-a')
  const body = await json(response)
  expect(body.console.navigation.length).toBeGreaterThan(0)
  expect(body.console.navigation.every((item: { entity?: string; placement: string }) => !!item.entity && item.placement === 'sidebar' && item.entity !== 'teams')).toBe(true)
  const kernel = new KernelRegistry(c)
  const actor = await kernel.requireActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-member-a' } }), runtime())
  const registry = consoleRegistry(kernel.config, await requireScope(actor, 'org-a', kernel.config))
  expect(registry.navigation.every(item => !!item.entity && item.placement === 'sidebar' && item.entity !== 'teams')).toBe(true)
})

it.each([
  ['invite', ['people.create', 'invitations.create', 'invitations/create']],
  ['resend', ['people.create', 'invitations.create', 'invitations/resend']],
  ['copy-link', ['people.create', 'invitations.create', 'invitations/copy_link']],
  ['cancel', ['invitations.revoke', 'invitations/revoke']],
] as const)('176b documented minimum constrained token succeeds for %s', async (action, operations) => {
  const i = action === 'invite' ? undefined : await invitation()
  const call = await agentToken('owner', [...operations])
  const response = await call(action === 'invite' ? '/orgs/org-a/invitations' : `/orgs/org-a/invitations/${i!.id}${action === 'cancel' ? '' : `/${action}`}`, action === 'cancel' ? 'DELETE' : 'POST', action === 'invite' ? { email: 'member-a@example.test', target: { entity: 'people', row: 'p1' } } : {})
  expect(response.status).toBe(action === 'invite' ? 201 : action === 'cancel' ? 204 : 200)
})
it.each(['people.create', 'invitations.create', 'invitations/create'])('176b constrained invite denies missing %s', async missing => {
  const call = await agentToken('owner', ['people.create', 'invitations.create', 'invitations/create'].filter(operation => operation !== missing))
  expect((await call('/orgs/org-a/invitations')).status).toBe(403)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
})
it('176b cancelled replacement never resurrects expired row history; superseded resend refuses', async () => {
  const old = await invitation()
  await env.DB.prepare("UPDATE invitations SET expires_at='2000',created_at='2000' WHERE id=?").bind(old.id).run()
  const fresh = await invitation('other@example.test')
  expect(await env.DB.prepare('SELECT expired_at FROM invitations WHERE id=?').bind(old.id).first('expired_at')).toBeTruthy()
  expect((await request(app, `/orgs/org-a/invitations/${old.id}/resend`, 'POST', {})).status).toBe(409)
  expect((await request(app, `/orgs/org-a/invitations/${fresh.id}`, 'DELETE')).status).toBe(204)
  expect(await json(await status())).toMatchObject({ state: 'no_account' })
  const response = await request(app, '/query', 'POST', { entity: 'people', select: ['id'], rowAccess: 'expired', limit: 10 })
  expect((await json(response)).data).toEqual([])
})
it('176b status-only token sees state but no invitation details or management actions', async () => {
  await invitation()
  const call = await agentToken('owner', ['people.read', 'invitations.read'])
  const response = await call('/orgs/org-a/row-access/people/p1', 'GET')
  expect(response.status).toBe(200)
  expect(await json(response)).toEqual({ state: 'invited', inconsistency: null, can_invite: false, can_cancel: false })
})
it('176b copy link requires verified matching recipient, rotates old token and never appears in list data', async () => {
  const i = await invitation()
  const copy = await request(app, `/orgs/org-a/invitations/${i.id}/copy-link`, 'POST', {})
  const token = new URL((await json(copy)).accept_url).searchParams.get('token')
  expect((await request(app, '/invitations/accept', 'POST', { token: new URL(i.accept_url).searchParams.get('token') }, 'member-a')).status).toBe(404)
  expect((await request(app, '/invitations/accept', 'POST', { token }, 'creator-a')).status).toBe(403)
  const list = await request(app, '/orgs/org-a/invitations', 'GET', undefined, 'creator-a')
  expect(await list.text()).not.toMatch(/accept_url|token_hash|[a-f0-9]{64}/)
  expect((await request(app, '/invitations/accept', 'POST', { token }, 'member-a')).status).toBe(201)
})
it('176b access filters select live invited and signed-in rows and bind cursors to the filter', async () => {
  const i = await invitation()
  const query = (rowAccess: string, cursor?: string) => request(app, '/query', 'POST', { entity: 'people', select: ['id'], rowAccess, limit: 1, ...(cursor ? { cursor } : {}) })
  expect((await json(await query('invited'))).data).toEqual([{ id: 'p1' }])
  expect((await accept(i.id)).status).toBe(201)
  expect((await json(await query('signed_in'))).data).toEqual([{ id: 'p1' }])
  await env.DB.exec("INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p3','org-a','Three','now','now')")
  const first = await json(await query('no_account'))
  expect(first.data).toEqual([{ id: 'p2' }])
  expect(first.next_cursor).toBeTruthy()
  expect((await json(await query('no_account', first.next_cursor))).data).toEqual([{ id: 'p3' }])
  expect((await query('signed_in', first.next_cursor)).status).toBe(400)
})


it('14 status returns only an authorized minimal account summary for zero/one scalar links', async () => {
  expect(await json(await status())).toMatchObject({ state: 'no_account', inconsistency: null, linked_accounts: [] })
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p1'").run()
  const response = await status()
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const body = await json(response)
  expect(body).toMatchObject({ state: 'signed_in', inconsistency: null, linked_accounts: [{ id: 'member-a', label: 'Existing Person' }] })
  expect(Object.keys(body.linked_accounts[0]).sort()).toEqual(['id', 'label'])
  expect(JSON.stringify(body)).not.toMatch(/email|password|token_hash|accept_url/)
})
it('14 status-only token retains signed-in state without disclosing an unreadable account', async () => {
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p1'").run()
  const call = await agentToken('owner', ['people.read', 'invitations.read'])
  const response = await call('/orgs/org-a/row-access/people/p1', 'GET')
  expect(response.status).toBe(200)
  expect(await json(response)).toEqual({ state: 'signed_in', inconsistency: null, can_invite: false, can_cancel: false })
  const body = await json(await call('/o/org-a/console-model', 'GET'))
  expect(body.model.entities.people).toMatchObject({ accountLink: { field: 'user', entity: 'users' }, rowAccess: true })
  expect(body.model.entities.people.rowInvitations).toBeUndefined()
  expect(body.model.entities.people.fields.user).toBeUndefined()
  expect(body.model.entities.people.relations.account).toBeUndefined()
  expect(body.capabilities.commands).not.toContain('people/remove_access')
})
it.each(['source-field', 'target-row', 'target-field'])('14 Members summary respects source masks independently of users %s restrictions', async restriction => {
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p1'").run()
  const config = configuration()
  if (restriction === 'source-field') config.policies.people.owner = { where: {}, fields: ['name'] }
  if (restriction === 'target-row') config.policies.users.owner = { where: { id: { eq: 'owner-a' } } }
  if (restriction === 'target-field') config.policies.users.owner = { where: {}, fields: ['id'] }
  app = createApp(config, runtime())
  const response = await status()
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body.state).toBe('signed_in')
  if (restriction === 'source-field') expect(body.linked_accounts).toBeUndefined()
  if (restriction === 'target-row') expect(body.linked_accounts).toEqual([{ id: 'member-a', label: 'Existing Person' }])
  if (restriction === 'target-field') expect(body.linked_accounts).toEqual([{ id: 'member-a', label: 'Existing Person' }])
})
it('14 forbidden users query preserves independently authorized Members identity and actions', async () => {
  await invitation()
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p1'").run()
  const before = await json(await status())
  const config = configuration()
  config.policies.users.owner = { where: { id: { eq: 'owner-a' } }, deny: 'forbidden' }
  app = createApp(config, runtime())
  // The account query itself must still enforce its policy.
  const account = await request(app, '/query', 'POST', { entity: 'users', select: ['id', 'name'], where: { id: { eq: 'member-a' } }, limit: 1 })
  expect(account.status).toBe(403)
  expect(await json(account)).toMatchObject({ error: 'policy_violation' })
  const response = await status()
  expect(response.status).toBe(200)
  expect(await json(response)).toEqual({ ...before, state: 'signed_in', can_invite: true, can_cancel: true })
})
it('14 Members identity does not query the domain users display field', async () => {
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p1'").run()
  // Members names come from the identity profile, not the users entity label.
  await env.DB.exec('ALTER TABLE users RENAME COLUMN name TO unavailable_name')
  const response = await status()
  expect(response.status).toBe(200)
  expect(await json(response)).toMatchObject({ linked_accounts: [{ id: 'member-a', label: 'Existing Person' }] })
})
it.each(['invitations', 'entity'])('14 status still denies missing %s read and hides foreign rows', async missing => {
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p1'").run()
  const call = await agentToken('owner', missing === 'invitations' ? ['people.read', 'users.read'] : ['invitations.read', 'users.read'])
  const response = await call('/orgs/org-a/row-access/people/p1', 'GET')
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('member-a')
  expect((await request(app, '/orgs/org-a/row-access/people/foreign')).status).toBe(404)
})
it('14 structural metadata survives missing Members or status rights, with grants and relations intact', async () => {
  const config = configuration()
  const owner = await json(await request(app, '/o/org-a/console-model'))
  const call = await agentToken('owner', ['people.read'])
  const denied = await json(await call('/o/org-a/console-model', 'GET'))
  expect(denied.model.entities.people).toMatchObject({ accountLink: { field: 'user', entity: 'users' }, rowAccess: false })
  expect(denied.model.entities.people.rowInvitations).toBeUndefined()
  const withoutMembers = defineInstance({ ...config, plugins: (config.plugins ?? []).filter(plugin => !['members', 'machine-credentials'].includes(plugin.name)) })
  app = createApp(withoutMembers, runtime())
  const without = await json(await request(app, '/o/org-a/console-model'))
  expect(without.model.entities.people).toMatchObject({ accountLink: { field: 'user', entity: 'users' }, rowAccess: false })
  expect(without.model.entities.people.rowInvitations).toBeUndefined()
  expect(without.model.entities.people.fields).toEqual(owner.model.entities.people.fields)
  expect(without.model.entities.people.relations).toEqual(owner.model.entities.people.relations)
  expect(without.model.entities.users.accountLink).toBeUndefined()
})

it('14 legacy agent cannot disclose Members identity even with a requested members.read operation', async () => {
  await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p1'").run()
  for (const membersRead of [false, true]) {
    await env.DB.exec('DELETE FROM access_tokens')
    const call = await agentToken('owner', ['people.read', 'users.read', 'invitations.read', ...(membersRead ? ['members.read'] : [])])
    const body = await json(await call('/orgs/org-a/row-access/people/p1', 'GET'))
    expect(body.state).toBe('signed_in')
    expect(body).not.toHaveProperty('linked_accounts')
    expect((await call('/orgs/org-a/members', 'GET')).status).toBe(403)
  }
})

it('178 active membership and row-targeted pending link coexist; accept creates no second membership', async () => {
  const count = () => env.DB.prepare("SELECT count(*) n FROM memberships WHERE organization_id='org-a' AND user_id='member-a'").first('n')
  expect(await count()).toBe(1)
  const i = await invitation()
  const combined = await json(await request(app, '/orgs/org-a/members?include=pending'))
  expect(responseContract('/orgs/{orgId}/members').safeParse(combined).success).toBe(true)
  const rows = combined.data
  expect(rows.filter((row: { email: string }) => row.email === 'member-a@example.test')).toHaveLength(2)
  expect(rows.find((row: { id: string }) => row.id === i.id)).toMatchObject({ kind: 'invitation', target_entity: 'people', target_row: 'p1' })
  expect((await accept(i.id)).status).toBe(201)
  expect(await count()).toBe(1)
  expect(await linked()).toBe('member-a')
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE organization_id='org-a' AND user_id='member-a'").first('role')).toBe('member')
})
it('178 searched linked account explains ineligibility without changing the eligible-only picker contract', async () => {
  await env.DB.exec("UPDATE people SET user='member-a' WHERE id='p2'")
  const base = '/orgs/org-a/members?eligible=link_account&target_entity=people&target_row=p1'
  expect((await json(await request(app, base))).data.some((row: { user_id: string }) => row.user_id === 'member-a')).toBe(false)
  const response = await request(app, base + '&q=member-a@example.test')
  expect(response.status).toBe(200)
  const searched = await json(response)
  expect(responseContract('/orgs/{orgId}/members').safeParse(searched).success).toBe(true)
  expect(searched.data).toEqual([expect.objectContaining({ user_id: 'member-a', linkable: false, link_reason: 'account_already_linked' })])
})

it.each([true, false])('178 direct create rejects a known linked account (membership=%s) without invitation or mail', async membership => {
  await env.DB.exec("UPDATE people SET user='member-a' WHERE id='p2'")
  if (!membership) await env.DB.exec("DELETE FROM memberships WHERE user_id='member-a'")
  const response = await invite(' MEMBER-A@EXAMPLE.TEST ')
  const body = await json(response)
  expect([response.status, body]).toEqual([409, { error: 'account_already_linked' }])
  expect(responseContract('/orgs/{orgId}/invitations', 'post', '409').safeParse(body).success).toBe(true)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')).toBe(0)
  expect(await linked()).toBeNull()
})

it('178 create uniqueness is scoped to the same entity and organization, with unknown addresses allowed', async () => {
  await env.DB.exec("INSERT INTO users (id,organization_id,email,name,created_at,updated_at) VALUES ('foreign-member','org-b','foreign@example.test','Foreign','now','now'); UPDATE teams SET user='member-a' WHERE id='t1'; UPDATE people SET user='foreign-member' WHERE id='foreign'")
  const i = await invitation()
  expect(responseContract('/orgs/{orgId}/invitations', 'post', '201').safeParse(i).success).toBe(true)
  await invitation('foreign@example.test', 'p2')
  await env.DB.exec("INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p3','org-a','Unknown','now','now')")
  await invitation('unknown@example.test', 'p3')
  expect(await linked()).toBeNull()
})

it.each(['members.read', 'invitations.create', 'read', 'update', 'policy'])('178 searched linked identity is withheld without %s authority', async gate => {
  const config = configuration()
  if (gate === 'members.read' || gate === 'invitations.create') config.organizationPermissions.owner = config.organizationPermissions.owner!.filter(action => action !== gate)
  else if (gate === 'policy') config.policies.people.owner = 'none'
  else config.permissions.owner.people = config.permissions.owner.people.filter(operation => operation !== gate)
  app = createApp(config, runtime())
  await env.DB.exec("UPDATE people SET user='member-a' WHERE id='p2'")
  const path = '/orgs/org-a/members?eligible=link_account&target_entity=people&target_row=p1&q=member-a@example.test'
  const response = gate === 'members.read'
    ? await (await agentToken('owner', ['people.read', 'people.update', 'invitations.create']))(path, 'GET')
    : await request(app, path)
  expect(response.status).toBe(gate === 'members.read' ? 403 : 400)
  expect(await json(response)).toEqual({ error: gate === 'members.read' ? 'operation_forbidden' : 'invalid_link_target' })
})

it('178 a link committed after create preflight rejects the atomic insert and its mail intent', async () => {
  const batch = env.DB.batch.bind(env.DB)
  const spy = vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
    await env.DB.prepare("UPDATE people SET user='member-a' WHERE id='p2'").run()
    return batch(statements)
  })
  try {
    const response = await invite()
    expect([response.status, await json(response)]).toEqual([409, { error: 'account_already_linked' }])
    expect(spy).toHaveBeenCalled()
    expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')).toBe(0)
  } finally { spy.mockRestore() }
})

it('178 concurrent accepts of an earlier invitation all reject the linked account and roll back membership creation', async () => {
  const i = await invitation()
  await env.DB.exec("UPDATE people SET user='member-a' WHERE id='p2'; DELETE FROM memberships WHERE user_id='member-a'")
  const responses = await Promise.all(Array.from({ length: 6 }, () => accept(i.id)))
  for (const response of responses) expect([response.status, await json(response)]).toEqual([409, { error: 'account_already_linked' }])
  expect(await linked()).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) n FROM people WHERE organization_id='org-a' AND user='member-a'").first('n')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='member-a'").first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(i.id).first('accepted_at')).toBeNull()
})
