import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { createApp } from '@workbasehq/core/app'
import { initialSchema } from '../../../core/src/migrations/schema'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { sha256 } from '@workbasehq/core/crypto'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { permissions } from '@workbasehq/plugins/permissions'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { runtime, request, json, completeInvitationProfiles } from '@workbasehq/test-support/helpers'

function configuration() {
  return defineInstance({ id: 'row_invitations', revision: 1, interactive: true, account: { entity: 'users' },
    plugins: [createIdentity(), createLocalAuth(), permissions({ roles: ['owner', 'member', 'creator', 'inviter'] }), createMembers(), createOrganizations(), machineCredentials(), mailOutbox()],
    roles: ['owner', 'member', 'creator', 'inviter'],
    entities: {
      users: { fields: { name: { type: 'string' } } },
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
  app = createApp(c, runtime())
  const created = await request(app, '/api/people', 'POST', { name: 'Invited person' })
  expect(created.status).toBe(201)
  const person = await json(created)
  const i = await invitation('fresh@example.test', person.id)
  const mail = await env.DB.prepare('SELECT body FROM email_outbox WHERE id=(SELECT delivery_outbox_id FROM invitations WHERE id=?)').bind(i.id).first<string>('body')
  const token = new URL(mail!.replace('Accept: ', '')).searchParams.get('token')!
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
  const i = await invitation(); expect((await accept(i.id)).status).toBe(201)
  const other = await invitation(undefined, 'p2')
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
