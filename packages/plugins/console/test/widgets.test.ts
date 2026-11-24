import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { bootstrap } from '../../../test-support/src/bootstrap'
import { createApp } from '../../../core/src/app'
import { widgetDashboard, referenceQuery, seedWidgetDashboard } from '../../../core/test/fixtures/widget-dashboard'
import { runtime, request } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { requireScope } from '../../../core/src/authorization'
import { validateQuery } from '../../../core/src/query/schema'
import { compileRoot } from '../../../core/src/query/compiler'
import { executeWidgets } from '../src/widgets'
import type { ConsoleModelContract, ConsolePageResult } from '../../../core/src/console-contract'

async function fixture(repeatedPolicy = 1, restrictedView = false) {
  const config = widgetDashboard(repeatedPolicy, restrictedView)
  await reset()
  await bootstrap(env.DB, config)
  await seedWidgetDashboard(env.DB)
  const app = createApp(config, runtime())
  const kernel = new KernelRegistry(config)
  const actor = await kernel.requireActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-viewer-a' } }), runtime())
  const scope = await requireScope(actor, 'org-a', kernel.config)
  const page = config.plugins!.find(plugin => plugin.name === 'widget-dashboard')!.contributes!.console!.pages![0]
  return { app, kernel, scope, page }
}

it('uses identical cost, SQL, bindings and authorized data for list and reference-label widget', async () => {
  const { app, kernel, scope, page } = await fixture()
  const validated = validateQuery(kernel, scope, referenceQuery)
  expect(validated.cost).toEqual({ statements: 1, depth: 1, relations: 1, fieldRows: 35, exists: 8, nodes: 0 })
  const statement = compileRoot(kernel, scope, validated.query, undefined, validated.cost)
  expect({ sqlLength: statement.sql.length, bindings: statement.bindings.length }).toEqual({ sqlLength: 9657, bindings: 6 })
  const prepare = vi.fn((sql: string) => env.DB.prepare(sql))
  const db = { prepare, batch: env.DB.batch.bind(env.DB) } as unknown as D1Database
  const widgets = (await executeWidgets(kernel, scope, db, page)).widgets
  expect(prepare).toHaveBeenCalledWith(statement.sql)
  const listed = await request(app, '/query', 'POST', referenceQuery, 'viewer-a')
  expect(listed.status).toBe(200)
  const list = await listed.json() as { data: unknown[] }
  expect(widgets.find(widget => widget.id === 'references')).toMatchObject({ kind: 'table', data: list.data })
  expect(list.data).toMatchObject([{ id: 'own', __labels: { account_id: { status: 'ok', row: { name: 'Alex Example' } } } }])
  expect(list.data).toHaveLength(1)
})

it('returns 200 with a real compiler refusal and keeps the other staff-scoped widgets', async () => {
  // Repeated grants keep the same semantics; the expanded SQL reaches the
  // unchanged 64-source guard only when the reference-label source is added.
  const { app, kernel, scope } = await fixture(55)
  const validated = validateQuery(kernel, scope, referenceQuery)
  expect(validated.cost).toMatchObject({ exists: 8, relations: 1, fieldRows: 35 })
  expect(() => compileRoot(kernel, scope, validated.query, undefined, validated.cost)).toThrow('query_too_expensive')
  expect((await request(app, '/query', 'POST', referenceQuery, 'viewer-a')).status).toBe(400)
  const metadata = await request(app, '/o/org-a/console-model', 'GET', undefined, 'viewer-a')
  expect(metadata.status).toBe(200)
  const response = await request(app, '/o/org-a/console-pages/summary', 'GET', undefined, 'viewer-a')
  expect(response.status).toBe(200)
  const body = await response.json() as ConsolePageResult
  expect(body.widgets).toEqual([
    { id: 'count', label: 'Job count', kind: 'stat', value: 1 },
    { id: 'references', label: 'Recent jobs', kind: 'error', code: 'query_too_expensive' },
    { id: 'plain', label: 'Job titles', kind: 'list', field: 'title', data: [{ id: 'own', title: 'Example job' }] },
  ])
  expect(body.sections).toEqual([{ row: ['count', 'references'] }, { row: ['plain'] }])
  expect(JSON.stringify(body)).not.toMatch(/sql|bindings|scope_row|fieldRows|Other job|Foreign job/)
  await env.DB.prepare("UPDATE accounts SET user=NULL WHERE id='own'").run()
  const unlinked = await request(app, '/o/org-a/console-pages/summary', 'GET', undefined, 'viewer-a')
  expect(unlinked.status).toBe(200)
  expect(await unlinked.text()).not.toContain('Example job')
  expect((await request(app, '/o/org-b/console-pages/summary', 'GET', undefined, 'viewer-a')).status).toBe(403)
})

it('isolates a driver failure and serializes only the generic stable code', async () => {
  const { kernel, scope, page } = await fixture()
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('__label_account_id')) throw new Error('private SQL / bindings / database detail')
    return env.DB.prepare(sql)
  })
  const db = { prepare, batch: env.DB.batch.bind(env.DB) } as unknown as D1Database
  const body = await executeWidgets(kernel, scope, db, page)
  expect(body.widgets).toContainEqual({ id: 'references', label: 'Recent jobs', kind: 'error', code: 'widget_failed' })
  expect(body.widgets.find(widget => widget.id === 'plain')).toMatchObject({ data: [{ id: 'own' }] })
  expect(JSON.stringify(body)).not.toMatch(/private SQL|bindings|database detail/)
})

it('isolates final validation-budget refusals before preparing SQL', async () => {
  const { kernel, scope, page } = await fixture()
  const refused = { ...referenceQuery, where: { or: Array.from({ length: 9 }, () => ({ account: { name: { eq: 'Alex Example' } } })) } }
  const widgets = page.widgets!.map(widget => widget.id === 'references' && widget.kind === 'table' ? { ...widget, query: refused } : widget)
  const prepare = vi.fn((sql: string) => env.DB.prepare(sql))
  const result = await executeWidgets(kernel, scope, { prepare, batch: env.DB.batch.bind(env.DB) } as unknown as D1Database, { ...page, widgets })
  expect(result.widgets).toContainEqual({ id: 'references', label: 'Recent jobs', kind: 'error', code: 'query_too_expensive' })
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(result.widgets.find(widget => widget.id === 'plain')).toMatchObject({ data: [{ id: 'own' }] })
})

it('keeps field-denied widgets omitted even when their query would exceed the budget', async () => {
  const { kernel, scope, page } = await fixture()
  const original = kernel.fieldMask.bind(kernel)
  vi.spyOn(kernel, 'fieldMask').mockImplementation((entity, live) => original(entity, live).filter(field => entity !== 'jobs' || field !== 'title'))
  const refused = { ...referenceQuery, where: { or: Array.from({ length: 9 }, () => ({ account: { name: { eq: 'Alex Example' } } })) } }
  const widgets = page.widgets!.map(widget => widget.id === 'references' && widget.kind === 'table' ? { ...widget, query: refused } : widget)
  expect((await executeWidgets(kernel, scope, env.DB, { ...page, widgets })).widgets).toEqual([{ id: 'count', label: 'Job count', kind: 'stat', value: 1 }])
})

it('isolates validation refusals over HTTP while omitting views and widgets projected out by declared field grants', async () => {
  const { app, kernel, scope, page } = await fixture(1, true)
  expect(kernel.fieldMask('jobs', scope)).toContain('id')
  expect(kernel.fieldMask('jobs', scope)).not.toContain('title')
  const named = page.widgets!.find(widget => widget.id === 'named')!
  expect(() => validateQuery(kernel, scope, named.query)).toThrow(expect.objectContaining({ code: 'query_invalid', path: ['view'] }))
  const invalid = page.widgets!.find(widget => widget.id === 'invalid')!
  expect(() => validateQuery(kernel, scope, invalid.query)).toThrow(expect.objectContaining({ code: 'query_invalid', path: ['contextList'] }))
  // The query API remains fail-closed and keeps its existing 400 contract.
  expect((await request(app, '/query', 'POST', named.query, 'viewer-a')).status).toBe(400)
  expect((await request(app, '/query', 'POST', invalid.query, 'viewer-a')).status).toBe(400)
  const metadata = await request(app, '/o/org-a/console-model', 'GET', undefined, 'viewer-a')
  expect(metadata.status).toBe(200)
  const model = await metadata.json() as ConsoleModelContract
  expect(model.console!.pages.find(page => page.id === 'summary')!.widgets!.map(widget => widget.id)).toEqual(['count'])
  expect(model.model.entities.jobs.list?.views?.map(view => view.id)).not.toContain('named')
  const response = await request(app, '/o/org-a/console-pages/summary', 'GET', undefined, 'viewer-a')
  expect(response.status).toBe(200)
  const body = await response.json() as ConsolePageResult
  expect(body.widgets).toEqual([
    { id: 'count', label: 'Job count', kind: 'stat', value: 1 },
    { id: 'invalid', label: 'Unavailable records', kind: 'error', code: 'widget_failed' },
  ])
  expect(body.sections).toEqual([{ row: ['count'] }])
  expect(JSON.stringify(body)).not.toMatch(/sql|bindings|path|contextList|missing|title|account|staff|named|Other job|Foreign job/i)
  for (const route of ['console-pages/summary', 'console-model']) {
    expect((await request(app, `/o/org-b/${route}`, 'GET', undefined, 'viewer-a')).status).toBe(403)
  }
})
