// @vitest-environment jsdom
import { createElement as h } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { grants } from './grants'
import { ConsoleProvider, PageView } from '../src/react'
import { entityCreatePage, entityDetailPage, entityEditPage, entityListPage, type Node, page, list } from '../src/index'
import type { Manifest } from '../src/check'
import type { ClientRequestInit } from '../src/client'
const fields = Object.fromEntries(['name', 'extra', 'user', 'locked'].map(name => [name, { type: name === 'user' ? 'ref' : 'string', required: name === 'name', readOnly: name === 'locked', userLink: name === 'user', computed: false }]))
const meta = { displayField: 'name', fields }
const links = { list: { to: '/items', bind: {} }, detail: { to: '/items/$itemId', bind: { itemId: 'record.id' } }, edit: { to: '/items/$itemId/edit', bind: { itemId: 'record.id' } } }
function route(mode: 'list' | 'detail' | 'edit' | 'create', layout: Node[] = ['name', 'extra', 'user', 'locked']) {
  const options = { title: 'probe.' + mode, layout, recordParam: 'itemId' }
  const page = mode === 'list' ? entityListPage('probe', options) : mode === 'detail' ? entityDetailPage('probe', options) : mode === 'edit' ? entityEditPage('probe', options) : entityCreatePage('probe', options)
  return { ...page, source: 'ui/items.ts', path: mode === 'create' ? '/items/new' : mode === 'list' ? '/items' : '/items/$itemId/' + mode, links }
}
const row = { id: 'x', version: 1, name: 'Server', extra: 'set', user: 'linked', locked: 'fixed' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const t = (key: string) => key
const navigate = vi.fn()
function view(fetch: (url: string, init: ClientRequestInit) => Promise<Response>, mode: Parameters<typeof route>[0] = 'detail', options: { orgId?: string; id?: string; layout?: Node[]; metadata?: typeof meta } = {}) {
  return h(ConsoleProvider, { caps: grants({ probe: options.metadata ?? meta }), identity: { actorId: 'a', orgId: options.orgId ?? 'one' }, t, fetch }, h(PageView, { definition: route(mode, options.layout), route: route(mode, options.layout), entities: { probe: options.metadata ?? meta }, params: { itemId: options.id ?? 'x' }, search: {}, navigate }))
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); navigate.mockReset() })
test.each([['notFound', 404], ['forbidden', 403], ['network', 500]] as const)('renders %s from HTTP status', async (state, status) => {
  render(view(async () => json({ error: 'failure' }, status)))
  expect(await screen.findByText('sdk:' + state)).toBeTruthy()
})
test('renders loading, empty and network rejection', async () => {
  const mounted = render(view(() => new Promise(() => {})))
  expect(screen.getByText('sdk:loading')).toBeTruthy(); mounted.unmount()
  const empty = render(view(async () => json({ data: [], next_cursor: null }), 'list'))
  expect(await screen.findByText('sdk:empty')).toBeTruthy(); empty.unmount()
  render(view(async () => { throw new TypeError('offline') }))
  expect(await screen.findByText('sdk:network')).toBeTruthy()
})
test('deferred A after B renders B; org switch cannot serve an old cache entry', async () => {
  const pending: { init: ClientRequestInit; resolve: (r: Response) => void }[] = []
  const fetch = vi.fn((_url: string, init: ClientRequestInit) => new Promise<Response>(resolve => pending.push({ init, resolve })))
  const mounted = render(view(fetch, 'detail', { id: 'A' }))
  await waitFor(() => expect(pending).toHaveLength(1))
  mounted.rerender(view(fetch, 'detail', { id: 'B' }))
  await waitFor(() => expect(pending).toHaveLength(2))
  await act(async () => { pending[1].resolve(json({ ...row, id: 'B', name: 'B rendered' })) })
  expect(await screen.findByText('B rendered')).toBeTruthy()
  await act(async () => { pending[0].resolve(json({ ...row, name: 'A stale' })) })
  expect(screen.queryByText('A stale')).toBeNull(); expect(pending[0].init.signal?.aborted).toBe(true)
  mounted.rerender(view(fetch, 'detail', { id: 'B', orgId: 'two' }))
  expect(screen.queryByText('B rendered')).toBeNull()
  await waitFor(() => expect(pending).toHaveLength(3))
  expect(new Headers(pending[2].init.headers).get('X-Organization-Id')).toBe('two')
})
test('save excludes userLink/readOnly, trims and clears; empty diff does not request', async () => {
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => json(init.method === 'PATCH' ? { ...row, version: 2, name: 'Changed', extra: null } : row))
  render(view(fetch, 'edit'))
  fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: ' Changed ' } })
  fireEvent.change(screen.getByLabelText('domain:field.probe.extra'), { target: { value: '' } })
  expect(screen.queryByLabelText('domain:field.probe.user')).toBeNull(); expect(screen.queryByLabelText('domain:field.probe.locked')).toBeNull()
  fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toEqual({ name: 'Changed', extra: null })
  cleanup(); navigate.mockReset(); fetch.mockClear()
  render(view(fetch, 'edit')); await screen.findByLabelText('domain:field.probe.name')
  fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  expect(fetch).toHaveBeenCalledTimes(1)
})
test('required blank blocks locally and server issues map to field paths', async () => {
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => init.method === 'PATCH' ? json({ error: 'validation_error', issues: [{ path: ['extra'], code: 'custom' }] }, 400) : json(row))
  render(view(fetch, 'edit'))
  fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: '  ' } }); fireEvent.click(screen.getByText('sdk:save'))
  expect(await screen.findByText('sdk:required')).toBeTruthy(); expect(fetch).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('domain:field.probe.name'), { target: { value: 'Valid' } }); fireEvent.click(screen.getByText('sdk:save'))
  expect(await screen.findAllByText('sdk:validation')).toHaveLength(2)
  expect(screen.getByLabelText('domain:field.probe.extra').getAttribute('aria-invalid')).toBe('true')
})
test('editing name preserves an unchanged padded enum literal on the wire', async () => {
  const initial = { ...row, status: ' closed ' }
  const metadata = { ...meta, fields: { ...fields, status: { ...fields.extra, type: 'enum', values: ['open', ' closed '] } } }
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => json(init.method === 'PATCH' ? { ...initial, name: 'Changed', version: 2 } : initial))
  render(view(fetch, 'edit', { layout: ['name', 'status'], metadata }))
  fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: 'Changed' } })
  expect((screen.getByLabelText('domain:field.probe.status') as unknown as { value: string }).value).toBe(' closed ')
  fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init.method === 'PATCH')![1].body))).toEqual({ name: 'Changed' })
})
test('conflict retains draft; explicit reload and resave diffs against fresh server copy', async () => {
  let server = row, conflict = true
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => {
    if (init.method !== 'PATCH') return json(server)
    if (conflict) { server = { ...row, name: 'Other session', extra: 'new', version: 2 }; return json({ error: 'version_conflict' }, 409) }
    return json({ ...server, ...JSON.parse(String(init.body)), version: 3 })
  })
  render(view(fetch, 'edit'))
  fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: 'Draft' } }); fireEvent.click(screen.getByText('sdk:save'))
  expect(await screen.findByText('sdk:conflict')).toBeTruthy(); expect((screen.getByLabelText('domain:field.probe.name') as unknown as { value: string }).value).toBe('Draft')
  expect(fetch).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByText('sdk:reloadServerCopy'))
  await waitFor(() => expect((screen.getByLabelText('domain:field.probe.name') as unknown as { value: string }).value).toBe('Other session'))
  conflict = false
  fireEvent.change(screen.getByLabelText('domain:field.probe.name'), { target: { value: 'Resaved' } }); fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  const init = fetch.mock.calls.filter(([, init]) => init.method === 'PATCH').at(-1)![1]
  expect(JSON.parse(String(init.body))).toEqual({ name: 'Resaved' }); expect(new Headers(init.headers).get('If-Match')).toBe('"2"')
})
test('create keeps one idempotency key through retry; cancel/back confirm dirty drafts', async () => {
  let fail = true
  const fetch = vi.fn(async () => fail ? json({ error: 'failure' }, 500) : json(row, 201))
  const confirm = vi.spyOn(globalThis as typeof globalThis & { confirm(message: string): boolean }, 'confirm').mockReturnValue(false)
  render(view(fetch, 'create'))
  fireEvent.change(screen.getByLabelText('domain:field.probe.name'), { target: { value: 'New' } }); fireEvent.click(screen.getByText('sdk:cancel'))
  expect(confirm).toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('sdk:save')); await screen.findByText('sdk:network')
  fail = false; fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  const calls = fetch.mock.calls as unknown as [string, ClientRequestInit][]
  expect(new Headers(calls[0][1].headers).get('Idempotency-Key')).toBe(new Headers(calls[1][1].headers).get('Idempotency-Key'))
  cleanup(); navigate.mockReset()
  render(view(async () => json(row), 'edit')); await screen.findByLabelText('domain:field.probe.name')
  fireEvent.click(screen.getByText('sdk:cancel')); expect(navigate).toHaveBeenCalledWith('/items/x')
  cleanup(); navigate.mockReset()
  render(view(async () => json(row))); await screen.findByText('Server')
  fireEvent.click(screen.getByText('sdk:back')); expect(navigate).toHaveBeenCalledWith('/items')
})
test('recursive structures, injected titles, slots, and explicit unsupported field/ref', async () => {
  const layout: Node[] = [{ kind: 'tabs', title: 'layout.tabs', children: [{ kind: 'tab', children: [{ kind: 'columns', children: [{ kind: 'row', children: [{ kind: 'section', children: ['name', 'extra'] }] }] }] }] }]
  render(view(async () => json(row), 'detail', { layout, metadata: { ...meta, fields: { ...fields, extra: { ...fields.extra, type: 'alien' } } } }))
  expect(await screen.findByText('Server')).toBeTruthy(); expect(screen.getByText('ui:layout.tabs')).toBeTruthy(); expect(screen.getByText('sdk:unsupported: alien')).toBeTruthy()
  cleanup()
  render(view(async () => json(row), 'edit', { metadata: { ...meta, fields: { ...fields, user: { ...fields.user, userLink: false } } } }))
  expect(await screen.findByText('sdk:unsupported: ref')).toBeTruthy()
})
test('list controls search/sort, append forward pages, reset cursor, and build declared detail paths', async () => {
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => {
    const body = JSON.parse(String(init.body))
    return json({ data: [{ ...row, id: body.cursor ? 'second' : 'first', name: body.search?.text || (body.cursor ? 'Second' : 'First') }], next_cursor: body.cursor || body.search ? null : 'opaque' })
  })
  render(view(fetch, 'list', { layout: [] }))
  fireEvent.click(await screen.findByText('sdk:loadMore')); await screen.findByText('Second')
  expect(screen.getByText('First')).toBeTruthy()
  expect(JSON.parse(String(fetch.mock.calls[1][1].body)).cursor).toBe('opaque')
  fireEvent.change(screen.getByLabelText('sdk:search'), { target: { value: 'Needle' } })
  await screen.findByText('Needle'); expect(screen.queryByText('First')).toBeNull()
  fireEvent.change(screen.getByLabelText('sdk:direction'), { target: { value: 'desc' } })
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
  const body = JSON.parse(String(fetch.mock.calls.at(-1)![1].body))
  expect(body).toMatchObject({ limit: 25, search: { fields: ['name'] }, orderBy: [{ field: 'name', dir: 'desc' }] }); expect(body.cursor).toBeUndefined()
  fireEvent.click(await screen.findByText('Needle')); expect(navigate).toHaveBeenCalledWith('/items/first')
})
test('field table renders all supported editable types and read-only computed values', async () => {
  const metadata = { displayField: 'name', fields: Object.fromEntries(['string', 'text', 'int', 'float', 'bool', 'datetime', 'enum'].map(type => [type, { type, required: false, readOnly: false, computed: false, userLink: false, ...(type === 'enum' ? { values: ['a', 'b'] } : {}) }])) }
  const item = { ...row, string: 's', text: 't', int: 1, float: 1.5, bool: true, datetime: '2026-11-13T10:00', enum: 'a' }
  render(view(async () => json(item), 'edit', { layout: Object.keys(metadata.fields), metadata }))
  for (const type of Object.keys(metadata.fields)) expect(await screen.findByLabelText('domain:field.probe.' + type)).toBeTruthy()
  cleanup()
  render(view(async () => json(row), 'edit', { metadata: { ...meta, fields: { ...fields, extra: { ...fields.extra, computed: true } } } }))
  expect(await screen.findByText('set')).toBeTruthy(); expect(screen.queryByLabelText('domain:field.probe.extra')).toBeNull()
})
test('slots receive only declared field values and t; titles use injected t', async () => {
  const component = vi.fn((props: { label: string }) => h('strong', null, props.label))
  const slots = { card: { contexts: ['record' as const], props: { label: { kind: 'field' as const, type: 'string' } }, component } }
  const page = route('detail', [{ kind: 'slot', id: 'card', props: { label: 'name' } }])
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t: key => 'translated:' + key, slots, fetch: async () => json(row) }, h(PageView, { definition: page, route: page, entities: { probe: meta }, params: { itemId: 'x' }, search: {}, navigate })))
  expect(await screen.findByText('Server')).toBeTruthy(); expect(screen.getByText('translated:ui:probe.detail')).toBeTruthy()
  expect(Object.keys(component.mock.calls[0][0]).sort()).toEqual(['label', 't'])
  expect(component.mock.calls[0][0]).toMatchObject({ label: 'Server' })
  expect(Object.hasOwn(component.mock.calls[0][0], 'user')).toBe(false)
})
test('create entry and dirty edit back follow declared paths', async () => {
  const list = route('list', [])
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t, fetch: async () => json({ data: [], next_cursor: null }) }, h(PageView, { definition: list, route: list, routes: [list, route('create')], entities: { probe: meta }, params: {}, search: {}, navigate })))
  fireEvent.click(screen.getByText('sdk:create')); expect(navigate).toHaveBeenCalledWith('/items/new')
  cleanup(); navigate.mockReset()
  const confirm = vi.spyOn(globalThis as typeof globalThis & { confirm(message: string): boolean }, 'confirm').mockReturnValue(true)
  render(view(async () => json(row), 'edit'))
  fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: 'Dirty' } }); fireEvent.click(screen.getByText('sdk:back'))
  expect(confirm).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledWith('/items/x')
})

test('page primitive infers list binding and renders static layout slots without fetching', async () => {
  const definition = page({ title: 'probe.list', data: { results: list('probe') } })
  const listed = { ...route('list', []), ...definition }
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t, fetch: async () => json({ data: [row], next_cursor: null }) }, h(PageView, { definition, route: listed, entities: { probe: meta }, params: {}, search: {}, navigate })))
  expect(await screen.findByText('Server')).toBeTruthy()
  cleanup()
  const staticPage = page({ title: 'static.title', layout: [{ kind: 'slot', id: 'static', props: {} }] }), fetch = vi.fn()
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t, fetch, slots: { static: { contexts: ['record'], props: {}, component: () => h('p', null, 'Static slot') } } }, h(PageView, { definition: staticPage, route: { ...route('detail'), ...staticPage }, entities: {}, params: {}, search: {}, navigate })))
  expect(screen.getByText('Static slot')).toBeTruthy(); expect(fetch).not.toHaveBeenCalled()
})
test('returning to an earlier search starts at page one, including after a host rerender', async () => {
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => {
    const body = JSON.parse(String(init.body)), second = !!body.cursor
    return json({ data: [{ ...row, id: second ? 'second' : 'first', name: (body.search?.text || 'A') + (second ? ' second' : ' first') }], next_cursor: second ? null : 'opaque' })
  })
  const mounted = render(view(fetch, 'list', { layout: [] }))
  fireEvent.click(await screen.findByText('sdk:loadMore')); await screen.findByText('A second')
  fireEvent.change(screen.getByLabelText('sdk:search'), { target: { value: 'B' } }); await screen.findByText('B first')
  fireEvent.change(screen.getByLabelText('sdk:search'), { target: { value: '' } }); await screen.findByText('A first')
  expect(screen.queryByText('A second')).toBeNull()
  mounted.rerender(view(fetch, 'list', { layout: [], metadata: { ...meta, fields: { ...fields } } }))
  fireEvent.click(screen.getByText('sdk:loadMore')); expect(await screen.findByText('A second')).toBeTruthy()
})
