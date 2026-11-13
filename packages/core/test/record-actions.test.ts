import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { actionFixture } from './fixtures/record-actions'
import { createApp } from '../src/app'
import { sha256 } from '../src/crypto'

export const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-actions-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-actions-secret-at-least-32', localPassword: true } })
export async function setup(selected = actionFixture()) {
  await reset(); await bootstrap(env.DB, selected)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')")
  for (const role of ['admin', 'staff', 'viewer']) {
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(role, `${role}@example.test`, 'x', 'x', 'org-a', role, role, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${role}`), role, new Date(Date.now() + 86400000).toISOString()).run()
  }
  for (const [id, org, state, user] of [['open', 'org-a', 'open', 'staff'], ['closed', 'org-a', 'closed', 'staff'], ['locked', 'org-a', 'locked', 'staff'], ['null', 'org-a', null, 'staff'], ['filtered', 'org-a', 'open', 'admin'], ['foreign', 'org-b', 'open', null]]) {
    await env.DB.prepare('INSERT INTO record (id,organization_id,state,secret,user,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(id, org, state, 'yes', user, 'now', 'now').run()
  }
  await env.DB.exec("INSERT INTO worker (id,organization_id,name,created_at,updated_at) VALUES ('worker','org-a','Worker','now','now')")
  return createApp(selected, runtime())
}
export function request(path: string, role = 'staff', method = 'GET', body?: object) {
  return new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer synthetic-${role}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
beforeEach(async () => { await reset() })
it('one detail GET includes SQL availability independent of projection and preserves version and masks', async () => {
  const app = await setup()
  const response = await app.fetch(request('/api/record/open?fields=id,version'))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id: 'open', state: 'open', version: 1, actions: { close: { enabled: true }, ordered: { enabled: true } } })
  const closed = await app.fetch(request('/api/record/closed'))
  expect(await closed.json()).toMatchObject({ state: 'closed', version: 1, actions: { close: { enabled: false, reason: 'record.closed' } } })
  const missing = await app.fetch(request('/api/record/null'))
  expect(await missing.json()).toMatchObject({ actions: { ordered: { enabled: false, reason: 'record.missing' } } })
  const admin = await app.fetch(request('/api/record/open', 'admin'))
  expect(await admin.json()).toMatchObject({ actions: { secret: { enabled: true } } })
})
it('worker has empty actions; list, query and mutation responses have no availability', async () => {
  const app = await setup()
  expect(await (await app.fetch(request('/api/worker/worker'))).json()).toMatchObject({ version: 1, actions: {} })
  for (const req of [request('/api/record'), request('/query', 'staff', 'POST', { entity: 'record', select: ['id', 'state'], limit: 25 })]) {
    const response = await app.fetch(req)
    expect(response.status).toBe(200)
    expect((await response.json() as any).data.every((row: any) => !Object.hasOwn(row, 'actions'))).toBe(true)
  }
  const update = request('/api/record/open', 'staff', 'PATCH', { state: 'open' }); update.headers.set('If-Match', '1')
  expect(await (await app.fetch(update)).json()).not.toHaveProperty('actions')
  expect(await (await app.fetch(request('/api/record', 'admin', 'POST', { state: 'open' }))).json()).not.toHaveProperty('actions')
})
