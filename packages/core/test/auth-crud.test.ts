import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { setup, request, json, insertDomain, syntheticPassword, runtime } from '@workbasehq/test-support/helpers'
import { createApp } from '../src/app'
import { defineInstance } from '../src/config'
import sample from './fixtures/sample/config'
import { sha256 } from '../src/crypto'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
beforeEach(completeInvitationProfiles)
it('authenticates PBKDF2 passwords, stores only session hashes, and revokes logout', async () => {
  expect((await request(app, '/auth/login', 'POST', { email: 'owner.a@example.test', password: 'wrong' })).status).toBe(401)
  const logged = await request(app, '/auth/login', 'POST', { email: 'owner.a@example.test', password: syntheticPassword })
  expect(logged.status).toBe(200)
  const { token } = await json(logged); expect(token).toHaveLength(64)
  const stored = await env.DB.prepare('SELECT token_hash,expires_at FROM sessions WHERE token_hash=?').bind(await sha256(token)).first<any>()
  expect(stored.token_hash).not.toBe(token)
  expect(Date.parse(stored.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86400000)
  const headers = { Authorization: `Bearer ${token}` }
  expect((await request(app, '/api/clients', 'GET', undefined, 'owner-a', 'org-a', headers)).status).toBe(200)
  expect((await request(app, '/auth/logout', 'POST', undefined, 'owner-a', 'org-a', headers)).status).toBe(204)
  expect((await request(app, '/api/clients', 'GET', undefined, 'owner-a', 'org-a', headers)).status).toBe(401)
  expect((await request(app, '/auth/register', 'POST', { email: 'new@example.test', password: syntheticPassword })).status).toBe(400)
})
it('enforces every viewer write and cross-org direct ids including relations', async () => {
  await insertDomain(); await insertDomain('org-b')
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const path = method === 'POST' ? '/api/clients' : '/api/clients/client-org-a'
    expect((await request(app, path, method, { name: 'Forbidden', version: 1 }, 'viewer-a')).status).toBe(403)
  }
  for (const method of ['GET', 'PATCH', 'DELETE']) expect((await request(app, '/api/clients/client-org-b', method, method === 'PATCH' ? { name: 'Hidden', version: 1 } : undefined)).status).toBe(404)
  expect((await request(app, '/api/clients', 'GET', undefined, 'owner-a', 'org-b')).status).toBe(403)
  expect((await request(app, '/api/jobs', 'POST', { title: 'Foreign client', client_id: 'client-org-b' })).status).toBe(409)
  const listed = await json(await request(app, '/api/jobs?expand=client'))
  expect(listed.data).toHaveLength(1); expect(listed.data[0].client.organization_id).toBe('org-a')
  await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind('viewer-a', 'org-b', 'dispatcher').run()
  expect((await request(app, '/api/clients', 'POST', { name: 'Other membership' }, 'viewer-a', 'org-b')).status).toBe(201)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM security_log WHERE status=403').first('n')).toBe(4)
})
it('generates CRUD for a config-added field, filters/paginates, and checks optimistic versions', async () => {
  const extended = defineInstance({ ...sample, entities: { ...sample.entities, clients: { ...sample.entities.clients, fields: { ...sample.entities.clients.fields, rating: { type: 'int', default: 1 } } } } })
  app = await setup(extended)
  const created = await request(app, '/api/clients', 'POST', { name: 'Alpha', rating: 4, email: 'private@example.test' }, 'owner-a', 'org-a', { 'X-Correlation-Id': 'trace-test' })
  expect(created.status).toBe(201); const row = await json(created); expect(row.rating).toBe(4)
  await request(app, '/api/clients', 'POST', { name: 'Beta' })
  const page = await json(await request(app, '/api/clients?limit=1'))
  expect(page.data).toHaveLength(1); expect(page.next_cursor).toBeTruthy()
  expect((await json(await request(app, `/api/clients?limit=1&cursor=${page.next_cursor}`))).data).toHaveLength(1)
  expect((await json(await request(app, '/api/clients?rating[gte]=3'))).data).toHaveLength(1)
  expect((await request(app, `/api/clients/${row.id}`, 'PATCH', { name: 'Updated', version: 1 })).status).toBe(200)
  expect((await request(app, `/api/clients/${row.id}`, 'PATCH', { name: 'Stale', version: 1 })).status).toBe(409)
  const event = await env.DB.prepare("SELECT payload FROM audit_outbox WHERE json_extract(payload,'$.correlation_id')='trace-test'").first<string>('payload')
  expect(event).toContain('rating'); expect(event).not.toContain('private@example.test'); expect(event).not.toContain('password')
  expect((await request(app, '/api/clients', 'POST', { name: 'No', organization_id: 'org-b' })).status).toBe(400)
  expect((await request(app, `/api/clients/${row.id}`, 'DELETE')).status).toBe(204)
})
async function invite(role = 'viewer', address = 'invitee@example.test') {
  const res = await request(app, '/orgs/org-a/invitations', 'POST', { email: address, role })
  expect(res.status).toBe(201)
  const row = await env.DB.prepare('SELECT body FROM email_outbox WHERE recipient=? ORDER BY created_at DESC').bind(address).first<{ body: string }>()
  return /token=([a-f0-9]{64})/.exec(row!.body)![1]
}
it('accepts invitations once, ignores forged role, rejects expiry, and requires owners', async () => {
  for (const user of ['viewer-a', 'dispatcher-a']) expect((await request(app, '/orgs/org-a/invitations', 'POST', { email: 'x@example.test', role: 'owner' }, user)).status).toBe(403)
  const token = await invite('viewer', 'owner.b@example.test')
  const expired = await invite('dispatcher', 'expired@example.test')
  const accepted = await request(app, '/invitations/accept', 'POST', { token, role: 'owner' }, 'owner-b', 'org-b')
  expect(accepted.status).toBe(201); expect((await json(accepted)).role).toBe('viewer')
  expect(await env.DB.prepare("SELECT role FROM memberships JOIN users ON users.id=memberships.user_id WHERE email='owner.b@example.test' AND organization_id='org-a'").first('role')).toBe('viewer')
  expect((await request(app, '/invitations/accept', 'POST', { token }, 'owner-b', 'org-b')).status).toBe(200)
  await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE email='expired@example.test'").run()
  expect(await json(await request(app, '/invitations/preflight', 'POST', { token: expired }, 'owner-b', 'org-b'))).toMatchObject({ state: 'expired', account_match: false })
  expect((await request(app, '/auth/register', 'POST', { token: expired }, 'owner-b', 'org-b')).status).toBe(403)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email='owner.b@example.test'").first('n')).toBe(1)
})
it('atomically resolves concurrent invitation claims and binds existing-user acceptance to identity', async () => {
  const token = await invite('dispatcher', 'owner.b@example.test')
  const responses = await Promise.all([1, 2].map(() => request(app, '/invitations/accept', 'POST', { token }, 'owner-b', 'org-b')))
  expect(responses.map(r => r.status).sort()).toEqual([200, 201])
  expect(await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email='owner.b@example.test'").first('n')).toBe(1)
  const existingResponse = await request(app, '/orgs/org-b/invitations', 'POST', { email: 'dispatcher.a@example.test', role: 'viewer' }, 'owner-b', 'org-b')
  expect(existingResponse.status).toBe(201)
  const existingMail = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='dispatcher.a@example.test'").first<string>('body')
  const existing = /token=([a-f0-9]{64})/.exec(existingMail!)![1]
  expect((await request(app, '/invitations/accept', 'POST', { token: existing })).status).toBe(403)
  expect((await request(app, '/invitations/accept', 'POST', { token: existing }, 'dispatcher-a', 'org-a')).status).toBe(201)
})
it('forbids generic booking mutations and leaves counters read-only', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) expect((await request(app, `/api/bookings${method === 'POST' ? '' : '/x'}`, method, {})).status).toBe(405)
  await insertDomain()
  expect((await request(app, '/api/slots/slot-org-a', 'PATCH', { booked: 3, version: 1 })).status).toBe(400)
})
it('rejects inherited object names as entities, filters and relations without executing SQL identifiers', async () => {
  expect((await request(app, '/api/constructor')).status).toBe(404)
  expect((await request(app, '/api/clients?constructor=value')).status).toBe(400)
  expect((await request(app, '/api/clients?expand=constructor')).status).toBe(400)
})
it('refuses already-member invitations without altering their existing role', async () => {
  const response = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.a@example.test', role: 'viewer' })
  expect(response.status).toBe(200); expect(await json(response)).toEqual({ message: 'already_member' })
  expect(await env.DB.prepare("SELECT count(*) AS n FROM invitations WHERE email='owner.a@example.test'").first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='owner-a' AND organization_id='org-a'").first('role')).toBe('owner')
})
it('records denied attempts using route templates without logging user-supplied path secrets', async () => {
  expect((await request(app, '/api/clients/private@example.test', 'DELETE', undefined, 'viewer-a')).status).toBe(403)
  const row = await env.DB.prepare('SELECT operation FROM security_log').first<{ operation: string }>()
  expect(row!.operation).toBe('DELETE /api/:entity/:id')
  expect(row!.operation).not.toContain('private@example.test')
})
it('supports all configured field types and a new entity without adding core routes', async () => {
  const extra = defineInstance({
    ...sample,
    entities: { ...sample.entities, materials: { fields: {
      name: { type: 'string', required: true }, description: { type: 'text' }, quantity: { type: 'int', min: 0 },
      price: { type: 'float', min: 0, default: 1.5 }, active: { type: 'bool', default: true }, due: { type: 'datetime' },
      state: { type: 'enum', values: ['draft', 'ready'], default: 'draft' }, client_id: { type: 'ref', entity: 'clients' },
    }, relations: { client: { field: 'client_id', entity: 'clients' } } } },
    policies: { ...sample.policies, materials: { owner: 'all' } },
    permissions: { ...sample.permissions, owner: { ...sample.permissions.owner, materials: ['read', 'create', 'update', 'delete'] } },
  })
  app = await setup(extra)
  const client = await json(await request(app, '/api/clients', 'POST', { name: 'Typed client' }))
  const fields = { name: 'Synthetic material', description: 'Multiline\ntext', quantity: 2, price: 5.5, active: false, due: '2026-11-01T12:00:00.000Z', state: 'ready', client_id: client.id }
  const created = await request(app, '/api/materials', 'POST', fields)
  expect(created.status).toBe(201); const row = await json(created); expect(row).toMatchObject(fields)
  const patched = await request(app, `/api/materials/${row.id}`, 'PATCH', { active: true, version: 1 })
  expect(patched.status).toBe(200); expect((await json(patched)).active).toBe(true)
  const listed = await json(await request(app, '/api/materials?active=true&price[gte]=5&expand=client'))
  expect(listed.data).toHaveLength(1); expect(listed.data[0].client.id).toBe(client.id)
  expect(listed.data[0].active).toBe(true)
  expect((await request(app, '/api/materials', 'POST', { ...fields, active: 1 })).status).toBe(400)
})
