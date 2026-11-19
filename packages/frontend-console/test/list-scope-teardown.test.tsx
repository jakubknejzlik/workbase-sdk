import { Profiler, useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useParams } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { ReferenceAuthority } from '../../console-generated/src/reference-authority'
import { validateListSearch } from '../../console-generated/src/list-model'
import { changeSavedViews } from '../../console-generated/src/saved-views'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import { applyView, viewsTrigger } from './saved-views-menu'

const model: Model = { instance: 'teardown', revision: 1, limits: { root: 100, maxOffset: 100, children: 20, relations: 4, exists: 4 }, entities: {
  entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active', 'inactive'] } }, columns: ['name', 'status'], relations: {}, routes: { list: '', detail: '' },
    list: { pageSize: 10, columns: [{ field: 'name' }, { field: 'status' }], filter: { status: { kind: 'enum', placement: 'panel', operators: ['in'] } }, views: [{ id: 'active', label: 'Active view', where: { status: { eq: 'active' } } }] } },
} }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: Object.keys(model.entities.entries.fields), writable: [], operations: ['read'] } } }
let client: QueryClient
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } })
})
afterEach(() => { client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
// Row text, totals and counts identify exactly which scope produced them.
const totals: Record<string, number> = { 'A@org': 71, 'B@org': 12, 'A@other': 33 }
async function mount(options: { actor?: string; search?: Record<string, unknown> } = {}) {
  const world = { actor: options.actor, org: 'org' }; let gate: Promise<void> | undefined, release: (() => void) | undefined
  const owner = () => `${world.actor ?? 'anon'}@${world.org}`
  const request = vi.fn(async (query: ReadQuery) => {
    const who = owner(); await gate
    const total = totals[who] ?? 5
    return { data: [{ id: '1', name: `Row of ${who}`, status: 'active' }], next_cursor: null, offset: query.offset, limit: query.limit, total, viewTotals: { all: total, active: total - 1 } }
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const snapshots: { scope: string; text: string }[] = []; const current = { scope: '' }
  let update!: (value: { actor: string | undefined; org: string }) => void
  function Fixture() {
    const [context, setContext] = useState({ actor: options.actor, org: 'org' }); update = setContext
    // As in the console, the org comes from the route, so location and org change in one transition.
    const org = useParams({ strict: false }).orgId ?? context.org
    current.scope = `${context.actor ?? 'anon'}@${org}`
    return <Profiler id="list" onRender={() => { snapshots.push({ scope: current.scope, text: document.body.textContent ?? '' }) }}>
      <ReferenceAuthority.Provider value={{ actor: context.actor, observedAt: 1 }}>
        <GeneratedReadPage model={model} caps={caps} orgId={org} entity="entries" request={request} savedViewsScope={context.actor ? { instance: model.instance, userId: context.actor, orgId: org } : undefined} />
      </ReferenceAuthority.Provider>
    </Profiler>
  }
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: Fixture })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) }); await router.load()
  if (options.search) await router.navigate({ to: '.', search: options.search as any })
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', field_status: 'Status', value_active: 'Active', value_inactive: 'Inactive' } } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await screen.findByText(`Row of ${owner()}`)
  return { request, router, snapshots, user: userEvent.setup(), world,
    hold: () => { gate = new Promise(resolve => { release = resolve }) }, release: async () => { await act(async () => { release?.(); gate = undefined }) },
    switchTo: async (next: { actor?: string; org?: string }) => { Object.assign(world, { ...(next.org ? { org: next.org } : {}), actor: 'actor' in next ? next.actor : world.actor }); await act(async () => update({ actor: world.actor, org: world.org })) } }
}
// Commits made while the new scope is current (the route/actor already changed) must contain nothing of the old one.
const stale = (snapshots: { scope: string; text: string }[], previous: string, scope = '') => snapshots.filter(snapshot => (!scope || snapshot.scope === scope) && snapshot.text.includes(previous)).map(snapshot => snapshot.text)

it('replaces the actor with identical capabilities without any render of the previous actor, and discards state, draft, selection and cache', async () => {
  const test = await mount({ actor: 'A' })
  changeSavedViews({ instance: model.instance, userId: 'A', orgId: 'org' }, 'entries', { kind: 'save', name: 'Mine', state: { search: '', sort: null, userFilters: [], presetFilters: [], limit: 30 } })
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: null })))
  await applyView(test.user, 'Mine')
  await waitFor(() => expect(viewsTrigger().textContent).toContain('Mine'))
  await act(async () => { await test.router.navigate({ to: '.', search: { view: 'active', filters: [{ field: 'status', predicate: { in: ['active'] } }], pageSize: 20 } as any }) })
  expect(await screen.findByRole('button', { name: /Remove.*Active/ })).toBeTruthy()
  await test.user.click(screen.getByText(en.sortAndFilter))
  await test.user.click(within(screen.getByRole('group', { name: en.sortAndFilter })).getByRole('checkbox', { name: 'Inactive' }))
  expect(screen.getByText(/of 71/)).toBeTruthy()
  const before = test.request.mock.calls.length
  test.hold(); test.snapshots.length = 0
  await test.switchTo({ actor: 'B' })
  // Nothing of A at any committed render, including while B's reads are still pending.
  await waitFor(() => expect(test.request.mock.calls.length).toBeGreaterThan(before))
  expect(stale(test.snapshots, 'Row of A@org', 'B@org')).toEqual([]); expect(stale(test.snapshots, '71', 'B@org')).toEqual([])
  expect(test.snapshots.some(snapshot => snapshot.scope === 'B@org')).toBe(true)
  expect(screen.queryByText('Row of A@org')).toBeNull(); expect(screen.queryByText(/of 71/)).toBeNull(); expect(screen.queryByRole('button', { name: /Active view.*70/ })).toBeNull()
  // Confirmed state, draft, saved-view selection are gone; B's first reads carry none of A's conditions.
  await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
  expect(test.router.state.location.search.view).toBeUndefined(); expect(test.router.state.location.search.pageSize).toBeUndefined()
  expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  expect(screen.queryByRole('group', { name: en.sortAndFilter })).toBeNull()
  expect(viewsTrigger().textContent).toBe(en.savedViewsMenu)
  for (const [query] of test.request.mock.calls.slice(before)) { expect(query.where).toBeUndefined(); expect(query.view).toBeUndefined(); expect(query.limit).toBe(10) }
  await test.release()
  expect(await screen.findByText('Row of B@org')).toBeTruthy(); expect(screen.getByText(/1.*10.*12/)).toBeTruthy()
  expect(stale(test.snapshots, 'Row of A@org', 'B@org')).toEqual([])
  // A's cached rows, counts and totals were removed rather than kept for a later switch back.
  expect(client.getQueryCache().findAll({ queryKey: ['data-table'] }).filter(query => (query.queryKey.at(-1) as string).includes('"A"'))).toEqual([])
  test.hold(); test.snapshots.length = 0
  await test.switchTo({ actor: 'A' })
  await waitFor(() => expect(test.request.mock.calls.length).toBeGreaterThan(before + 1))
  expect(stale(test.snapshots, 'Row of B@org', 'A@org')).toEqual([]); expect(screen.queryByText('Row of A@org')).toBeNull()
  await test.release(); expect(await screen.findByText('Row of A@org')).toBeTruthy()
})
it('replaces the org without presenting rows, counts or totals of the previous org', async () => {
  const test = await mount({ actor: 'A' })
  await test.user.click(screen.getByRole('button', { name: /Active view.*70/ }))
  await waitFor(() => expect(test.router.state.location.search.view).toBe('active'))
  test.hold(); test.snapshots.length = 0
  test.world.org = 'other'
  await act(async () => { await test.router.navigate({ to: '/o/$orgId/e/$entity', params: { orgId: 'other', entity: 'entries' } }) })
  await waitFor(() => expect(test.request.mock.calls.at(-1)).toBeTruthy())
  expect(test.snapshots.some(snapshot => snapshot.scope === 'A@other')).toBe(true)
  expect(stale(test.snapshots, 'Row of A@org', 'A@other')).toEqual([]); expect(stale(test.snapshots, '71', 'A@other')).toEqual([])
  expect(screen.queryByText(/of 71/)).toBeNull(); expect(screen.queryByRole('button', { name: /Active view.*70/ })).toBeNull()
  expect(test.router.state.location.search.view).toBeUndefined()
  await test.release(); expect(await screen.findByText('Row of A@other')).toBeTruthy()
  expect(screen.getByText(/1.*10.*33/)).toBeTruthy()
})
it('keeps a deep-linked state while the actor is only being established (unknown to known)', async () => {
  const test = await mount({ search: { view: 'active', filters: [{ field: 'status', predicate: { in: ['active'] } }] } })
  await test.switchTo({ actor: 'A' })
  expect(await screen.findByText('Row of A@org')).toBeTruthy()
  expect(test.router.state.location.search).toMatchObject({ view: 'active', filters: [{ field: 'status', predicate: { in: ['active'] } }] })
  expect(screen.getByRole('button', { name: /Remove.*Active/ })).toBeTruthy()
})
it('treats a transient unknown actor as no change, but unknown -> a different actor as a replacement', async () => {
  const test = await mount({ actor: 'A', search: { view: 'active' } })
  await test.switchTo({ actor: undefined })
  expect(await screen.findByText('Row of anon@org')).toBeTruthy()
  expect(test.router.state.location.search.view).toBe('active')
  await test.switchTo({ actor: 'A' })
  expect(await screen.findByText('Row of A@org')).toBeTruthy()
  expect(test.router.state.location.search.view).toBe('active')
  await test.switchTo({ actor: undefined })
  test.hold(); test.snapshots.length = 0
  await test.switchTo({ actor: 'B' })
  await waitFor(() => expect(test.router.state.location.search.view).toBeUndefined())
  expect(stale(test.snapshots, 'Row of A@org', 'B@org')).toEqual([])
  await test.release(); expect(await screen.findByText('Row of B@org')).toBeTruthy()
})
