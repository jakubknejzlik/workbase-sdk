import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { Model, Capabilities } from '../../console-generated/src/read'
import type { ConsolePage, ConsoleWidgetResult } from '../../plugins/console/src/contract'
import { WidgetCards } from '../src/dashboard'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

afterEach(() => { vi.restoreAllMocks() })
async function mount(options: { kind?: 'table' | 'list'; select?: string[]; id?: unknown; operations?: string[]; readable?: string[]; missingEntity?: boolean; language?: 'en' | 'cs'; referenceFirst?: boolean } = {}) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const entity = { displayField: 'name', fields: { id: { type: 'string' as const }, name: { type: 'string' as const }, reviewer: { type: 'ref' as const, entity: 'people' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } }
  const model: Model = { instance: 'widget-tests', revision: 1, limits: { root: 100, children: 20, relations: 4, exists: 4 }, entities: { ...(!options.missingEntity ? { entries: entity } : {}), people: entity } }
  const caps: Capabilities = { revision: 1, entities: { entries: { operations: options.operations ?? ['read'], readable: options.readable ?? ['id', 'name', 'reviewer'], writable: [] }, people: { operations: ['read'], readable: ['id', 'name'], writable: [] } } }
  const row = { id: 'entry /α', name: 'Alex Example', reviewer: 'reviewer', __labels: { reviewer: { status: 'ok', entity: 'people', row: { id: 'reviewer', name: 'Sam Example' } } } }
  if (Object.hasOwn(options, 'id')) Object.assign(row, { id: options.id })
  const kind = options.kind ?? 'table'
  const columns = options.referenceFirst ? ['reviewer', 'name'] : ['name', 'reviewer']
  const query = { entity: 'entries', select: options.select ?? ['id', 'name', 'reviewer'], labels: ['reviewer'], limit: 5 }
  const page: ConsolePage = { id: 'summary', path: '/summary', label: 'Summary', widgets: [kind === 'table' ? { id: 'records', label: 'Records', kind, query, columns } : { id: 'records', label: 'Records', kind, query, field: 'name' }] }
  const widget: ConsoleWidgetResult = kind === 'table' ? { id: 'records', label: 'Records', kind, columns, data: [row] } : { id: 'records', label: 'Records', kind, field: 'name', data: [row] }
  const root = createRootRoute()
  const dashboard = createRoute({ getParentRoute: () => root, path: '/summary', component: () => <WidgetCards orgId="org /α" page={page} result={{ id: page.id, label: page.label, widgets: [widget] }} pending={false} error={null} model={model} caps={caps} /> })
  const detail = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity/$id', component: () => <h1>Record detail</h1> })
  const router = createRouter({ routeTree: root.addChildren([dashboard, detail]), history: createMemoryHistory({ initialEntries: ['/summary'] }) })
  await router.load()
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: options.language ?? 'en', resources: { en: { translation: en }, cs: { translation: cs } } })
  const rendered = render(<I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider>)
  await screen.findAllByText('Alex Example')
  return { ...rendered, router, user: userEvent.setup() }
}

it.each(['table', 'list'] as const)('links the permitted primary %s value using the console detail route and accessible name', async kind => {
  const { container } = await mount({ kind })
  const links = screen.getAllByRole('link', { name: 'Alex Example' })
  expect(links).toHaveLength(1)
  for (const link of links) expect(link.getAttribute('href')).toBe('/o/org%20%2F%CE%B1/e/entries/entry%20%2F%CE%B1')
  expect(container.querySelector('a a')).toBeNull()
})

it.each(['table', 'list'] as const)('allows Tab and Enter to open the %s primary record', async kind => {
  const { user, router } = await mount({ kind })
  await user.tab()
  expect(document.activeElement).toBe(screen.getAllByRole('link', { name: 'Alex Example' })[0])
  await user.keyboard('{Enter}')
  await screen.findByRole('heading', { name: 'Record detail' })
  expect(router.state.matches.at(-1)?.params).toEqual({ orgId: 'org /α', entity: 'entries', id: 'entry /α' })
})

for (const kind of ['table', 'list'] as const) it.each([
  { operations: [] }, { operations: ['update'] }, { readable: ['name', 'reviewer'] }, { missingEntity: true },
  { select: ['name', 'reviewer'] }, { id: undefined }, { id: null }, { id: '' },
])(`keeps ${kind} text without a dead primary link: %j`, async options => {
  await mount({ ...options, kind })
  expect(screen.queryByRole('link', { name: 'Alex Example' })).toBeNull()
})

it.each([false, true])('preserves reference-label destinations and avoids nested links (reference first: %s)', async referenceFirst => {
  const { container } = await mount({ referenceFirst })
  const links = screen.getAllByRole('link', { name: 'Sam Example' })
  expect(links).toHaveLength(1)
  for (const link of links) expect(link.getAttribute('href')).toBe('/o/org%20%2F%CE%B1/e/people/reviewer')
  expect(screen.getAllByRole('link', { name: 'Alex Example' })).toHaveLength(1)
  expect(within(container.querySelector('tbody')!).getAllByRole('link')).toHaveLength(2)
  expect(container.querySelector('a a')).toBeNull()
})

it('retains reference links when the primary detail is denied', async () => {
  await mount({ operations: [] })
  expect(screen.queryByRole('link', { name: 'Alex Example' })).toBeNull()
  expect(screen.getAllByRole('link', { name: 'Sam Example' })).toHaveLength(1)
})

it('retains the same primary accessible name in Czech', async () => {
  await mount({ kind: 'list', language: 'cs' })
  await waitFor(() => expect(screen.getByRole('link', { name: 'Alex Example' })).toBeTruthy())
})

// Exercise WidgetPage with a stale caller page and independently refreshed authority.
// This catches cached-result links surviving a projection-only permission change.
vi.mock('../src/dashboard-actions', () => ({ DashboardActions: ({ children }: { children: (slots: object) => unknown }) => children({}) }))
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { WidgetPage } from '../src/dashboard'
import * as runtimeModel from '../src/api/runtime-model'
import * as client from '../src/api/client'
import { validateListSearch } from '../../console-generated/src/list-model'

async function mountTarget(options: { kind?: 'stat' | 'table' | 'list'; language?: 'en' | 'cs'; view?: string; value?: number | null; empty?: boolean; failed?: boolean; missing?: boolean; denied?: boolean } = {}) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const kind = options.kind ?? 'stat'
  const query = { entity: 'entries', where: { status: { eq: 'pending' } }, select: ['id', 'name'], limit: 5 }
  const configured = { id: 'records', label: 'Records', kind, query, drilldown: { view: options.view ?? 'attention' },
    ...(kind === 'stat' ? { aggregate: { fn: 'count' } } : kind === 'table' ? { columns: ['name'] } : { field: 'name' }) }
  const page = { id: 'summary', path: '/summary', label: 'Summary', widgets: [configured] } as ConsolePage
  const model: Model = { instance: 'target-tests', revision: 1, limits: { root: 100, children: 20, relations: 4, exists: 4 }, entities: {
    entries: { fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' },
      list: { views: [{ id: 'attention', label: 'Attention', where: { status: { eq: 'pending' } } }, { id: 'all', label: 'All', where: {} }] } },
  } }
  const caps: Capabilities = { revision: 1, entities: { entries: { operations: ['read'], readable: ['id', 'name', 'status'], writable: [] } } }
  let authority = { data: { model, capabilities: caps, console: { pages: [page] } }, error: null as Error | null, isFetching: false }
  const listeners = new Set<() => void>()
  const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } }
  vi.spyOn(runtimeModel, 'useRuntimeModel').mockImplementation(() => useSyncExternalStore(subscribe, () => authority) as unknown as ReturnType<typeof runtimeModel.useRuntimeModel>)
  const widget = options.failed ? { id: 'records', label: 'Records', kind: 'error', code: 'query_failed' } : {
    id: 'records', label: 'Records', kind, ...(kind === 'stat' ? options.missing ? {} : { value: options.value === undefined ? 7 : options.value }
      : { data: options.empty ? [] : [{ id: 'entry', name: 'Matching entry' }], ...(kind === 'table' ? { columns: ['name'] } : { field: 'name' }) }),
  }
  vi.spyOn(client, 'api').mockResolvedValue({ id: page.id, label: page.label, widgets: options.denied ? [] : [widget] })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const root = createRootRoute()
  const dashboard = createRoute({ getParentRoute: () => root, path: '/summary', component: () => <WidgetPage orgId="org /α" page={page} /> })
  const list = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <h1>Matching list</h1> })
  const router = createRouter({ routeTree: root.addChildren([dashboard, list]), history: createMemoryHistory({ initialEntries: ['/summary?search=stale&page=9'] }) })
  await router.load()
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: options.language ?? 'en', resources: { en: { translation: en }, cs: { translation: cs } } })
  const tree = () => <QueryClientProvider client={cache}><I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider></QueryClientProvider>
  const rendered = render(tree())
  await waitFor(() => expect(cache.getQueryData(['console-page', 'org /α', page.id, caps])).toBeTruthy())
  const refresh = async (change: (current: typeof authority) => typeof authority) => {
    await act(async () => { authority = change(authority); listeners.forEach(notify => notify()) })
  }
  return { ...rendered, router, cache, user: userEvent.setup(), refresh }
}

it.each(['stat', 'table', 'list'] as const)('opens the named view at page one in the encoded current org from a %s', async kind => {
  const { user, router } = await mountTarget({ kind })
  const link = await screen.findByRole('link', { name: 'View matching records' })
  expect(link.getAttribute('href')).toBe('/o/org%20%2F%CE%B1/e/entries?view=attention&page=1')
  // Native keyboard traversal and router history, without inheriting dashboard search.
  for (let step = 0; step < 5 && document.activeElement !== link; step++) await user.tab()
  expect(document.activeElement).toBe(link)
  await user.keyboard('{Enter}')
  await screen.findByRole('heading', { name: 'Matching list' })
  expect(router.state.matches.at(-1)?.params).toEqual({ orgId: 'org /α', entity: 'entries' })
  expect(router.state.location.search).toEqual({ view: 'attention', page: 1 })
  await act(async () => { router.history.back() })
  await screen.findByRole('link', { name: 'View matching records' })
  expect(router.state.location.pathname).toBe('/summary')
})

it('uses the Czech shared link text', async () => {
  await mountTarget({ language: 'cs' })
  expect(await screen.findByRole('link', { name: 'Zobrazit odpovídající záznamy' })).toBeTruthy()
})
it.each(['stat', 'table', 'list'] as const)('keeps zero or an empty %s linked to its authorized view', async kind => {
  await mountTarget({ kind, value: 0, empty: true })
  expect(await screen.findByRole('link', { name: 'View matching records' })).toBeTruthy()
  expect(screen.getByText(kind === 'stat' ? '0' : en.dashboardEmpty, { exact: true })).toBeTruthy()
})
for (const options of [{ value: null }, { missing: true }, { failed: true }, { denied: true }]) it(`does not link missing/error/denied results: ${JSON.stringify(options)}`, async () => {
  await mountTarget(options)
  expect(screen.queryByRole('link', { name: 'View matching records' })).toBeNull()
  expect(screen.queryByText('0', { exact: true })).toBeNull()
})
it.each(['unknown', 'https://example.test/o/other', 'attention?orgId=other'])('omits unsupported destinations: %s', async view => {
  await mountTarget({ view })
  expect(screen.queryByRole('link', { name: 'View matching records' })).toBeNull()
})
it('links an explicit all view but never invents implicit all', async () => {
  const { refresh } = await mountTarget({ view: 'all' })
  expect(await screen.findByRole('link', { name: 'View matching records' })).toBeTruthy()
  await refresh(current => ({ ...current, data: { ...current.data, model: { ...current.data.model, entities: { entries: { ...current.data.model.entities.entries, list: { views: [] } } } } } }))
  expect(screen.queryByRole('link', { name: 'View matching records' })).toBeNull()
})
it.each(['descriptor', 'page', 'entity', 'field', 'view', 'refresh', 'error'] as const)('removes cached clickable targets after %s authority changes', async change => {
  const { refresh, cache } = await mountTarget()
  expect(await screen.findByRole('link', { name: 'View matching records' })).toBeTruthy()
  await refresh(current => {
    if (change === 'refresh') return { ...current, isFetching: true }
    if (change === 'error') return { ...current, error: new Error('Denied') }
    if (change === 'page') return { ...current, data: { ...current.data, console: { pages: [] } } }
    if (change === 'descriptor') return { ...current, data: { ...current.data, console: { pages: [{ ...current.data.console.pages[0], widgets: current.data.console.pages[0].widgets!.map(widget => ({ ...widget, drilldown: undefined })) }] } } }
    if (change === 'view') return { ...current, data: { ...current.data, model: { ...current.data.model, entities: { entries: { ...current.data.model.entities.entries, list: { views: [] } } } } } }
    return { ...current, data: { ...current.data, capabilities: { ...current.data.capabilities, entities: { entries: { operations: change === 'entity' ? [] : ['read'], readable: change === 'field' ? ['id', 'name'] : ['id', 'name', 'status'], writable: [] } } } } }
  })
  expect(screen.queryByRole('link', { name: 'View matching records' })).toBeNull()
  expect(cache.getQueriesData({ queryKey: ['console-page'] }).some(([, data]) => !!data)).toBe(true)
})
