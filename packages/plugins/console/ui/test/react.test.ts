// @vitest-environment jsdom
import { createElement as h } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { grants } from './grants'
import { AccessCard, ConsoleProvider, PageView, failureState, useRuntime } from '../src/react'
import { entityCreatePage, entityDetailPage, entityEditPage, entityListPage, type Node, page, list } from '../src/index'
import type { Manifest } from '../src/check'
import { ApiFailure, type Client, type ClientRequestInit } from '../src/client'
import { createI18n } from '../src/i18n'
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
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'GET').length).toBeGreaterThanOrEqual(2)
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

test.each(['en', 'cs'] as const)('named %s entity captions render object-form Create and singular form names while titles remain independent', async language => {
  const singular = language === 'cs' ? 'Pracovník' : 'Worker', object = language === 'cs' ? 'pracovníka' : 'worker'
  const i18n = createI18n({ languages: [language], catalogs: { [language]: {
    domain: { 'entity.probe.singular': singular, 'entity.probe.object': object, 'entity.probe_one': '{{count}} item', 'entity.probe_other': '{{count}} items', 'field.probe.name': 'Name' },
    ui: { 'probe.list': 'Independent list title', 'probe.create': 'Independent create title' },
  } } })
  const listPage = route('list', []), createPage = route('create', [])
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t: i18n.t, i18n, fetch: async () => json({ data: [], next_cursor: null }) }, h(PageView, { definition: listPage, route: listPage, routes: [listPage, createPage], entities: { probe: meta }, params: {}, search: {}, navigate })))
  fireEvent.click(screen.getByRole('button', { name: language === 'cs' ? 'Vytvořit pracovníka' : 'Create worker' }))
  expect(navigate).toHaveBeenCalledWith('/items/new')
  expect(screen.getByRole('heading', { name: 'Independent list title' })).toBeTruthy()
  cleanup()
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t: i18n.t, i18n }, h(PageView, { definition: createPage, route: createPage, entities: { probe: meta }, params: {}, search: {}, navigate })))
  expect(screen.getByRole('form', { name: singular })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Independent create title' })).toBeTruthy()
})

test('real translator falls back to generic sdk:create when no object form exists in the active language', async () => {
  const i18n = createI18n({ languages: ['cs', 'en'], catalogs: {
    en: { domain: { 'entity.probe.object': 'worker' } },
    cs: { domain: { 'entity.probe_other': '{{count}} pracovníků', 'field.probe.name': 'Jméno' }, ui: { 'probe.list': 'Seznam' } },
  } })
  const listPage = route('list', [])
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t: i18n.t, i18n, fetch: async () => json({ data: [], next_cursor: null }) }, h(PageView, { definition: listPage, route: listPage, routes: [listPage, route('create')], entities: { probe: meta }, params: {}, search: {}, navigate })))
  expect(screen.getByRole('button', { name: 'Vytvořit' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Create worker' })).toBeNull()
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

const available = { ...row, access: { state: 'no_account', account: null, invitation: null }, actions: { close: { enabled: true }, invite: { enabled: true } } }
function availabilityView(fetch: (url: string, init: ClientRequestInit) => Promise<Response>, mode: 'detail' | 'edit', capture: (client: Client) => void) {
  function Inspector() { capture(useRuntime().client); return null }
  const definition = route(mode, ['name', { kind: 'action', name: 'close' }, { kind: 'slot', id: 'access', props: {} }])
  return h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t, fetch,
    slots: { access: { contexts: ['record'], props: { access: { kind: 'access' } }, component: AccessCard } },
  }, h(Inspector), h(PageView, { definition, route: definition, entities: { probe: meta }, params: { itemId: 'x' }, search: {}, navigate }))
}
function expectNoExecutableAvailability() {
  for (const name of ['ui:actions.close', 'sdk:card.invite']) {
    const button = screen.queryByRole('button', { name })
    expect(button === null || button.hasAttribute('disabled')).toBe(true)
  }
}
test.each([0, 403, 404, 503])('mounted invalidation hides generic/access actions during pending and failed refresh (%s)', async status => {
  let finish: (value: Response) => void = () => {}, fail: (error: Error) => void = () => {}, client!: Client
  const fetch = vi.fn().mockResolvedValueOnce(json(available)).mockImplementation(() => new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject }))
  render(availabilityView(fetch, 'detail', value => { client = value }))
  await screen.findByRole('button', { name: 'ui:actions.close' }); await screen.findByRole('button', { name: 'sdk:card.invite' })
  act(() => client.invalidate())
  expectNoExecutableAvailability()
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await act(async () => { if (status) finish(json({ error: 'failure' }, status)); else fail(new TypeError('offline')) })
  expectNoExecutableAvailability()
  expect(screen.getByText('Server')).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(2)
})
test.each([409, 403, 404, 0])('failed save (%s) and background owner refresh preserve drafts and use fresh availability', async status => {
  let client!: Client, finishWrite: (value: Response) => void = () => {}, failWrite: (error: Error) => void = () => {}, finishRefresh: (value: Response) => void = () => {}
  const fetch = vi.fn((_url: string, init: ClientRequestInit) => {
    if (init.method === 'PATCH') return new Promise<Response>((resolve, reject) => { finishWrite = resolve; failWrite = reject })
    if (fetch.mock.calls.length === 1) return Promise.resolve(json(available))
    return new Promise<Response>(resolve => { finishRefresh = resolve })
  })
  render(availabilityView(fetch, 'edit', value => { client = value }))
  const input = await screen.findByLabelText('domain:field.probe.name')
  await screen.findByRole('button', { name: 'ui:actions.close' })
  fireEvent.change(input, { target: { value: 'Unsaved' } }); fireEvent.click(screen.getByText('sdk:save'))
  expectNoExecutableAvailability()
  await act(async () => { if (status) finishWrite(json({ error: status === 409 ? 'version_conflict' : 'refused' }, status)); else failWrite(new TypeError('offline')) })
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
  expectNoExecutableAvailability()
  expect((input as unknown as { value: string }).value).toBe('Unsaved')
  await act(async () => finishRefresh(json({ ...available, name: 'New server', version: 2, actions: { close: { enabled: false, reason: 'record.closed' } } })))
  await screen.findByText('ui:record.closed')
  expect((screen.getByLabelText('domain:field.probe.name') as unknown as { value: string }).value).toBe('Unsaved')
  expect(screen.getByLabelText('domain:field.probe.name')).toBe(input)
  expectNoExecutableAvailability()
  expect(await client.one('probe', { id: 'x' }, new AbortController().signal, true)).toMatchObject({ name: 'New server' })
  expect(fetch).toHaveBeenCalledTimes(3)
})
test.each([undefined, null, [], { close: { enabled: 'yes' } }])('invalid detail metadata %j cannot enable generic/access actions', async actions => {
  render(availabilityView(async () => json({ ...available, actions }), 'detail', () => {}))
  await screen.findByText('Server')
  expectNoExecutableAvailability()
})

test.each(['en', 'cs'] as const)('unique conflict is localized, retains draft and permits corrected retry (%s)', async language => {
  const i18n = createI18n({ languages: ['en', 'cs'], profile: { language }, catalogs: {} })
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => {
    if (init.method !== 'PATCH') return json(row)
    const data = JSON.parse(String(init.body))
    return data.name === 'Duplicate' ? json({ error: 'unique_conflict', detail: { constraintId: 'probe.name_unique' } }, 409) : json({ ...row, ...data, version: 2 })
  })
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t: i18n.t, fetch }, h(PageView, { definition: route('edit'), route: route('edit'), entities: { probe: meta }, params: { itemId: 'x' }, search: {}, navigate })))
  const name = await screen.findByLabelText(i18n.t('domain:field.probe.name'))
  fireEvent.change(name, { target: { value: 'Duplicate' } }); fireEvent.click(screen.getByText(i18n.t('sdk:save')))
  const message = language === 'cs' ? 'Záznam se stejnou kombinací hodnot již existuje. Změňte hodnoty a zkuste to znovu.' : 'A record with the same combination of values already exists. Change the values and try again.'
  expect(await screen.findByText(message)).toBeTruthy()
  expect(screen.queryByText(i18n.t('sdk:network'))).toBeNull()
  expect((name as unknown as { value: string }).value).toBe('Duplicate'); expect(navigate).not.toHaveBeenCalled()
  fireEvent.change(name, { target: { value: 'Corrected' } }); fireEvent.click(screen.getByText(i18n.t('sdk:save')))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  expect(JSON.parse(String(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH').at(-1)![1].body))).toEqual({ name: 'Corrected' })
})
test.each(['en', 'cs'] as const)('ref equality mismatch is localized, retains draft and permits corrected retry (%s)', async language => {
  const i18n = createI18n({ languages: ['en', 'cs'], profile: { language }, catalogs: {} })
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => {
    if (init.method !== 'PATCH') return json(row)
    const data = JSON.parse(String(init.body))
    return data.name === 'Duplicate' ? json({ error: 'ref_equality_mismatch', detail: { constraintId: 'probe.name_unique' } }, 422) : json({ ...row, ...data, version: 2 })
  })
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t: i18n.t, fetch }, h(PageView, { definition: route('edit'), route: route('edit'), entities: { probe: meta }, params: { itemId: 'x' }, search: {}, navigate })))
  const name = await screen.findByLabelText(i18n.t('domain:field.probe.name'))
  fireEvent.change(name, { target: { value: 'Duplicate' } }); fireEvent.click(screen.getByText(i18n.t('sdk:save')))
  const message = language === 'cs' ? 'Vybrané odkazy si neodpovídají. Změňte hodnoty a zkuste to znovu.' : 'The selected references do not agree. Change the values and try again.'
  expect(await screen.findByText(message)).toBeTruthy()
  expect(screen.queryByText(i18n.t('sdk:network'))).toBeNull()
  expect((name as unknown as { value: string }).value).toBe('Duplicate'); expect(navigate).not.toHaveBeenCalled()
  fireEvent.change(name, { target: { value: 'Corrected' } }); fireEvent.click(screen.getByText(i18n.t('sdk:save')))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  expect(JSON.parse(String(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH').at(-1)![1].body))).toEqual({ name: 'Corrected' })
})
test.each(['en', 'cs'] as const)('ref immutable conflict is localized, retains draft and permits corrected retry (%s)', async language => {
  const i18n = createI18n({ languages: ['en', 'cs'], profile: { language }, catalogs: {} })
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => {
    if (init.method !== 'PATCH') return json(row)
    const data = JSON.parse(String(init.body))
    return data.name === 'Locked' ? json({ error: 'ref_immutable', detail: { constraintId: 'probe.name_locked' } }, 409) : json({ ...row, ...data, version: 2 })
  })
  render(h(ConsoleProvider, { caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t: i18n.t, fetch }, h(PageView, { definition: route('edit'), route: route('edit'), entities: { probe: meta }, params: { itemId: 'x' }, search: {}, navigate })))
  const name = await screen.findByLabelText(i18n.t('domain:field.probe.name'))
  fireEvent.change(name, { target: { value: 'Locked' } }); fireEvent.click(screen.getByText(i18n.t('sdk:save')))
  const message = language === 'cs' ? 'Tento záznam používají jiné záznamy, proto už nelze tuto hodnotu změnit. Ponechte původní hodnotu a zkuste to znovu.' : 'This record is referenced by other records, so this value can no longer be changed. Keep the original value and try again.'
  expect(await screen.findByText(message)).toBeTruthy()
  expect(screen.queryByText(i18n.t('sdk:network'))).toBeNull()
  expect((name as unknown as { value: string }).value).toBe('Locked'); expect(navigate).not.toHaveBeenCalled()
  fireEvent.change(name, { target: { value: 'Corrected' } }); fireEvent.click(screen.getByText(i18n.t('sdk:save')))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/items/x'))
  expect(JSON.parse(String(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH').at(-1)![1].body))).toEqual({ name: 'Corrected' })
})
test('ref immutable code is bound to status 409 and does not widen other conflicts', () => {
  expect(failureState(new ApiFailure(409, 'ref_immutable'))).toEqual({ kind: 'refImmutable' })
  expect(failureState(new ApiFailure(422, 'ref_immutable'))).toEqual({ kind: 'network' })
  expect(failureState(new ApiFailure(409, 'constraint_conflict'))).toEqual({ kind: 'network' })
})
test('generic constraint_conflict retains the current network fallback', async () => {
  render(view(async (_url, init) => init.method === 'PATCH' ? json({ error: 'constraint_conflict' }, 409) : json(row), 'edit'))
  fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: 'Draft' } })
  fireEvent.click(screen.getByText('sdk:save'))
  expect(await screen.findByText('sdk:network')).toBeTruthy()
  expect((screen.getByLabelText('domain:field.probe.name') as unknown as { value: string }).value).toBe('Draft')
})

test('owned visual hooks preserve authored field and slot order without a host class', async () => {
  const definition = route('create', ['extra', { kind: 'slot', id: 'sentinel', props: {} }, 'name'])
  const { container } = render(h(ConsoleProvider, {
    caps: grants({ probe: meta }), identity: { actorId: 'a', orgId: 'one' }, t,
    slots: { sentinel: { contexts: ['record'], props: {}, component: () => h('button', { 'data-sentinel': true }, 'Authored') } },
  }, h(PageView, { definition, route: definition, entities: { probe: meta }, params: {}, search: {}, navigate })))
  const dom = container as unknown as { querySelector(selector: string): { classList: { contains(value: string): boolean } } | null; querySelectorAll(selector: string): { textContent: string | null; getAttribute(name: string): string | null }[] }
  expect(dom.querySelector('.wb-page')).toBeTruthy()
  expect(dom.querySelector('.wb-panel.wb-form')).toBeTruthy()
  const fields = [...dom.querySelectorAll('.wb-field label')].map(node => node.textContent)
  expect(fields).toEqual(['domain:field.probe.extra', 'domain:field.probe.name'])
  expect([...dom.querySelectorAll('form input, form [data-sentinel]')].map(node => node.getAttribute('aria-label') ?? node.textContent)).toEqual(['domain:field.probe.extra', 'Authored', 'domain:field.probe.name'])
  expect(dom.querySelector('[data-sentinel]')?.classList.contains('wb-control')).toBe(false)
  expect([...dom.querySelectorAll('.wb-actions button')].map(node => node.textContent)).toEqual(['sdk:save', 'sdk:back', 'sdk:cancel'])
})
