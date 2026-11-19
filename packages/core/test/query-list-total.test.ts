import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { KernelRegistry } from '../src/kernel/registry'
import type { WorkbasePlugin } from '../src/kernel/plugin'
import type { Scope } from '../src/types'
import { executeQuery } from '../src/query/executor'
import { validateQuery } from '../src/query/schema'
import { compileListTotal, compileRoot } from '../src/query/compiler'
import { resolveActor, requireScope } from '../src/authorization'
import { setup, insertDomain, runtime } from '@workbasehq/test-support/helpers'

const budget = vi.hoisted(() => ({ sqlLength: 64_000 }))
vi.mock('../src/query/limits', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/query/limits')>()
  return { ...actual, QUERY_LIMITS: { ...actual.QUERY_LIMITS, get sqlLength() { return budget.sqlLength } } }
})
let scope: Scope
const policy: WorkbasePlugin = { name: 'list_policy', version: '1', tableFilter(entity, current) {
  return entity === 'jobs' && current.actor.id === 'viewer-a'
    ? { kind: 'where', predicate: { priority: { eq: 'high' } } } : { kind: 'all' }
} }
const kernel = new KernelRegistry(sample, { plugins: [...sample.plugins!, policy] })
const run = (input: object, current = scope, k = kernel, db = env.DB) => executeQuery(k, current, db, 'synthetic-list-total-secret', input, { writeLog() {} })
const base = { entity: 'jobs', select: ['id'], limit: 2, includeTotal: true }
const fixture = Array.from({ length: 16 }, (_, i) => ({
  id: `page-${String(i).padStart(2, '0')}`, title: i & 1 ? 'Match' : 'Other',
  client: i & 2 ? 'client-org-a' : 'client-other', priority: i & 4 ? 'high' : 'low', status: i & 8 ? 'done' : 'draft',
}))
beforeEach(async () => {
  budget.sqlLength = 64_000
  await setup(sample); await insertDomain(); await insertDomain('org-b')
  scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  await env.DB.prepare('DELETE FROM slots').run(); await env.DB.prepare('DELETE FROM jobs WHERE organization_id=?').bind('org-a').run()
  await env.DB.prepare("INSERT INTO clients(id,organization_id,name,created_at,updated_at) VALUES ('client-other','org-a','Other',datetime('now'),datetime('now'))").run()
  await env.DB.batch(fixture.map(row => env.DB.prepare("INSERT INTO jobs(id,organization_id,title,client_id,priority,status,created_at,updated_at) VALUES (?,'org-a',?,?,?,?,datetime('now'),datetime('now'))").bind(row.id, row.title, row.client, row.priority, row.status)))
})

const conditionMasks = Array.from({ length: 16 }, (_, mask) => mask)
async function totalCase(mask: number) {
  const current = mask & 4 ? await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-viewer-a' } }), runtime(), kernel.config), 'org-a', kernel.config) : scope
  const input = { ...base,
    ...(mask & 1 ? { search: { text: 'match', fields: ['title'] } } : {}),
    ...(mask & 2 ? { labelWhere: { client_id: { contains: 'Client' } } } : {}),
    ...(mask & 8 ? { where: { status: { eq: 'done' } } } : {}),
  }
  const expected = fixture.filter(row => (!(mask & 1) || row.title === 'Match') && (!(mask & 2) || row.client === 'client-org-a') && (!(mask & 4) || row.priority === 'high') && (!(mask & 8) || row.status === 'done')).map(row => row.id)
  return { current, input, expected }
}

// Every subset of the four conditions, including each alone and all together.
// Cursor requests isolate total-value evidence from acceptance of offset paging.
it.each(conditionMasks)('exact authorized total equals all cursor pages, condition mask %i', async mask => {
  const { current, input, expected } = await totalCase(mask)
  const seen: string[] = []; let cursor: string | undefined
  do {
    const page = await run({ ...input, ...(cursor ? { cursor } : {}) }, current)
    expect(page.data.map(row => row.id)).toEqual(expected.slice(seen.length, seen.length + base.limit))
    expect(page.total).toBe(expected.length)
    seen.push(...page.data.map(row => row.id)); cursor = page.next_cursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(expected)
})
it.each(conditionMasks)('exact authorized total equals all offset pages, condition mask %i', async mask => {
  const { current, input, expected } = await totalCase(mask)
  const seen: string[] = []
  for (let offset = 0; offset <= expected.length; offset += base.limit) {
    const page = await run({ ...input, offset }, current)
    expect(page).toMatchObject({ total: expected.length, offset, limit: base.limit })
    seen.push(...page.data.map(row => row.id))
  }
  expect(seen).toEqual(expected)
})
it.each(['asc', 'desc'] as const)('keeps duplicate sort keys stable across pages (%s)', async dir => {
  const expected = [...fixture].sort((a, b) => (dir === 'asc' ? 1 : -1) * a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).map(row => row.id)
  const seen: string[] = []
  for (let offset = 0; offset < fixture.length; offset += 3) {
    const page = await run({ ...base, limit: 3, offset, orderBy: [{ field: 'title', dir }] })
    expect(page.total).toBe(fixture.length); seen.push(...page.data.map(row => row.id))
  }
  expect(seen).toEqual(expected)
})
it('counts the whole source beyond the last page and for no matches', async () => {
  expect(await run({ ...base, offset: 100 })).toMatchObject({ data: [], total: 16 })
  expect(await run({ ...base, offset: 0, search: { text: 'absent', fields: ['title'] } })).toMatchObject({ data: [], total: 0 })
})
it('keeps cursor callers working, with total independent of cursor position', async () => {
  const seen: string[] = []; let cursor: string | undefined
  do {
    const page = await run({ ...base, ...(cursor ? { cursor } : {}) })
    expect(page.total).toBe(16); seen.push(...page.data.map(row => row.id)); cursor = page.next_cursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(fixture.map(row => row.id))
})
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2'])('rejects invalid offset %s', async offset => {
  await expect(run({ ...base, offset })).rejects.toMatchObject({ code: 'query_invalid' })
})
it('rejects mixed cursor and offset paging', async () => {
  const page = await run(base)
  await expect(run({ ...base, offset: 0, cursor: page.next_cursor })).rejects.toMatchObject({ code: 'query_invalid' })
})
it('does not execute a count for unreadable scope or forbidden policy', async () => {
  for (const denial of ['permission', 'field', 'policy', 'empty_policy'] as const) {
    const plugin: WorkbasePlugin = { name: 'deny_list', version: '1',
      ...(denial === 'permission' ? { commandGuard: () => ({ allow: false as const, code: 'permission_denied' }) } : denial === 'field' ? { fieldMask: () => [] } : { tableFilter: () => ({ kind: 'none' as const, ...(denial === 'policy' ? { deny: 'forbidden' as const } : {}) }) }),
    }
    const current = new KernelRegistry(sample, { plugins: [...sample.plugins!, plugin] })
    const prepare = vi.fn((sql: string) => env.DB.prepare(sql))
    const db = new Proxy(env.DB, { get(target, key) { return key === 'prepare' ? prepare : typeof target[key as keyof D1Database] === 'function' ? (target[key as keyof D1Database] as Function).bind(target) : Reflect.get(target, key) } })
    const result = await run({ ...base, offset: 0 }, scope, current, db).catch(error => error)
    if (denial === 'empty_policy') expect(result).toMatchObject({ data: [], total: 0 })
    else expect(result).toMatchObject({ code: ['permission', 'field'].includes(denial) ? 'field_forbidden' : 'policy_violation' })
    expect(prepare.mock.calls.some(([sql]) => /COUNT\(/i.test(sql))).toBe(false)
  }
})
it('renders COUNT(id) over the wrapped filtered source through statement budgets', () => {
  const { query, cost } = validateQuery(kernel, scope, { ...base, offset: 0, search: { text: 'Match', fields: ['title'] }, labelWhere: { client_id: { contains: 'Client' } } })
  expect(cost.statements).toBe(2)
  const statement = compileListTotal(kernel, scope, query, cost)
  expect(statement.sql).toMatch(/COUNT\(/i); expect(statement.sql).not.toMatch(/SUM\(|LIMIT|ORDER BY/i)
  expect(statement.bindings).toContain('match'); expect(statement.bindings).toContain('client'); expect(statement.bindings).toContain('org-a')
})

it('applies the statement SQL budget to the wrapped count itself', () => {
  const { query, cost } = validateQuery(kernel, scope, { ...base, offset: 0 })
  const root = compileRoot(kernel, scope, query, undefined, cost)
  const count = compileListTotal(kernel, scope, query, cost)
  expect(count.sql.length).toBeGreaterThan(root.sql.length)
  budget.sqlLength = root.sql.length
  try {
    expect(() => compileRoot(kernel, scope, query, undefined, cost)).not.toThrow()
    expect(() => compileListTotal(kernel, scope, query, cost)).toThrowError(expect.objectContaining({ code: 'query_too_expensive' }))
  } finally { budget.sqlLength = 64_000 }
})
it('keeps total opt-in and returns offset metadata without a count', async () => {
  const prepare = vi.fn((sql: string) => env.DB.prepare(sql))
  const db = new Proxy(env.DB, { get(target, key) { return key === 'prepare' ? prepare : typeof target[key as keyof D1Database] === 'function' ? (target[key as keyof D1Database] as Function).bind(target) : Reflect.get(target, key) } })
  const result = await run({ ...base, offset: 2, includeTotal: false }, scope, kernel, db)
  expect(result).toEqual({ data: [{ id: 'page-02' }, { id: 'page-03' }], offset: 2, limit: 2, next_cursor: null })
  expect(prepare).toHaveBeenCalledTimes(1)
})
