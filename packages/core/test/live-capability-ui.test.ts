import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { workerAccessFixture } from './fixtures/worker-access'
import { createApp } from '../src/app'
import { sha256 } from '../src/crypto'
let app: ReturnType<typeof createApp>
function request(path: string, role = 'admin', method = 'GET', body?: object) {
  return app.fetch(new Request('http://localhost' + path, { method, headers: { Authorization: 'Bearer ui-' + role, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'If-Match': '1', 'Idempotency-Key': 'ui-probe' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}
beforeEach(async () => {
  await reset()
  const config = workerAccessFixture()
  await bootstrap(env.DB, config)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')")
  for (const role of ['admin', 'staff']) {
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(role, role + '@example.test', 'x', 'x', 'org-a', role, role, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, role + '@example.test', 'now', 'now').run()
    await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(role, role).run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256('ui-' + role), role, '2099-01-01T00:00:00.000Z').run()
  }
  for (const id of ['own', 'other', 'foreign']) await env.DB.prepare('INSERT INTO worker (id,organization_id,name,user,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, id === 'foreign' ? 'org-b' : 'org-a', id, id === 'own' ? 'staff' : null, 'now', 'now').run()
  app = createApp(config, { DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-ui-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-access-secret-at-least-32', localPassword: true } })
})
it('capabilities are live and no-store; direct forged staff writes fail independently of the UI', async () => {
  const response = await request('/o/org-a/capabilities', 'staff')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const caps = await response.json() as any
  expect(caps.entities.worker.operations).toEqual(['read']); expect(caps.entities.worker.writable).toEqual(['name']) // Field writability is separate from operation permission.
  expect(caps.resources['members.read']).toBe(false)
  expect((await request('/api/worker/own', 'staff')).status).toBe(200)
  for (const id of ['other', 'foreign', 'missing']) {
    const response = await request('/api/worker/' + id, 'staff')
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' })
  }
  expect((await request('/api/worker', 'staff', 'POST', { name: 'Forged' })).status).toBe(403)
  expect((await request('/api/worker/own', 'staff', 'PATCH', { name: 'Forged' })).status).toBe(403)
  for (const name of ['invite', 'cancel_invite', 'link_account', 'unlink_account']) expect((await request('/api/worker/own/actions/' + name, 'staff', 'POST', name === 'invite' ? { email: 'fake@example.test' } : name === 'link_account' ? { user_id: 'admin' } : {})).status).toBe(403)
  const protectedWrite = await request('/api/worker/own', 'admin', 'PATCH', { user: null })
  expect(protectedWrite.status).toBe(400); expect(await protectedWrite.json()).toEqual({ error: 'protected_field' })
  expect(await env.DB.prepare("SELECT name FROM worker WHERE id='own'").first('name')).toBe('own')
})
it('demoting the same session denies its next save and projects only staff authority', async () => {
  expect((await request('/api/worker/other')).status).toBe(200)
  await env.DB.exec("UPDATE memberships SET role='staff' WHERE user_id='admin'")
  expect((await request('/api/worker/other', 'admin', 'PATCH', { name: 'Stale admin' })).status).toBe(403)
  const caps = await (await request('/o/org-a/capabilities')).json() as any
  expect(caps.organization.role).toBe('staff'); expect(caps.entities.worker.operations).toEqual(['read'])
  expect(caps.resources['members.read']).toBe(false)
  const query = await request('/query', 'admin', 'POST', { entity: 'worker', select: ['id', 'name'], limit: 25 })
  expect(await query.json()).toMatchObject({ data: [] })
})
