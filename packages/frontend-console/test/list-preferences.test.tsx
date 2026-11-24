import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import type { SavedViewsScope } from '../../console-generated/src/saved-views'
import { clearListPreferences, listPreferencesKey } from '../../console-generated/src/list-preferences'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
const scope: SavedViewsScope = { instance: 'saved-test', userId: 'verified', orgId: 'org' }
const model: Model = { instance: scope.instance, revision: 1, limits: { root: 100, children: 100, relations: 4, exists: 4 }, entities: { entries: { fields: { id: { type: 'string' }, name: { type: 'string' }, created: { type: 'datetime' } }, columns: ['name', 'created'], list: { columns: [{ field: 'name', defaultVisible: false }, { field: 'created' }, { field: 'id', defaultVisible: false }], compact: false, views: [{ id: 'all', label: 'All', where: {} }] }, relations: {}, routes: { list: '/entries', detail: '/entries/:id' } } } }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: ['id', 'name', 'created'], writable: [], operations: ['read'] } } }
function storage() { const values = new Map<string, string>(); return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } } }
let store: ReturnType<typeof storage>
const clients: QueryClient[] = []
beforeEach(() => { store = storage(); vi.stubGlobal('localStorage', store); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { clearListPreferences(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(language: 'en' | 'cs' = 'en', initialScope: SavedViewsScope | null = scope, embedded = false) {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { [language]: { translation: language === 'cs' ? cs : en } } })
  const request = vi.fn(async (query: ReadQuery) => ({ data: [{ id: query.offset || query.cursor ? 'second' : 'first', name: 'Entry', created: '2026-11-17T00:00:00Z' }], next_cursor: query.cursor ? null : 'next-opaque', total: 100, viewTotals: { all: 100 }, offset: query.offset, limit: query.limit }))
  let update!: (value: { scope?: SavedViewsScope; caps: Capabilities; model?: Model }) => void
  function Fixture() {
    const [context, setContext] = useState<{ scope?: SavedViewsScope; caps: Capabilities; model?: Model }>({ scope: initialScope ?? undefined, caps }); update = setContext
    return <GeneratedReadPage model={context.model ?? model} caps={context.caps} orgId={context.scope?.orgId ?? "org"} entity="entries" request={request} savedViewsScope={context.scope} contextList={embedded ? { entity: 'parents', id: 'parent', list: 'entries' } : undefined} />
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const route = createRootRoute()
  const listRoute = createRoute({ getParentRoute: () => route, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: Fixture })
  const history = createMemoryHistory({ initialEntries: ['/o/org/e/entries'] })
  const router = createRouter({ routeTree: route.addChildren([listRoute]), history })
  await router.load()
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await waitFor(() => expect(request).toHaveBeenCalled())
  return { router, history, request, view, update, user: userEvent.setup() }
}
async function menu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: en.listDisplay }))
  return screen.findByRole('dialog', { name: en.listDisplayHeading })
}
const column = (name: string) => screen.queryAllByRole('columnheader', { hidden: true }).find(header => header.textContent?.includes(name)) ?? null
it('reuses the menu, persists across remount/reload, resets defaults, and never changes requests, counts, URL or D7', async () => {
  const { user, request, router, view } = await mount()
  await waitFor(() => expect(screen.getByText('Entry')).toBeTruthy())
  const before = structuredClone(request.mock.calls), url = router.state.location.href
  expect(column(en.field_name)).toBeTruthy(); expect(column(en.field_id)).toBeNull()
  const dialog = await menu(user)
  expect(within(dialog).queryByRole('checkbox', { name: en.field_name })).toBeNull() // Primary stays outside the toggle list.
  await user.click(within(dialog).getByRole('checkbox', { name: 'field_created' }))
  await user.click(within(dialog).getByRole('checkbox', { name: en.listDisplayCompact }))
  expect(column('field_created')).toBeNull()
  expect(JSON.parse(store.getItem(listPreferencesKey(scope, 'entries'))!)).toEqual({ visible: ['name'], density: 'compact' })
  expect(request.mock.calls).toEqual(before); expect(router.state.location.href).toBe(url)
  expect(within(screen.getByRole('group', { name: en.listViews, hidden: true })).getByText('100')).toBeTruthy()
  expect(screen.getByText(en.listRangeTotal.replace('{{start}}', '1').replace('{{end}}', '30').replace('{{total}}', '100'))).toBeTruthy()
  expect(store.getItem('workbase:saved-views:v1:saved-test:verified:org:entries')).toBeNull()
  view.unmount()
  const again = await mount()
  expect(column('field_created')).toBeNull()
  const reopened = await menu(again.user)
  expect(within(reopened).getByRole('checkbox', { name: en.listDisplayCompact }).getAttribute('aria-checked')).toBe('true')
  await again.user.click(within(reopened).getByRole('button', { name: en.listDisplayReset }))
  expect(column('field_created')).toBeTruthy(); expect(column(en.field_id)).toBeNull()
  expect(within(reopened).getByRole('checkbox', { name: en.listDisplayCompact }).getAttribute('aria-checked')).toBe('false')
  expect(store.getItem(listPreferencesKey(scope, 'entries'))).toBeNull()
})
it('revalidates stored configuration/capabilities, discards unknown IDs, and forces the current primary visible', async () => {
  store.setItem(listPreferencesKey(scope, 'entries'), JSON.stringify({ visible: ['created', 'removed'], density: 'compact' }))
  const { update } = await mount()
  expect(column(en.field_name)).toBeTruthy(); expect(column('field_created')).toBeTruthy()
  await act(async () => update({ scope, caps: { ...caps, entities: { entries: { ...caps.entities.entries, readable: ['id', 'name'] } } } }))
  expect(column('field_created')).toBeNull()
  expect(JSON.parse(store.getItem(listPreferencesKey(scope, 'entries'))!).visible).toEqual(['name'])
  const changed = { ...model, entities: { entries: { ...model.entities.entries, list: { columns: [{ field: 'id', defaultVisible: false }, { field: 'name' }] } } } }
  await act(async () => update({ scope, caps, model: changed }))
  expect(column(en.field_id)).toBeTruthy()
  expect(JSON.parse(store.getItem(listPreferencesKey(scope, 'entries'))!).visible).toEqual(['id', 'name'])
})
it('never accesses storage without a matching verified scope, or for embedded lists; account changes do not carry preferences', async () => {
  const { user, update } = await mount('en', null)
  expect(store.getItem).not.toHaveBeenCalled()
  const dialog = await menu(user)
  await user.click(within(dialog).getByRole('checkbox', { name: 'field_created' }))
  expect(store.setItem).not.toHaveBeenCalled()
  await act(async () => update({ scope, caps }))
  expect(column('field_created')).toBeTruthy()
  await user.click(within(dialog).getByRole('checkbox', { name: 'field_created' }))
  await act(async () => update({ scope: { ...scope, userId: 'other' }, caps }))
  expect(column('field_created')).toBeTruthy()
  await act(async () => update({ scope: { ...scope, orgId: 'other' }, caps }))
  expect(column('field_created')).toBeTruthy()
  await act(async () => update({ scope: { ...scope, instance: 'unverified' }, caps }))
  const reads = store.getItem.mock.calls.length
  const currentMenu = await menu(user)
  await user.click(within(currentMenu).getByRole('checkbox', { name: 'field_created' }))
  expect(store.getItem.mock.calls).toHaveLength(reads)
})
it('falls back to memory across remount, then clears mounted and in-memory choices on explicit logout', async () => {
  store.getItem.mockImplementation(() => { throw new Error('denied') })
  store.setItem.mockImplementation(() => { throw new Error('quota') })
  const { user, view } = await mount()
  const dialog = await menu(user)
  await user.click(within(dialog).getByRole('checkbox', { name: 'field_created' }))
  view.unmount()
  const again = await mount()
  expect(column('field_created')).toBeNull()
  const reopened = await menu(again.user)
  await act(async () => clearListPreferences(scope))
  expect(column('field_created')).toBeTruthy()
  await again.user.click(within(reopened).getByRole('checkbox', { name: 'field_created' }))
  expect(column('field_created')).toBeTruthy() // Captured callbacks cannot resurrect the logged-out account.
  again.view.unmount()
  await mount()
  expect(column('field_created')).toBeTruthy()
})
it('does not read display storage for embedded lists', async () => {
  await mount('en', scope, true)
  expect(store.getItem).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: en.listDisplay })).toBeNull()
})
