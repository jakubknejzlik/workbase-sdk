import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import accounts from '../../../core/test/fixtures/accounts/config'
import { createApp } from '@workbasehq/core/app'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { sha256 } from '@workbasehq/core/crypto'
import { json, request, runtime, setup } from '@workbasehq/test-support/helpers'

let app: ReturnType<typeof createApp>
beforeEach(async () => { app = await setup() })
const invite = (email = 'pending@example.test') => request(app, '/orgs/org-a/invitations', 'POST', { email, role: 'viewer' })
const path = (id: string, suffix: string) => `/orgs/org-a/invitations/${id}/${suffix}`

beforeEach(completeInvitationProfiles)
it('concurrent normalized duplicates create one invitation and one outbox intent with sanitized conflicts', async () => {
  const results = await Promise.all([invite(' Pending@Example.test '), invite('pending@example.test')])
  expect(results.map(r => r.status).sort()).toEqual([201, 409])
  expect(await json(results.find(r => r.status === 409)!)).toEqual({ error: 'invitation_pending' })
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')).toBe(1)
})
it('storage rejects direct live duplicates, while expiry, revoke and acceptance permit a fresh invitation', async () => {
  const created = await json(await invite())
  const insert = () => env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES (?,?,?,?,?,?,?)')
    .bind('second', 'org-a', ' PENDING@example.test ', 'viewer', 'b'.repeat(64), new Date(Date.now() + 86400000).toISOString(), 'owner-a').run()
  await expect(insert()).rejects.toThrow()
  await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?").bind(created.id).run()
  await insert()
  await env.DB.prepare('DELETE FROM invitations WHERE id=?').bind('second').run()
  const fresh = await json(await invite())
  expect((await request(app, `/orgs/org-a/invitations/${fresh.id}`, 'DELETE')).status).toBe(204)
  expect((await invite()).status).toBe(201)
})
it('fixed seven-day expiry rejects an expiry picker and reports queued delivery', async () => {
  expect((await request(app, '/orgs/org-a/invitations', 'POST', { email: 'x@example.test', role: 'viewer', expires_at: new Date(Date.now() + 1000).toISOString() })).status).toBe(400)
  const start = Date.now(); const response = await invite(); const body = await json(response)
  expect(body).toMatchObject({ delivery: { status: 'queued', attempts: 0 } })
  expect(Date.parse(body.expires_at) - start).toBeGreaterThanOrEqual(7 * 86400000)
  expect(Date.parse(body.expires_at) - start).toBeLessThan(7 * 86400000 + 5000)
})
it('combined access view contains safe members and valid pending invitations, with no credentials or ordinary-member actions', async () => {
  const pending = await json(await invite())
  const response = await request(app, '/orgs/org-a/members?include=pending', 'GET', undefined, 'viewer-a')
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'member', user_id: 'viewer-a', status: 'active', actions: [] }),
    expect.objectContaining({ kind: 'invitation', id: pending.id, status: 'pending', actions: [] }),
  ]))
  expect(JSON.stringify(body)).not.toMatch(/token|accept_url|outbox|password/)
  expect((await request(app, '/orgs/org-b/members?include=pending', 'GET', undefined, 'viewer-a')).status).toBe(403)
})
it('Copy Link rotates, returns a no-store URL once, invalidates old credentials and sends no mail', async () => {
  const created = await json(await invite())
  const old = await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(created.id).first('token_hash')
  const before = await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')
  const response = await request(app, path(created.id, 'copy-link'), 'POST', {})
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store')
  const body = await json(response); const token = new URL(body.accept_url).searchParams.get('token')!
  expect(await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(created.id).first('token_hash')).toBe(await sha256(token))
  expect(await sha256(token)).not.toBe(old)
  expect(await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')).toBe(before)
  for (const url of ['/orgs/org-a/invitations', '/orgs/org-a/members?include=pending', '/me']) expect(JSON.stringify(await json(await request(app, url)))).not.toContain(token)
})
it.each(['copy-link', 'resend', 'delivery', 'retry-delivery'])('ordinary members and foreign scopes cannot access management endpoint %s', async suffix => {
  const created = await json(await invite())
  const method = suffix === 'delivery' ? 'GET' : 'POST'
  expect((await request(app, path(created.id, suffix), method, undefined, 'viewer-a')).status).toBe(403)
  expect((await request(app, path(created.id, suffix).replace('org-a', 'org-b'), method, undefined, 'owner-b', 'org-b')).status).toBe(409)
})
it('resend renders a reminder from authorized metadata, rotates and extends expiry; status and retry are sanitized and idempotent', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('SECRET provider payload')).mockResolvedValue(undefined)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    app = createApp(sample, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
    const created = await json(await invite())
    expect(created.delivery).toMatchObject({ status: 'failed', attempts: 1, error: 'email_send_failed' })
    expect(JSON.stringify(created)).not.toContain('SECRET')
    expect((await request(app, path(created.id, 'retry-delivery'), 'POST')).status).toBe(200)
    expect(await json(await request(app, path(created.id, 'delivery')))).toMatchObject({ delivery: { status: 'delivered', attempts: 2 } })
    await request(app, path(created.id, 'retry-delivery'), 'POST'); expect(send).toHaveBeenCalledTimes(2)
    const oldHash = await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(created.id).first('token_hash')
    const result = await json(await request(app, path(created.id, 'resend'), 'POST', {}))
    expect(result).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
    expect(await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(created.id).first('token_hash')).not.toBe(oldHash)
    expect(send.mock.calls[2][0]).toMatchObject({ subject: expect.stringMatching(/^Reminder: .*Organization A/) })
    expect(send.mock.calls[2][0].text).toContain('seven days')
  } finally { log.mockRestore() }
})
it('pending uniqueness migration and index are covered by the deploy gate', async () => {
  const kernel = new KernelRegistry(sample)
  await env.DB.prepare('DROP INDEX invitations_one_pending_email').run()
  await expect(kernel.plugins.find(plugin => plugin.name === 'members')!.checkSchema!(env.DB, kernel.config)).rejects.toThrow()
})

it('Copy Link racing another rotation has one winner and cannot roll back the winner credential', async () => {
  const created = await json(await invite())
  const replies = await Promise.all(Array.from({ length: 4 }, () => request(app, path(created.id, 'copy-link'), 'POST')))
  expect(replies.filter(r => r.status === 200)).toHaveLength(1)
  for (const reply of replies.filter(r => r.status !== 200)) expect(await json(reply)).toEqual({ error: 'invitation_conflict' })
  const winner = await json(replies.find(r => r.status === 200)!)
  expect(await env.DB.prepare('SELECT token_hash FROM invitations WHERE id=?').bind(created.id).first('token_hash'))
    .toBe(await sha256(new URL(winner.accept_url).searchParams.get('token')!))
})
it('failed audit leaves the old credential and mail association intact without returning a URL', async () => {
  const created = await json(await invite())
  const before = await env.DB.prepare('SELECT token_hash,delivery_outbox_id FROM invitations WHERE id=?').bind(created.id).first()
  await env.DB.exec("CREATE TRIGGER p8_audit_failure BEFORE INSERT ON audit_outbox BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;")
  const result = await request(app, path(created.id, 'copy-link'), 'POST')
  expect(result.status).toBeGreaterThanOrEqual(400); expect(await json(result)).not.toHaveProperty('accept_url')
  expect(await env.DB.prepare('SELECT token_hash,delivery_outbox_id FROM invitations WHERE id=?').bind(created.id).first()).toEqual(before)
})
it.each(['accepted', 'revoked', 'expired'])('terminal %s invitations cannot rotate, resend or retry', async terminal => {
  const created = await json(await invite())
  if (terminal === 'accepted') await env.DB.prepare('UPDATE invitations SET accepted_at=? WHERE id=?').bind(new Date().toISOString(), created.id).run()
  if (terminal === 'revoked') await env.DB.prepare('UPDATE invitations SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), created.id).run()
  if (terminal === 'expired') await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?").bind(created.id).run()
  for (const suffix of ['copy-link', 'resend', 'retry-delivery']) {
    const result = await request(app, path(created.id, suffix), 'POST')
    expect(result.status).toBe(409); expect(await json(result)).toEqual({ error: 'invitation_unavailable' })
  }
  expect((await json(await request(app, '/orgs/org-a/members?include=pending'))).data.filter((row: { kind: string }) => row.kind === 'invitation')).toEqual([])
})
it('pending uniqueness is per scope and acceptance releases its slot without retaining the credential in a read projection', async () => {
  const a = await json(await invite('owner.b@example.test'))
  expect((await request(app, '/orgs/org-b/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }, 'owner-b', 'org-b')).status).toBe(200)
  expect((await request(app, '/orgs/org-b/invitations', 'POST', { email: 'pending@example.test', role: 'viewer' }, 'owner-b', 'org-b')).status).toBe(201)
  const result = await request(app, '/invitations/accept', 'POST', { token: new URL(a.accept_url).searchParams.get('token') }, 'owner-b')
  expect(result.status).toBe(201)
  await request(app, '/orgs/org-a/members/owner-b', 'DELETE')
  expect((await invite('owner.b@example.test')).status).toBe(201)
})
it('Copy Link makes the earlier mail ineligible and its raw token unusable', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  const created = await json(await invite())
  const before = await env.DB.prepare('SELECT token_hash,delivery_outbox_id FROM invitations WHERE id=?').bind(created.id).first<{ token_hash: string; delivery_outbox_id: string }>()
  expect((await request(app, path(created.id, 'copy-link'), 'POST')).status).toBe(200)
  const stale = await request(app, '/invitations/accept', 'POST', { token: new URL(created.accept_url).searchParams.get('token') }, 'owner-b')
  expect(stale.status).toBe(404)
  const kernel = new KernelRegistry(sample)
  const { invitationDeliveryEligible } = await import('../src/mail')
  await kernel.mailOutbox.retry({ ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }, kernel.config, before!.delivery_outbox_id,
    () => invitationDeliveryEligible(env.DB, created.id, 'org-a', before!.delivery_outbox_id, before!.token_hash))
  expect(send).not.toHaveBeenCalled()
  expect(await json(await request(app, path(created.id, 'delivery')))).toMatchObject({ delivery: { status: 'not_requested', attempts: 0 } })
})

it('deploy schema checks reject a weakened pending index and a missing expiry trigger', async () => {
  const { pendingIndexSQL } = await import('../src/migrations/002-pending-invitations')
  const kernel = new KernelRegistry(sample)
  const check = () => kernel.plugins.find(plugin => plugin.name === 'members')!.checkSchema!(env.DB, kernel.config)
  await env.DB.prepare('DROP INDEX invitations_one_pending_email').run()
  await env.DB.prepare(pendingIndexSQL.replace('CREATE UNIQUE INDEX', 'CREATE INDEX')).run()
  await expect(check()).rejects.toThrow()
  await env.DB.prepare('DROP INDEX invitations_one_pending_email').run()
  await env.DB.prepare(pendingIndexSQL).run()
  await env.DB.prepare('DROP TRIGGER invitations_expire_before_insert').run()
  await expect(check()).rejects.toThrow()
})
it('additive adoption retains historical invitations and deterministically retires legacy live duplicates', async () => {
  const kernel = new KernelRegistry(sample)
  const originalMembers = kernel.plugins.find(plugin => plugin.name === 'members')!
  await setup({ ...sample, plugins: sample.plugins!.map(plugin => plugin.name === 'members' ? { ...plugin, migrations: plugin.migrations!.slice(0, 1) } : plugin) })
  const now = new Date().toISOString(); const future = new Date(Date.now() + 86400000).toISOString()
  for (const [id, email, expiry] of [['a', 'UPGRADE@example.test', future], ['b', ' upgrade@example.test ', future], ['c', 'expired@example.test', '2000-01-01']]) {
    await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, 'org-a', email, 'viewer', id.repeat(64), expiry, 'owner-a', now).run()
  }
  await kernel.applyMigrations(env.DB)
  expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(3)
  expect(await env.DB.prepare("SELECT revoked_at FROM invitations WHERE id='a'").first('revoked_at')).not.toBeNull()
  expect(await env.DB.prepare("SELECT revoked_at FROM invitations WHERE id='b'").first('revoked_at')).toBeNull()
  expect(await env.DB.prepare("SELECT expired_at FROM invitations WHERE id='c'").first('expired_at')).not.toBeNull()
  await originalMembers.checkSchema!(env.DB, kernel.config)
})

it('P6 combined projection supplies batched names, last-admin guard and configured least privilege without profile internals', async () => {
  await env.DB.prepare("DELETE FROM identity_profiles WHERE user_id='owner-a'").run()
  await env.DB.prepare('UPDATE "user" SET name=? WHERE id=?').bind('Ada Example', 'owner-a').run()
  const owner = await json(await request(app, '/orgs/org-a/members?include=pending'))
  expect(owner.data).toEqual(expect.arrayContaining([expect.objectContaining({ user_id: 'owner-a', display_name: 'Ada Example', last_administrator: true })]))
  expect(owner.role_options).toEqual(expect.arrayContaining([{ id: 'owner', administrator: true }, { id: 'viewer', administrator: false }]))
  expect(owner.default_role).toBe('viewer')
  expect(owner.role_options.map((role: { id: string }) => role.id)).not.toContain('member')
  const viewer = await json(await request(app, '/orgs/org-a/members?include=pending', 'GET', undefined, 'viewer-a'))
  expect(viewer.role_options.every((role: { administrator: boolean }) => !role.administrator)).toBe(true)
  expect(JSON.stringify(viewer)).not.toMatch(/first_name|last_name|synced|source_provider|token_hash/)
})

it('accounts owner role options exclude built-in member and default to authored coordinator until #177', async () => {
  app = await setup(accounts)
  await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256('synthetic-administrator'), 'administrator', new Date(Date.now() + 60000).toISOString()).run()
  const response = await request(app, '/orgs/org-a/members?include=pending', 'GET', undefined, 'administrator')
  expect(response.status).toBe(200)
  const view = await json(response)
  expect(view.default_role).toBe('coordinator')
  expect(view.role_options.map((role: { id: string }) => role.id)).not.toContain('member')
  expect(view.role_options).toContainEqual({ id: 'administrator', administrator: true })
})

it('combined members prefer profile names over legacy names without exposing profile fields', async () => {
  await env.DB.prepare("UPDATE identity_profiles SET first_name='Anna',last_name='Správcová' WHERE user_id='owner-a'").run()
  const response = await request(app, '/orgs/org-a/members?include=pending')
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body.data).toContainEqual(expect.objectContaining({ user_id: 'owner-a', email: 'owner.a@example.test', display_name: 'Anna Správcová' }))
  expect(JSON.stringify(body)).not.toMatch(/firstName|lastName|first_name|last_name|synced|source_provider/)
  const plain = await json(await request(app, '/orgs/org-a/members'))
  expect(plain.data).toContainEqual({ user_id: 'owner-a', email: 'owner.a@example.test', role: 'owner' })
})

it('combined members use external profile names only while their synchronized binding is current', async () => {
  await env.DB.prepare("INSERT INTO identities VALUES ('viewer-a','test-idp','issuer','subject','now')").run()
  await env.DB.prepare("UPDATE identity_profiles SET first_name='Synced',last_name='Person' WHERE user_id='viewer-a'").run()
  const member = async () => (await json(await request(app, '/orgs/org-a/members?include=pending'))).data.find((row: { user_id: string }) => row.user_id === 'viewer-a')
  expect(await member()).toMatchObject({ display_name: 'viewer-a' })
  await env.DB.prepare("UPDATE identity_profiles SET synced_at='now',source_provider='test-idp',source_issuer='issuer',source_subject='subject' WHERE user_id='viewer-a'").run()
  expect(await member()).toMatchObject({ display_name: 'Synced Person' })
  await env.DB.prepare("UPDATE identities SET subject='replacement' WHERE user_id='viewer-a' AND provider='test-idp'").run()
  expect(await member()).toMatchObject({ display_name: 'viewer-a' })
})
