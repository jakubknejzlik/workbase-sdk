import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { actionFixture } from './fixtures/record-actions'
import { recordActionApp } from './fixtures/record-actions-app'
import { recordActionSecurityTests } from './fixtures/record-actions-security'

async function setup(selected = actionFixture()) {
  await reset()
  return recordActionApp(env.DB, selected, env.AUDIT_KV)
}
function request(path: string, role = 'staff', method = 'GET', body?: object) {
  return new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer synthetic-${role}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
beforeEach(async () => { await reset() })
it('one detail GET includes SQL availability independent of projection and preserves version and masks', async () => {
  const app = await setup()
  const response = await app.fetch(request('/api/record/open?fields=id,version'))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id: 'open', state: 'open', version: 1, actions: { close: { enabled: true }, ordered: { enabled: true }, touch: { enabled: true } } })
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

it.each(['admin', 'staff', 'viewer'])('D1 availability/dispatch matrix agrees for role %s × state × action', async role => {
  const app = await setup()
  for (const id of ['open', 'closed', 'locked', 'null']) for (const name of ['close', 'secret', 'ordered', 'touch']) {
    const initial = id === 'null' ? null : id
    await env.DB.prepare('UPDATE record SET state=? WHERE id=?').bind(initial, id).run()
    const row = await (await app.fetch(request(`/api/record/${id}`, role))).json() as any
    const response = await app.fetch(request(`/api/record/${id}/actions/${name}`, role, 'POST', {}))
    expect(response.ok, `${role}/${id}/${name}`).toBe(row.actions[name]?.enabled === true)
    if (row.actions[name]?.enabled === false) {
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'action_unavailable', reason: row.actions[name].reason })
    }
    if (role === 'viewer') expect(response.status).toBe(403)
    else if (!row.actions[name]) expect(response.status).toBe(404)
  }
})
it('D1 race rejects state changed since GET with zero row writes and no audit event', async () => {
  const app = await setup()
  expect(await (await app.fetch(request('/api/record/open'))).json()).toMatchObject({ actions: { close: { enabled: true } } })
  await env.DB.exec("UPDATE record SET state='closed' WHERE id='open'")
  const before = await env.DB.prepare("SELECT * FROM record WHERE id='open'").first()
  const audit = await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')
  const response = await app.fetch(request('/api/record/open/actions/close', 'staff', 'POST', {}))
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'action_unavailable', reason: 'record.closed' })
  expect(await env.DB.prepare("SELECT * FROM record WHERE id='open'").first()).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(audit)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM atomic_assert').first('n')).toBe(0)
})
it('D1 oracle: GET and dispatch status/body bytes agree for missing, cross-org, filtered and masked actions', async () => {
  const app = await setup()
  for (const id of ['nonexistent', 'foreign', 'filtered']) {
    const get = await app.fetch(request(`/api/record/${id}`))
    const bytes = await get.text()
    for (const name of ['close', 'secret', 'ordered', 'touch', 'unknown', 'constructor']) {
      const response = await app.fetch(request(`/api/record/${id}/actions/${name}`, 'staff', 'POST', {}))
      expect(response.status).toBe(get.status)
      expect(await response.text()).toBe(bytes)
    }
  }
  const get = await app.fetch(request('/api/record/open'))
  expect((await get.json() as any).actions).not.toHaveProperty('secret')
  const response = await app.fetch(request('/api/record/open/actions/secret', 'staff', 'POST', {}))
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('{"error":"not_found"}')
})
it('dispatcher accepts only empty JSON and passes the route id to the existing command', async () => {
  const app = await setup()
  const invalid = await app.fetch(request('/api/record/open/actions/close', 'admin', 'POST', { id: 'foreign' }))
  expect(invalid.status).toBe(400)
  const response = await app.fetch(request('/api/record/open/actions/close', 'admin', 'POST', {}))
  expect(response.status).toBe(200)
  expect(await env.DB.prepare("SELECT state,version FROM record WHERE id='open'").first()).toEqual({ state: 'closed', version: 2 })
  expect(await env.DB.prepare("SELECT state FROM record WHERE id='foreign'").first('state')).toBe('open')
  expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_outbox WHERE json_extract(payload,'$.operation')='record.closed'").first('n')).toBe(1)
})

it('D1 guard runs after prepare, before all command writes, and rechecks the read filter', async () => {
  const { closeRecord } = await import('./fixtures/record-actions')
  const command = { ...closeRecord, prepare: async () => {
    await env.DB.exec("UPDATE record SET user='admin' WHERE id='open'")
    return undefined
  } }
  const app = await setup(actionFixture(undefined, [command]))
  expect(await (await app.fetch(request('/api/record/open'))).json()).toMatchObject({ actions: { close: { enabled: true } } })
  const response = await app.fetch(request('/api/record/open/actions/close', 'staff', 'POST', {}))
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('{"error":"not_found"}')
  expect(await env.DB.prepare("SELECT state,version FROM record WHERE id='open'").first()).toEqual({ state: 'open', version: 1 })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(0)
})

recordActionSecurityTests(async config => ({ app: await setup(config), db: env.DB }))
