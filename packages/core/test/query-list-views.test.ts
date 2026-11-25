import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { consoleUI } from '@workbasehq/plugins/console'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { workerAccessFixture } from './fixtures/worker-access'
import { schemaLock } from '../src/migrations/schema-lock'
import { bindSchemaLock, defineAccess, defineConfig, defineEntity, accountLink, accessEntities, accessSystemActions } from '../src/schema'
import { KernelRegistry } from '../src/kernel/registry'
import type { Scope } from '../src/types'
import { executeQuery, type QueryResult } from '../src/query/executor'
import { fieldsFor, validateQuery } from '../src/query/schema'
import { resolveActor, requireScope } from '../src/authorization'
import { sha256 } from '../src/crypto'
import { createApp } from '../src/app'
import { consoleModel } from '../src/console-model'

const budget = vi.hoisted(() => ({ statements: 16, exists: 16 }))
vi.mock('../src/query/limits', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/query/limits')>()
  return { ...actual, QUERY_LIMITS: { ...actual.QUERY_LIMITS, get statements() { return budget.statements }, get exists() { return budget.exists } } }
})
const states = ['no_account', 'invited', 'expired', 'signed_in'] as const
const views = [
  { id: 'all', label: 'All', where: {} },
  { id: 'done', label: 'Done', where: { name: { contains: 'done' } } },
  ...(['invited', 'expired'] as const).map(state => ({ id: state, label: state, where: {}, rowAccess: state })),
  { id: 'invited_done', label: 'Invited done', where: { name: { contains: 'done' } }, rowAccess: 'invited' as const },
  { id: 'private', label: 'Private', where: { user: { eq: 'member' } } },
]
const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
const config = defineConfig({ id: 'list_views', roles: ['owner', 'member'], organizationOwnerRole: 'owner', languages: ['en'], interactive: false,
  plugins: workerAccessFixture().plugins,
  entities: { worker: defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() },
    access: { owner: all, member: { read: { where: { user: { eq: '$actor.id' } } }, create: 'deny', update: 'deny', delete: 'deny' } },
  }) },
  access: defineAccess({ accountLinks: { worker: { invitationRole: 'member' } }, predicates: {},
    roles: Object.fromEntries(['owner', 'member'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, role === 'owner' || action === 'invitations.accept' ? 'allow' : 'deny'])) }])),
    entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: all, member: 'deny' }])),
  }), ui: { entities: { worker: { list: { rowAccess: { placement: 'panel', column: true }, views } } } } })
bindSchemaLock(config, schemaLock(config))
const kernel = new KernelRegistry(config)
let scope: Scope
const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-access-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-access-secret-at-least-32', localPassword: true } })
const verifiedScope = async (role: string) => requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${role}` } }), runtime(), kernel.config), 'org-a', kernel.config)
const fixture = states.flatMap((state, i) => Array.from({ length: 4 }, (_, j) => ({
  id: `row-${i}-${j}`, state, name: `${j & 1 ? 'Match' : 'Other'} ${j & 2 ? 'done' : 'draft'}`,
})))
const base = { entity: 'worker', select: ['id'], limit: 2, includeTotal: true }
const run = (input: object, k = kernel, current = scope, db = env.DB): Promise<QueryResult> => executeQuery(k, current, db, 'synthetic-view-total-secret', input, { writeLog() {} })
function trackedDB() {
  const prepare = vi.fn((sql: string) => env.DB.prepare(sql))
  const db = new Proxy(env.DB, { get(target, key) { const value = Reflect.get(target, key); return key === 'prepare' ? prepare : typeof value === 'function' ? value.bind(target) : value } })
  return { db, prepare }
}
beforeEach(async () => {
  budget.statements = 16; budget.exists = 16
  await reset(); await bootstrap(env.DB, config)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')")
  for (const role of ['owner', 'member']) {
    await env.DB.prepare('INSERT INTO users(id,email,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(role, `${role}@example.test`, 'org-a', role, role, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, 'now', 'now').run()
    await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(role, role).run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${role}`), role, '2099-01-01T00:00:00.000Z').run()
  }
  scope = await verifiedScope('owner')
  await env.DB.batch(fixture.map(row => env.DB.prepare('INSERT INTO worker(id,organization_id,name,user,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(row.id, 'org-a', row.name, row.state === 'signed_in' ? 'member' : null, 'now', 'now')))
  for (const row of fixture.filter(row => ['invited', 'expired'].includes(row.state))) await env.DB.prepare('INSERT INTO invitations(id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,target_entity,target_row) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(`inv-${row.id}`, 'org-a', `${row.id}@example.test`, 'member', `hash-${row.id}`, row.state === 'expired' ? '2000-01-01' : '2099-01-01', 'owner', 'now', 'worker', row.id).run()
  await env.DB.exec("INSERT INTO worker(id,organization_id,name,created_at,updated_at) VALUES ('foreign','org-b','Match done','now','now')")
})
async function reachable(input: object, expected: string[], k = kernel, current = scope) {
  const seen: string[] = []
  for (let offset = 0; offset <= expected.length; offset += base.limit) {
    const page = await run({ ...base, ...input, offset }, k, current)
    expect(page.total).toBe(expected.length); seen.push(...page.data.map(row => row.id))
  }
  expect(seen).toEqual(expected)
}
it.each(Array.from({ length: 16 }, (_, mask) => mask))('list/view access + search/user filters share rows and total, mask %i', async mask => {
  const input = { ...(mask & 1 ? { rowAccess: 'invited' } : {}), ...(mask & 2 ? { view: 'invited_done' } : { view: 'all' }),
    ...(mask & 4 ? { search: { text: 'match', fields: ['name'] } } : {}), ...(mask & 8 ? { where: { id: { ne: 'row-1-3' } } } : {}) }
  const expected = fixture.filter(row => (!(mask & 3) || row.state === 'invited') && (!(mask & 2) || row.name.includes('done')) && (!(mask & 4) || row.name.includes('Match')) && (!(mask & 8) || row.id !== 'row-1-3')).map(row => row.id)
  await reachable(input, expected)
})
it('ANDs contradictory access conditions instead of allowing the view to replace the manual filter', async () => {
  await reachable({ rowAccess: 'expired', view: 'invited' }, [])
})
it('each tab count matches selecting that tab with all other confirmed conditions', async () => {
  const input = { ...base, view: 'invited_done', includeViewTotals: true, search: { text: 'match', fields: ['name'] }, where: { id: { ne: 'row-1-3' } } }
  const page = await run(input)
  expect(page).toHaveProperty('viewTotals')
  const totals = (page as QueryResult & { viewTotals: Record<string, number> }).viewTotals
  expect(Object.keys(totals)).toEqual(views.map(view => view.id))
  for (const view of views) {
    const expected = fixture.filter(row => row.name.includes('Match') && row.id !== 'row-1-3' && (!view.rowAccess || row.state === view.rowAccess) && (view.id !== 'done' && view.id !== 'invited_done' || row.name.includes('done')) && (view.id !== 'private' || row.state === 'signed_in')).map(row => row.id)
    await reachable({ ...input, includeViewTotals: false, view: view.id }, expected)
    expect(totals[view.id]).toBe(expected.length)
  }
})
it('keeps manual access for every tab and cursor totals independent of the selected tab and page', async () => {
  const input = { ...base, view: 'all', rowAccess: 'invited', includeViewTotals: true }
  const current = new KernelRegistry({ ...config, ui: { entities: { worker: { list: { views: views.filter(view => ['all', 'done', 'invited'].includes(view.id)) } } } } })
  const first = await run(input, current)
  const second = await run({ ...input, cursor: first.next_cursor }, current)
  expect(first.total).toBe(4); expect(second.total).toBe(4)
  expect(first).toHaveProperty('viewTotals', { all: 4, done: 2, invited: 4 })
  expect(second).toHaveProperty('viewTotals', (first as any).viewTotals)
})
it('drops counts for views removed by projection, rather than returning zero', async () => {
  const current = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'hide_view', version: '1', fieldMask: entity => entity === 'worker' ? ['id', 'name'] : fieldsFor(config, entity) }] })
  const projected = consoleModel(current, scope).model.entities.worker.list!.views!.map(view => view.id)
  const { db, prepare } = trackedDB()
  const page = await run({ ...base, includeViewTotals: true }, current, scope, db)
  expect(projected).not.toContain('private')
  expect(Object.keys((page as any).viewTotals)).toEqual(projected)
  expect((page as any).viewTotals).not.toHaveProperty('private')
  expect(prepare.mock.calls.filter(([sql]) => /COUNT\(/i.test(sql))).toHaveLength(1 + projected.length)
  prepare.mockClear()
  await expect(run({ ...base, view: 'private', includeViewTotals: true }, current, scope, db)).rejects.toMatchObject({ code: 'query_invalid' })
  expect(prepare).not.toHaveBeenCalled()
})
it('cannot infer access states by requesting counts without invitation authority', async () => {
  const restricted = { ...config, effectiveAccess: { ...config.effectiveAccess!, system: config.effectiveAccess!.system.map(rule => rule.role === 'owner' && rule.action === 'invitations.read' ? { ...rule, decision: 'deny' as const } : rule) } }
  const current = new KernelRegistry(restricted)
  const page = await run({ ...base, includeViewTotals: true }, current)
  expect(page).toHaveProperty('viewTotals', { all: 16, done: 8, private: 4 })
  const { db, prepare } = trackedDB()
  for (const input of [{ rowAccess: 'invited' }, { view: 'invited' }]) await expect(run({ ...base, ...input, includeViewTotals: true }, current, scope, db)).rejects.toBeDefined()
  expect(prepare).not.toHaveBeenCalled()
})
it('counts only actor-policy rows and never executes counts for unreadable scopes', async () => {
  const member = await verifiedScope('member')
  const page = await run({ ...base, includeViewTotals: true }, kernel, member)
  expect(page).toMatchObject({ total: 4, viewTotals: { all: 4, done: 2 } })
  expect((page as any).viewTotals).not.toHaveProperty('invited')
  const { db, prepare } = trackedDB()
  const denied = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'deny_views', version: '1', tableFilter: () => ({ kind: 'none' as const }) }] })
  expect(await run({ ...base, includeViewTotals: true }, denied, scope, db)).toMatchObject({ data: [], total: 0, viewTotals: {} })
  expect(prepare.mock.calls.some(([sql]) => /COUNT\(/i.test(sql))).toBe(false)
})
it('charges view statements before SQL and enforces the exact cap', async () => {
  const input = { ...base, includeViewTotals: true }
  const { db, prepare } = trackedDB()
  budget.statements = 7
  await expect(run(input, kernel, scope, db)).rejects.toMatchObject({ code: 'query_too_expensive', cost: { statements: 8 } })
  expect(prepare).not.toHaveBeenCalled()
  budget.statements = 8
  expect(validateQuery(kernel, scope, input).cost.statements).toBe(8)
  await run(input, kernel, scope, db)
  expect(prepare).toHaveBeenCalledTimes(8)
})
it('rejects an unknown view without preparing SQL and keeps tab counts opt-in', async () => {
  const { db, prepare } = trackedDB()
  await expect(run({ ...base, view: 'unknown' }, kernel, scope, db)).rejects.toMatchObject({ code: 'query_invalid' })
  expect(prepare).not.toHaveBeenCalled()
  expect(await run({ ...base, view: 'all' })).not.toHaveProperty('viewTotals')
})
it.each(states)('list access filter alone keeps exact totals for %s', async rowAccess => {
  await reachable({ rowAccess }, fixture.filter(row => row.state === rowAccess).map(row => row.id))
})
it('retains labelWhere and search in every view count', async () => {
  const input = { ...base, view: 'done', includeViewTotals: true, labelWhere: { user: { contains: 'member' } }, search: { text: 'match', fields: ['name'] } }
  const page = await run(input)
  expect(page).toMatchObject({ total: 1, viewTotals: { all: 2, done: 1, invited: 0, expired: 0, invited_done: 0, private: 2 } })
  for (const view of views) {
    const selected = await run({ ...input, view: view.id, includeViewTotals: false })
    expect(page.viewTotals![view.id]).toBe(selected.total)
  }
})
it('uses normalized plugin views and synthesizes the unfiltered all tab', async () => {
  const current = new KernelRegistry(config, { plugins: [...config.plugins!, consoleUI(), { name: 'plugin_list', version: '1', requires: { console: '^1' }, contributes: { console: { entities: { worker: { list: { views: [{ id: 'waiting', label: 'Waiting', rowAccess: 'invited' }] } } } } } }] })
  const page = await run({ ...base, view: 'waiting', includeViewTotals: true }, current)
  expect(page).toMatchObject({ total: 4, viewTotals: { all: 16, waiting: 4 } })
  expect(Object.keys(page.viewTotals!)).toEqual(['all', 'waiting'])
  await reachable({ view: 'waiting' }, fixture.filter(row => row.state === 'invited').map(row => row.id), current)
})
it('charges all view source work against the request existence budget', async () => {
  const input = { ...base, includeViewTotals: true }
  const { cost } = validateQuery(kernel, scope, input)
  const { db, prepare } = trackedDB()
  budget.exists = cost.exists - 1
  await expect(run(input, kernel, scope, db)).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(prepare).not.toHaveBeenCalled()
})
it('can request only tab counts without the main total', async () => {
  const { db, prepare } = trackedDB()
  const page = await run({ ...base, includeTotal: false, includeViewTotals: true }, kernel, scope, db)
  expect(page).not.toHaveProperty('total')
  expect(page.viewTotals).toMatchObject({ all: 16, invited: 4 })
  expect(prepare.mock.calls.filter(([sql]) => /COUNT\(/i.test(sql))).toHaveLength(views.length)
})

// The role names and rows are synthetic; read-only status access needs no member role.
it.each(['ordinary', 'create-denied', 'invite-create-denied'] as const)('admin/staff-only HTTP read parity: %s', async denial => {
  const source = workerAccessFixture()
  source.plugins = [...source.plugins!, consoleUI(), { name: 'readable-fields', version: '1', fieldMask: entity => entity === 'worker' ? ['id', 'name'] : fieldsFor(source, entity) }]
  source.effectiveAccess = { ...source.effectiveAccess!,
    entities: source.effectiveAccess!.entities.map(rule => denial === 'create-denied' && rule.role === 'admin' && rule.entity === 'worker' && rule.operation === 'create' ? { ...rule, decision: 'deny' } : rule),
    system: source.effectiveAccess!.system.map(rule => denial === 'invite-create-denied' && rule.role === 'admin' && rule.action === 'invitations.create' ? { ...rule, decision: 'deny' } : rule),
  }
  const list = { rowAccess: { placement: 'panel' as const }, views: [
    { id: 'all', label: 'All', where: {} }, { id: 'linked', label: 'Linked', where: {}, rowAccess: 'signed_in' as const },
    { id: 'hidden', label: 'Hidden', where: { or: [{ name: { eq: 'Other draft' } }, { user: { eq: 'staff' } }] } },
  ] }
  source.ui = { entities: { worker: { list } }, navigation: { groups: [], items: [{ id: 'linked', entity: 'worker', view: 'linked' }, { id: 'hidden', entity: 'worker', view: 'hidden' }] } }
  // Exercise plugin precedence and whole-predicate pruning as well as model hints.
  source.plugins = [...source.plugins, { name: 'read-views', version: '1', requires: { console: '^1' }, contributes: { console: { entities: { worker: { list } }, navigation: [{ id: 'plugin.linked', entity: 'worker', view: 'linked', placement: 'sidebar', label: 'Linked' }, { id: 'plugin.hidden', entity: 'worker', view: 'hidden', placement: 'sidebar', label: 'Hidden' }] } } }]
  expect(source.roles).toEqual(['admin', 'staff'])
  for (const role of ['admin', 'staff']) {
    await env.DB.prepare('INSERT INTO users(id,email,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(role, `${role}@example.test`, 'org-a', role, role, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, 'now', 'now').run()
    await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(role, role).run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`read-${role}`), role, '2099-01-01T00:00:00.000Z').run()
  }
  await env.DB.exec("UPDATE worker SET user='staff' WHERE id='row-3-0'")
  const app = createApp(source, runtime())
  const request = (path: string, role: string, body?: object) => app.request(`http://localhost${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer read-${role}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  for (const role of ['admin', 'staff']) {
    const response = await request('/o/org-a/console-model', role)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    if (role === 'admin') {
      expect(body.capabilities.entities.worker.operations.includes('create')).toBe(denial !== 'create-denied')
      expect(body.capabilities.resources['invitations.create']).toBe(denial !== 'invite-create-denied')
    }
    expect(body.model.entities.worker.rowAccess).toBe(role === 'admin')
    expect(body.model.entities.worker.rowInvitations).not.toBe(true)
    expect(body.model.entities.worker.list.views.map((view: any) => view.id)).toEqual(role === 'admin' ? ['all', 'linked'] : ['all'])
    for (const navigation of [body.model.ui.navigation.items, body.console.modelUi.navigation.items, body.console.navigation]) {
      expect(navigation.some((item: any) => item.view === 'linked')).toBe(role === 'admin')
      expect(navigation.some((item: any) => item.view === 'hidden')).toBe(false)
    }
    const query = { entity: 'worker', select: ['id'], limit: 100, includeTotal: true, includeViewTotals: true }
    const plain = await request('/query', role, query)
    expect(plain.status).toBe(200)
    const rows = await plain.json() as any
    expect(rows.total).toBe(role === 'admin' ? 16 : 1)
    expect(Object.keys(rows.viewTotals)).toEqual(role === 'admin' ? ['all', 'linked'] : ['all'])
    if (role === 'staff') expect(rows.data.map((row: any) => row.id)).toEqual(['row-3-0'])
    for (const filter of [{ rowAccess: 'signed_in' }, { view: 'linked' }]) {
      const result = await request('/query', role, { ...query, ...filter })
      expect(result.status).toBe(role === 'admin' ? 200 : 'rowAccess' in filter ? 403 : 400)
      if (role === 'admin') {
        const page = await result.json() as any
        expect(page.total).toBe(4)
        expect(page.data.map((row: any) => row.id)).toEqual(fixture.filter(row => row.state === 'signed_in').map(row => row.id))
      }
    }
    expect((await request('/query', role, { ...query, view: 'hidden' })).status).toBe(400)
  }
})
