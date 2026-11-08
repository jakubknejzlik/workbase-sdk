import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { setup, request, json } from '@workbasehq/test-support/helpers'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
it('projects only authorized issuer display metadata, real dates and configured access', async () => {
  await env.DB.prepare('UPDATE "user" SET name=? WHERE id=?').bind('Ada Issuer', 'owner-a').run()
  const issued = await json(await request(app, '/orgs/org-a/tokens', 'POST', { name: 'Reporting', role: 'viewer', operations: [], expires_at: new Date(Date.now() + 86400000).toISOString() }))
  const response = await request(app, '/orgs/org-a/tokens')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const { data } = await json(response)
  expect(data).toHaveLength(1)
  expect(data[0]).toMatchObject({ id: issued.id, issuer: { display_name: 'Ada Issuer' }, issuer_active: true, role: 'viewer', operations: [], last_used_at: null, revoked_at: null, expires_at: issued.expires_at })
  expect(Object.keys(data[0].issuer)).toEqual(['display_name'])
  expect(Date.parse(data[0].created_at)).toBeGreaterThan(Date.now() - 10000)
  const encoded = JSON.stringify(data)
  for (const forbidden of [issued.token, 'owner.a@example.test', 'issuer_id', 'issuer_email', 'token_hash']) expect(encoded).not.toContain(forbidden)
  expect((await request(app, '/orgs/org-a/tokens/' + issued.id, 'DELETE')).status).toBe(204)
  expect((await json(await request(app, '/orgs/org-a/tokens'))).data[0].revoked_at).toBeTruthy()
})
it('keeps removed-issuer history and returns explicit unavailable identity without guessing', async () => {
  await request(app, '/orgs/org-a/tokens', 'POST', { name: 'Historical', role: 'viewer' })
  await env.DB.prepare("INSERT INTO memberships VALUES ('owner-b','org-a','owner')").run()
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='owner-a' AND organization_id='org-a'").run()
  const row = (await json(await request(app, '/orgs/org-a/tokens', 'GET', undefined, 'owner-b'))).data[0]
  expect(row).toMatchObject({ issuer_active: false, issuer: { display_name: 'owner-a' } })
  await env.DB.prepare("UPDATE users SET email='' WHERE id='owner-a'").run()
  await env.DB.prepare("UPDATE \"user\" SET name='' WHERE id='owner-a'").run()
  expect((await json(await request(app, '/orgs/org-a/tokens', 'GET', undefined, 'owner-b'))).data[0]).toMatchObject({ issuer: null, issuer_active: false })
})
it.each(['viewer-a', 'dispatcher-a', 'owner-b'])('unauthorized %s gets no issuer email, id, display name or token metadata', async actor => {
  await request(app, '/orgs/org-a/tokens', 'POST', { name: 'Private token', role: 'viewer' })
  const response = await request(app, '/orgs/org-a/tokens', 'GET', undefined, actor)
  expect(response.status).toBe(403)
  const data = await json(response)
  expect(Object.keys(data)).toEqual(['error'])
  for (const privateValue of ['owner.a@example.test', 'owner-a', 'issuer', 'Private token']) expect(JSON.stringify(data)).not.toContain(privateValue)
})

it.each(['owner-a', 'viewer-a', 'dispatcher-a'])('token write capabilities agree with endpoint authority for %s', async actor => {
  const document = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, actor))
  const issued = await request(app, '/orgs/org-a/tokens', 'POST', { name: 'Capability check', role: 'viewer' }, actor)
  expect(document.resources['tokens.create']).toBe(issued.status === 201)
  const target = await json(await request(app, '/orgs/org-a/tokens', 'POST', { name: 'Revoke check', role: 'viewer' }))
  const revoked = await request(app, '/orgs/org-a/tokens/' + target.id, 'DELETE', undefined, actor)
  expect(document.resources['tokens.revoke']).toBe(revoked.status === 204)
})
