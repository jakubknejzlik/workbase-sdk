import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { tenancy } from '../src/kernel/adapters/tenancy'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { KernelRegistry } from '../src/kernel/registry'
import type { WorkbasePlugin, TableFilter } from '../src/kernel/plugin'
import type { Scope } from '../src/types'
import { executeQuery } from '../src/query/executor'
import { validateQuery, querySchema } from '../src/query/schema'
import { QUERY_LIMITS as L } from '../src/query/limits'
import { compileListTotal, compileRoot, listTotalReferenceCost } from '../src/query/compiler'
import { resolveActor, requireScope } from '../src/authorization'
import { setup, insertDomain, runtime } from '@workbasehq/test-support/helpers'

const budget = vi.hoisted(() => ({ sqlLength: 64_000, maxOffset: undefined as number | undefined }))
vi.mock('../src/query/limits', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/query/limits')>()
  return { ...actual, QUERY_LIMITS: { ...actual.QUERY_LIMITS, get sqlLength() { return budget.sqlLength }, get maxOffset() { return budget.maxOffset ?? actual.QUERY_LIMITS.maxOffset } } }
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
  budget.sqlLength = 64_000; budget.maxOffset = undefined
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

it('accepts the default maxOffset boundary', async () => {
  expect(L.maxOffset).toBe(10_000)
  expect(await run({ ...base, offset: L.maxOffset })).toMatchObject({ data: [], total: 16, offset: L.maxOffset })
})
it.each([false, true])('rejects maxOffset + 1 before rows or totals SQL (includeTotal=%s)', async includeTotal => {
  const prepare = vi.fn(); const batch = vi.fn()
  const db = { prepare, batch } as unknown as D1Database
  const result = await run({ ...base, includeTotal, offset: 10_001 }, scope, kernel, db).catch(error => error)
  expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled()
  expect(result).toMatchObject({ status: 400, code: 'query_invalid', path: ['offset'] })
})
it.each([0, 4, 10_001])('respects maxOffset override %i at both boundaries', async maxOffset => {
  budget.maxOffset = maxOffset
  const page = await run({ ...base, offset: maxOffset })
  expect(page).toMatchObject({ data: fixture.slice(maxOffset, maxOffset + base.limit).map(row => ({ id: row.id })), total: 16, offset: maxOffset })
  const prepare = vi.fn(); const batch = vi.fn()
  const db = { prepare, batch } as unknown as D1Database
  const result = await run({ ...base, offset: maxOffset + 1 }, scope, kernel, db).catch(error => error)
  expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled()
  expect(result).toMatchObject({ status: 400, code: 'query_invalid', path: ['offset'] })
})
it.each([false, true])('shares maxOffset validation with list/query grammar (rest=%s)', rest => {
  budget.maxOffset = 4
  const schema = querySchema(kernel.config, 'jobs', rest)
  expect(schema.safeParse({ ...base, offset: 4 }).success).toBe(true)
  expect(schema.safeParse({ ...base, offset: 5 }).success).toBe(false)
})
it('keeps all cursor pages reachable with maxOffset zero', async () => {
  budget.maxOffset = 0
  const seen: string[] = []; let cursor: string | undefined
  do {
    const page = await run({ ...base, ...(cursor ? { cursor } : {}) })
    expect(page.total).toBe(16); expect(page.offset).toBeUndefined()
    seen.push(...page.data.map(row => row.id)); cursor = page.next_cursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(fixture.map(row => row.id))
})

// Generic wide lists: R is reference width, V includes the unfiltered all tab.
function wideTotalsFixture(refs: number, viewCount: number, refViews = false) {
  const fields = Object.fromEntries(Array.from({ length: refs }, (_, i) => [`ref_${i}`, { type: 'ref' as const, entity: 'people' }]))
  const views = [{ id: 'all', label: 'All', where: {} }, ...Array.from({ length: viewCount - 1 }, (_, i) => ({
    id: `stage_${i}`, label: `Stage ${i}`, where: refViews ? { ref_0: { isNull: false } } : { status: { eq: `stage_${i}` } },
  }))]
  const configured = defineInstance({ id: 'wide_totals', revision: 1, interactive: true,
    plugins: [identity, localAuth, tenancy, legacyPermissions], roles: ['owner', 'viewer'],
    entities: {
      tasks: { fields: { title: { type: 'string' }, status: { type: 'string' }, ...fields } },
      people: { displayField: 'name', fields: { name: { type: 'string' } } },
    },
    permissions: Object.fromEntries(['owner', 'viewer'].map(role => [role, { tasks: ['read'], people: ['read'] }])),
    policies: { tasks: { owner: 'all', viewer: 'all' }, people: { owner: 'all', viewer: 'all' } },
    ui: { entities: { tasks: { list: { views } } } },
  })
  return { configured, views, kernel: new KernelRegistry(configured) }
}
async function wideScope(current: KernelRegistry, role = 'owner') {
  return requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${role}-a` } }), runtime(), current.config), 'org-a', current.config)
}
const wideInput = { entity: 'tasks', select: ['id', 'title'], limit: 100, includeTotal: true, includeViewTotals: true }
it.each([[7, 5], [6, 6]])('wide totals R%i/V%i exclude unused ref projections under unchanged budgets', async (refs, viewCount) => {
  const { configured, kernel: current } = wideTotalsFixture(refs, viewCount)
  await setup(configured)
  const actor = await wideScope(current)
  for (const [id, status] of [['first', 'stage_0'], ['second', 'stage_1']]) {
    await env.DB.prepare('INSERT INTO tasks(id,organization_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, 'org-a', id, status, 'now', 'now').run()
  }
  expect(L.exists).toBe(16); expect(L.statements).toBe(16); expect(L.tableReferences).toBe(64)
  const { query, cost, viewQueries } = validateQuery(current, actor, wideInput)
  expect(cost).toMatchObject({ exists: refs, statements: 2 + viewCount })
  for (const variant of [query, ...viewQueries.map(view => view.query)]) {
    expect(compileListTotal(current, actor, variant, cost).sql).not.toMatch(/\bEXISTS\s*\(/i)
  }
  expect(await run(wideInput, actor, current)).toMatchObject({ data: [{ id: 'first', title: 'first' }, { id: 'second', title: 'second' }], total: 2,
    viewTotals: Object.fromEntries(viewQueries.map(view => [view.id, view.id === 'all' ? 2 : ['stage_0', 'stage_1'].includes(view.id) ? 1 : 0])),
  })
})
it('wide totals preserve row/tenant policy, required ref visibility and exact filtered counts for every role', async () => {
  const { configured } = wideTotalsFixture(7, 5)
  // The last view reads a reference; the others read only scalar status.
  configured.ui!.entities!.tasks.list!.views![4].where = { ref_0: { isNull: false } }
  const restricted: WorkbasePlugin = { name: 'wide_total_policy', version: '1',
    fieldMask(entity, actor) {
      const fields = ['id', 'organization_id', 'created_at', 'updated_at', 'version', ...Object.keys(configured.entities[entity].fields)]
      return actor.role === 'viewer' && entity === 'tasks' ? fields.filter(field => field !== 'ref_1') : fields
    },
    tableFilter(entity, actor): TableFilter {
      if (actor.role === 'owner') return { kind: 'all' }
      return entity === 'tasks' ? { kind: 'where', predicate: { all: [
        { status: { ne: 'denied' } },
        { exists: { entity: 'people', field: 'id', parentField: 'ref_1', predicate: { name: { eq: 'Allowed' } } } },
      ] } } : { kind: 'where', predicate: { name: { ne: 'Hidden' } } }
    },
  }
  const current = new KernelRegistry(configured, { plugins: [...configured.plugins!, restricted] })
  await setup(configured)
  // Deliberately model legacy data with a hostile cross-tenant reference.
  await env.DB.exec('DROP TABLE tasks; CREATE TABLE tasks (id TEXT, organization_id TEXT, title TEXT, status TEXT, ref_0 TEXT, ref_1 TEXT, ref_2 TEXT, ref_3 TEXT, ref_4 TEXT, ref_5 TEXT, ref_6 TEXT, created_at TEXT, updated_at TEXT, version INTEGER DEFAULT 1)')
  for (const [id, org, name] of [['allowed', 'org-a', 'Allowed'], ['hidden', 'org-a', 'Hidden'], ['foreign', 'org-b', 'Allowed']]) {
    await env.DB.prepare('INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind(id, org, name, 'now', 'now').run()
  }
  const rows = [
    ['a', 'org-a', 'stage_0', 'allowed', 'allowed'], ['b', 'org-a', 'stage_1', 'hidden', 'allowed'],
    ['c', 'org-a', 'stage_2', 'foreign', 'allowed'], ['d', 'org-a', 'stage_2', null, 'allowed'],
    ['row-denied', 'org-a', 'denied', 'allowed', 'allowed'], ['policy-denied', 'org-a', 'stage_0', 'allowed', 'hidden'],
    ['tenant-denied', 'org-b', 'stage_0', 'foreign', 'foreign'],
  ]
  for (const [id, org, status, ref0, ref1] of rows) await env.DB.prepare('INSERT INTO tasks(id,organization_id,title,status,ref_0,ref_1,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, org, 'Match', status, ref0, ref1, 'now', 'now').run()
  for (const role of ['owner', 'viewer']) {
    const actor = await wideScope(current, role)
    const page = await run(wideInput, actor, current)
    expect(validateQuery(current, actor, wideInput).cost.exists).toBe(role === 'owner' ? 8 : 7)
    expect(page.data.map(row => row.id)).toEqual(role === 'owner' ? ['a', 'b', 'c', 'd', 'policy-denied', 'row-denied'] : ['a', 'b', 'c', 'd'])
    expect(page.viewTotals).toEqual(role === 'owner' ? { all: 6, stage_0: 2, stage_1: 1, stage_2: 2, stage_3: 4 } : { all: 4, stage_0: 1, stage_1: 1, stage_2: 2, stage_3: 1 })
    for (const view of configured.ui!.entities!.tasks.list!.views!) {
      const plain = await run({ ...wideInput, includeViewTotals: false, view: view.id }, actor, current)
      expect(page.viewTotals![view.id]).toBe(plain.total)
      expect(plain.total).toBe(plain.data.length)
    }
    // Output-only references, labels and order never become count dependencies.
    const { query, cost } = validateQuery(current, actor, { ...wideInput, select: ['id', 'ref_0'], labels: ['ref_0'], orderBy: [{ field: 'ref_0', dir: 'asc' }] })
    const total = compileListTotal(current, actor, query, cost)
    expect(total.sql).not.toContain('label_join_')
    expect(total.sql).not.toContain('AS `ref_0`')
    // Request ref filters retain the visibility residual, including hidden and foreign targets.
    for (const where of [{ ref_0: { eq: 'foreign' } }, { ref_0: { isNull: true } }, { not: { ref_0: { isNull: true } } }]) {
      const input = { ...wideInput, where, includeViewTotals: false }
      const baseline = await run(input, actor, current)
      expect(baseline.total).toBe(baseline.data.length)
      const counted = await run({ ...input, includeViewTotals: true }, actor, current)
      expect(counted.total).toBe(baseline.total)
      for (const view of configured.ui!.entities!.tasks.list!.views!) {
        expect(counted.viewTotals![view.id]).toBe((await run({ ...input, view: view.id }, actor, current)).total)
      }
      expect(baseline.data.map(row => row.id)).toEqual('not' in where
        ? role === 'owner' ? ['a', 'b', 'policy-denied', 'row-denied'] : ['a']
        : where.ref_0?.eq ? [] : role === 'owner' ? ['c', 'd'] : ['b', 'c', 'd'])
      const statement = compileListTotal(current, actor, validateQuery(current, actor, input).query)
      expect(statement.sql).toMatch(/\bEXISTS\s*\(/i)
    }
  }
  const denied = new KernelRegistry(configured, { plugins: [...configured.plugins!, { name: 'deny_totals', version: '1', tableFilter: () => ({ kind: 'none' as const }) }] })
  expect(await run(wideInput, await wideScope(denied), denied)).toMatchObject({ data: [], total: 0, viewTotals: {} })
})
it('wide totals still reject a view filter that genuinely demands many ref probes', async () => {
  const { configured } = wideTotalsFixture(7, 5, true)
  for (const view of configured.ui!.entities!.tasks.list!.views!.slice(1)) view.where = {
    and: Array.from({ length: 7 }, (_, i) => ({ [`ref_${i}`]: { isNull: false } })),
  }
  const current = new KernelRegistry(configured)
  await setup(configured)
  const actor = await wideScope(current)
  expect(() => validateQuery(current, actor, wideInput)).toThrowError(expect.objectContaining({ code: 'query_too_expensive', cost: expect.objectContaining({ exists: 35, statements: 7 }) }))
})

function repeatedVisibilityFixture() {
  const { configured: seed } = wideTotalsFixture(7, 3)
  const configured = defineInstance({ ...seed, entities: { ...seed.entities, tasks: { ...seed.entities.tasks,
    fields: { ...seed.entities.tasks.fields, chosen: { type: 'ref', entity: 'people', computed: 'ref_0' } },
  } } })
  return { configured, current: new KernelRegistry(configured) }
}
it('repeated visibility rejects computed reference totals above the EXISTS budget', async () => {
  const { configured, current } = repeatedVisibilityFixture()
  await setup(configured)
  const actor = await wideScope(current)
  expect(() => validateQuery(current, actor, { entity: 'tasks', select: ['id'], limit: 1,
    where: { chosen: { isNull: false } }, includeTotal: true, includeViewTotals: true,
  })).toThrowError(expect.objectContaining({ code: 'query_too_expensive', cost: expect.objectContaining({ exists: 28, statements: 5 }) }))
})
it.each(['owner', 'viewer'])('repeated visibility estimates cover each emitted count and aggregate for %s', async role => {
  const { configured, current: original } = repeatedVisibilityFixture()
  const policy: WorkbasePlugin = { name: 'repeated_visibility_policy', version: '1',
    tableFilter(entity, actor): TableFilter {
      return actor.role === 'viewer' && entity === 'tasks'
        ? { kind: 'where', predicate: { status: { ne: 'denied' } } }
        : { kind: 'all' }
    },
  }
  const current = new KernelRegistry(original.config, { plugins: [...configured.plugins!, policy] })
  await setup(configured)
  const actor = await wideScope(current, role)
  const emitted = (sql: string) => (sql.match(/\bEXISTS\s*\(/gi) ?? []).length
  for (const where of [undefined, { ref_0: { isNull: false } }, { chosen: { isNull: false } }, { not: { chosen: { isNull: true } } }]) {
    const input = { entity: 'tasks', select: ['id'], limit: 1, where, includeTotal: true, includeViewTotals: true }
    // Compile all statements even when admission correctly rejects the request.
    const variants = [input, ...configured.ui!.entities!.tasks.list!.views!.map(view => ({ ...input, view: view.id }))]
    const counts = variants.map(variant => compileListTotal(current, actor, variant))
    const estimates = variants.map(variant => listTotalReferenceCost(current, actor, variant))
    counts.forEach((statement, i) => expect(estimates[i]).toBeGreaterThanOrEqual(emitted(statement.sql)))
    let cost
    try { cost = validateQuery(current, actor, input).cost } catch (error) {
      expect(error).toMatchObject({ code: 'query_too_expensive' })
      cost = (error as { cost: { exists: number; statements: number } }).cost
    }
    const actual = emitted(compileRoot(current, actor, input).sql) + counts.reduce((sum, statement) => sum + emitted(statement.sql), 0)
    expect(cost.exists).toBeGreaterThanOrEqual(actual)
  }
})
