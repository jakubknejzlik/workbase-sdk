import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { completeInvitationProfiles, runtime, setup } from '@workbasehq/test-support/helpers'
import { createClient, diff, type EntityMeta } from '../../plugins/console/ui/src/client'
import { createApp } from '../src/app'
import { defineInstance } from '../src/config'
import sample from './fixtures/sample/config'
const roles = ['owner', 'dispatcher', 'viewer']
const config = defineInstance({ ...sample, account: { entity: 'users' }, entities: { ...sample.entities,
  users: { fields: { name: { type: 'string' }, role: { type: 'enum', values: roles } } },
  probe: { displayField: 'name', fields: { name: { type: 'string', required: true }, extra: { type: 'string' }, locked: { type: 'string', readOnly: true }, user: { type: 'ref', entity: 'users', userLink: true } }, relations: { account: { field: 'user', entity: 'users' } } },
}, permissions: Object.fromEntries(roles.map(role => [role, { ...sample.permissions[role], users: ['read'], probe: ['read', 'create', 'update'] }])),
policies: { ...sample.policies, users: { owner: 'all', dispatcher: 'all', viewer: 'all' }, probe: { owner: 'all', dispatcher: 'all', viewer: 'all' } } })
const meta: EntityMeta = { displayField: 'name', fields: Object.fromEntries(Object.entries(config.entities.probe.fields).map(([key, f]) => [key, { type: f.type, required: f.required, readOnly: !!f.readOnly, computed: !!f.computed, userLink: !!f.userLink }])) }
let app: ReturnType<typeof createApp>, cookie: string
const signal = () => new AbortController().signal
function client() {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    return app.request('http://localhost' + url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Cookie: cookie, Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' } })
  })
  return { api: createClient({ baseURL: '', orgId: 'org-a', actorId: 'owner-a', fetch }), fetch }
}
beforeEach(async () => {
  app = await setup(config, async db => {
    await db.prepare("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')").run()
    await db.batch([
      db.prepare("INSERT INTO users (id,organization_id,name,email,role,created_at,updated_at) VALUES ('owner-a','org-a','Owner','owner.a@example.test','owner','now','now')"),
      db.prepare(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner-a','Owner','owner.a@example.test',1,'now','now')`),
      db.prepare("INSERT INTO memberships VALUES ('owner-a','org-a','owner')"),
    ])
  })
  await completeInvitationProfiles()
  await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner.a@example.test', callbackURL: '/me' }) })
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='owner.a@example.test' ORDER BY rowid DESC LIMIT 1").first<string>('body')
  const signed = await app.request(url!)
  cookie = signed.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))!.split(';')[0]
})
it('native D1: optional null clears, omitted retains, fresh Worker/client reads persisted create/edit', async () => {
  const { api, fetch } = client(), layout = ['name', 'extra', 'user', 'locked']
  const created = await api.create('probe', diff(meta, layout, {}, { name: ' A ', extra: 'set', user: 'forged', locked: 'forged' }), 'draft-1', signal())
  expect(await api.create('probe', { name: 'A', extra: 'set' }, 'draft-1', signal())).toEqual(created)
  const edited = await api.update('probe', created.id, created.version, { name: 'B' }, signal())
  expect(edited.extra).toBe('set')
  const cleared = await api.update('probe', created.id, edited.version, diff(meta, layout, edited, { ...edited, extra: '' }), signal())
  expect(cleared.extra).toBeNull()
  expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET').every(([, init]) => !Object.hasOwn(JSON.parse(String(init.body)), 'user'))).toBe(true)
  app = createApp(config, runtime())
  expect(await client().api.one('probe', { id: created.id }, signal())).toMatchObject({ name: 'B', extra: null, version: 3 })
  expect(await env.DB.prepare('SELECT extra FROM probe WHERE id=?').bind(created.id).first('extra')).toBeNull()
})
it('native D1: empty name issues have paths/codes only; forged userLink/readOnly/unknown rejected', async () => {
  const { api } = client(), created = await api.create('probe', { name: 'A' }, 'draft-2', signal())
  const failure = await api.update('probe', created.id, 1, { name: '' }, signal()).catch(e => e)
  expect(failure).toMatchObject({ status: 400, code: 'validation_error', issues: [{ path: ['name'], code: 'too_small' }] })
  expect(Object.keys(failure.issues[0]).sort()).toEqual(['code', 'path'])
  for (const body of [{ user: 'owner-a' }, { locked: 'forged' }, { unknown: 'forged' }]) await expect(api.update('probe', created.id, 1, body, signal())).rejects.toMatchObject({ status: 400 })
})
it('native D1: stale version retains cache/draft, reload then resave sends only changed keys', async () => {
  const first = client(), second = client(), initial = await first.api.create('probe', { name: 'A', extra: 'set' }, 'draft-3', signal())
  await second.api.update('probe', initial.id, 1, { name: 'Other' }, signal())
  const draft = { ...initial, name: 'Mine' }
  await expect(first.api.update('probe', initial.id, 1, diff(meta, ['name', 'extra'], initial, draft), signal())).rejects.toMatchObject({ status: 409, code: 'version_conflict' })
  expect(draft.name).toBe('Mine'); expect(await first.api.one('probe', { id: initial.id }, signal())).toEqual(initial)
  first.api.invalidate()
  const reloaded = await first.api.one('probe', { id: initial.id }, signal())
  await first.api.update('probe', initial.id, reloaded.version, diff(meta, ['name', 'extra'], reloaded, { ...reloaded, name: 'Mine' }), signal())
  expect(JSON.parse(String(first.fetch.mock.calls.at(-1)![1].body))).toEqual({ name: 'Mine' })
})
it('native D1: search and sort traverse bounded opaque forward pages and reset on change', async () => {
  await env.DB.batch(Array.from({ length: 56 }, (_, n) => env.DB.prepare("INSERT INTO probe (id,organization_id,name,created_at,updated_at) VALUES (?,'org-a',?,'now','now')").bind(`p${n}`, `${n < 53 ? 'Match' : 'Other'} ${String(n).padStart(2, '0')}`)))
  const { api, fetch } = client(), list = api.list('probe', meta), rows = []
  let page = await list.load({ search: 'Match', sort: 'name', dir: 'desc' }, signal())
  rows.push(...page.data)
  while (page.next_cursor) { page = await list.more(signal()); rows.push(...page.data) }
  expect(rows).toHaveLength(53); expect(rows.map(row => row.name)).toEqual([...rows.map(row => row.name)].sort().reverse())
  expect((await list.load({ search: 'Other', sort: 'name', dir: 'asc' }, signal())).data.map(row => row.name)).toEqual(['Other 53', 'Other 54', 'Other 55'])
  expect(fetch.mock.calls.every(([, init]) => JSON.parse(String(init.body)).limit === 25)).toBe(true)
  expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body)).cursor).toBeUndefined()
})
