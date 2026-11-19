import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import { changeSavedViews, clearSavedViews, loadSavedViews, savedViewsKey, type SavedViewsScope } from '../../console-generated/src/saved-views'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
const scope: SavedViewsScope = { instance: 'saved-test', userId: 'verified', orgId: 'org' }
const model: Model = { instance: scope.instance, revision: 1, limits: { root: 100, children: 100, relations: 4, exists: 4 }, entities: { entries: { fields: { id: { type: 'string' }, name: { type: 'string' }, created: { type: 'datetime' } }, columns: ['name', 'created'], relations: {}, routes: { list: '/entries', detail: '/entries/:id' } } } }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: ['id', 'name', 'created'], writable: [], operations: ['read'] } } }
function storage() { const values = new Map<string, string>(); return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } } }
let store: ReturnType<typeof storage>
const clients: QueryClient[] = []
beforeEach(() => { store = storage(); vi.stubGlobal('localStorage', store); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(language: 'en' | 'cs' = 'en', initialScope: SavedViewsScope | null = scope, embedded = false) {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { [language]: { translation: language === 'cs' ? cs : en } } })
  const request = vi.fn(async (query: ReadQuery) => ({ data: [{ id: query.offset || query.cursor ? 'second' : 'first', name: 'Entry', created: '2026-11-17T00:00:00Z' }], next_cursor: query.cursor ? null : 'next-opaque', total: 100, offset: query.offset, limit: query.limit }))
  let update!: (value: { scope?: SavedViewsScope; caps: Capabilities }) => void
  function Fixture() {
    const [context, setContext] = useState<{ scope?: SavedViewsScope; caps: Capabilities }>({ scope: initialScope ?? undefined, caps }); update = setContext
    return <GeneratedReadPage model={model} caps={context.caps} orgId="org" entity="entries" request={request} savedViewsScope={context.scope} contextList={embedded ? { entity: 'parents', id: 'parent', list: 'entries' } : undefined} />
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
async function navigate(router: Awaited<ReturnType<typeof mount>>['router'], search: Record<string, unknown>) {
  await act(async () => { await router.navigate({ to: '/o/$orgId/e/$entity', params: { orgId: 'org', entity: 'entries' }, search: search as any }) })
}
it.each(['en', 'cs'] as const)('%s saves, applies at page one, renames, updates and deletes with accessible focus', async language => {
  const copy = language === 'cs' ? cs : en
  const { router, request, user } = await mount(language)
  expect(screen.getByText(copy.savedViewsBrowserOnly)).toBeTruthy()
  await navigate(router, { filters: [{ field: 'name', predicate: { contains: 'Saved' } }], sort: 'created', direction: 'desc', view: 'all', search: 'omit text', pageSize: 50 })
  await user.click(screen.getByRole('button', { name: copy.savedViewsSave }))
  const input = screen.getByRole('textbox', { name: copy.savedViewsName }); expect(document.activeElement).toBe(input)
  await user.type(input, '  My view  '); await user.click(screen.getByRole('button', { name: copy.savedViewsConfirm }))
  const select = screen.getByRole('combobox', { name: copy.savedViews })
  expect(document.activeElement).toBe(select)
  expect(loadSavedViews(scope, 'entries').entries[0]).toMatchObject({ name: 'My view', search: { view: 'all', sort: 'created', direction: 'desc', filters: [{ field: 'name', predicate: { contains: 'Saved' } }] } })
  expect(loadSavedViews(scope, 'entries').entries[0].search.search).toBeUndefined()
  await user.click(screen.getByRole('button', { name: copy.savedViewsRename }))
  await user.clear(screen.getByRole('textbox', { name: copy.savedViewsName })); await user.type(screen.getByRole('textbox', { name: copy.savedViewsName }), 'Renamed')
  await user.click(screen.getByRole('button', { name: copy.savedViewsConfirm }))
  expect(screen.getByRole('option', { name: 'Renamed' })).toBeTruthy()
  await navigate(router, { sort: 'none' })
  await waitFor(() => expect(screen.getByRole('button', { name: copy.nextPage }).hasAttribute('disabled')).toBe(false))
  await user.click(screen.getByRole('button', { name: copy.nextPage }))
  await waitFor(() => expect(request.mock.lastCall?.[0].offset).toBe(30))
  await user.click(screen.getByRole('button', { name: copy.savedViewsApply }))
  await waitFor(() => expect(request.mock.lastCall?.[0]).toMatchObject({ limit: 30, orderBy: [{ field: 'created', dir: 'desc' }], where: { and: [{ name: { contains: 'Saved' } }] } }))
  expect(request.mock.lastCall?.[0].cursor).toBeUndefined()
  expect(router.state.location.search).toMatchObject({ sort: 'created', direction: 'desc', view: 'all', pageSize: 30 })
  expect((router.state.location.state as any).generatedList.cursors).toEqual([])
  expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('1')
  await navigate(router, { sort: 'none', view: 'all' })
  await user.click(screen.getByRole('button', { name: copy.savedViewsUpdate }))
  expect(loadSavedViews(scope, 'entries').entries[0].search).toMatchObject({ sort: 'none', view: 'all' })
  expect(loadSavedViews(scope, 'entries').entries[0].search.filters).toBeUndefined()
  await user.click(screen.getByRole('button', { name: copy.savedViewsDelete }))
  expect(loadSavedViews(scope, 'entries').entries).toEqual([])
  expect(document.activeElement).toBe(screen.getByRole('button', { name: copy.savedViewsSave }))
})
it('revalidates saved settings against reduced capabilities and retains listStateDropped', async () => {
  const { user, router, update } = await mount()
  await navigate(router, { filters: [{ field: 'name', predicate: { contains: 'Private' } }], sort: 'created', direction: 'desc' })
  await user.click(screen.getByRole('button', { name: en.savedViewsSave })); await user.type(screen.getByRole('textbox', { name: en.savedViewsName }), 'Mine'); await user.click(screen.getByRole('button', { name: en.savedViewsConfirm }))
  const reduced: Capabilities = { ...caps, entities: { entries: { ...caps.entities.entries, readable: ['id'] } } }
  await act(async () => update({ scope, caps: reduced }))
  await user.click(screen.getByRole('button', { name: en.savedViewsApply }))
  await waitFor(() => expect(router.state.location.search.sort).toBe('none'))
  expect(router.state.location.search.filters).toBeUndefined()
  expect(await screen.findByText(en.listStateDropped)).toBeTruthy()
  expect((router.state.location.state as any).generatedList).toMatchObject({ cursors: [], notice: 'listStateDropped' })
  // Revalidation does not rewrite the stored personal view.
  expect(loadSavedViews(scope, 'entries').entries[0].search.sort).toBe('created')
})
it('hides the feature without verified scope and resets mounted state on scope replacement', async () => {
  const { user, update } = await mount('en', null)
  expect(screen.queryByRole('button', { name: en.savedViewsSave })).toBeNull()
  expect(store.getItem).not.toHaveBeenCalled()
  await act(async () => update({ scope, caps }))
  await user.click(screen.getByRole('button', { name: en.savedViewsSave })); await user.type(screen.getByRole('textbox', { name: en.savedViewsName }), 'Unsubmitted')
  await act(async () => update({ scope: { ...scope, userId: 'other' }, caps }))
  expect(screen.queryByRole('textbox', { name: en.savedViewsName })).toBeNull()
  expect(store.setItem).not.toHaveBeenCalled()
  expect(screen.getByRole('combobox', { name: en.savedViews }).textContent).not.toContain('Unsubmitted')
})
it('never shows controls or reads a namespace for embedded lists', async () => {
  await mount('en', scope, true)
  expect(screen.queryByRole('button', { name: en.savedViewsSave })).toBeNull()
  expect(store.getItem).not.toHaveBeenCalled()
})
it('storage events refresh the catalogue without navigation; reload and back/forward keep URL authoritative', async () => {
  const { router, history, user, view } = await mount()
  const saved = changeSavedViews(scope, 'entries', { kind: 'save', name: 'Other tab', state: { search: '', sort: { key: 'created', direction: 'desc' }, userFilters: [], presetFilters: [], limit: 30 } }).entries[0]
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  expect(screen.getByRole('option', { name: 'Other tab' })).toBeTruthy()
  expect(router.state.location.search.sort).toBeUndefined()
  await user.selectOptions(screen.getByRole('combobox', { name: en.savedViews }), saved.id)
  await user.click(screen.getByRole('button', { name: en.savedViewsApply }))
  await waitFor(() => expect(router.state.location.search.sort).toBe('created'))
  await act(async () => { history.back() })
  await waitFor(() => expect(router.state.location.search.sort).toBeUndefined())
  await act(async () => { history.forward() })
  await waitFor(() => expect(router.state.location.search.sort).toBe('created'))
  await navigate(router, { sort: 'none' })
  store.removeItem(savedViewsKey(scope, 'entries'))
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  expect(screen.queryByRole('option', { name: 'Other tab' })).toBeNull()
  expect(router.state.location.search.sort).toBe('none')
  changeSavedViews(scope, 'entries', { kind: 'save', name: 'Persisted', state: { search: '', sort: null, userFilters: [], presetFilters: [], limit: 30 } })
  view.unmount()
  await mount()
  expect(screen.getByRole('option', { name: 'Persisted' })).toBeTruthy()
})
it('explicit cleanup invalidates open save callbacks before they can recreate storage', async () => {
  const { user } = await mount()
  await user.click(screen.getByRole('button', { name: en.savedViewsSave })); await user.type(screen.getByRole('textbox', { name: en.savedViewsName }), 'Late')
  await act(async () => clearSavedViews(scope))
  expect(screen.queryByRole('textbox', { name: en.savedViewsName })).toBeNull()
  await user.click(screen.getByRole('button', { name: en.savedViewsSave }))
  expect(store.setItem).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: en.savedViewsSave }).hasAttribute('disabled')).toBe(true)
})
it('reports quota and name failures visibly without claiming success', async () => {
  const { user } = await mount()
  await user.click(screen.getByRole('button', { name: en.savedViewsSave }))
  await user.click(screen.getByRole('button', { name: en.savedViewsConfirm }))
  expect(screen.getByRole('alert').textContent).toBe(en.savedViewsError_name)
  await user.type(screen.getByRole('textbox', { name: en.savedViewsName }), 'Quota')
  store.setItem.mockImplementation(() => { throw new Error('quota') })
  await user.click(screen.getByRole('button', { name: en.savedViewsConfirm }))
  expect(screen.getByRole('alert').textContent).toBe(en.savedViewsError_storage)
  expect(screen.queryByText(en.savedViewsChanged)).toBeNull()
})

it('over-limit and malformed storage report failure while the list stays usable', async () => {
  const { user, request } = await mount()
  const state = { search: '', sort: null, userFilters: [], presetFilters: [], limit: 30 }
  for (let i = 0; i < 20; i++) changeSavedViews(scope, 'entries', { kind: 'save', name: 'Existing ' + i, state })
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  await user.click(screen.getByRole('button', { name: en.savedViewsSave })); await user.type(screen.getByRole('textbox', { name: en.savedViewsName }), 'Overflow')
  await user.click(screen.getByRole('button', { name: en.savedViewsConfirm }))
  expect(screen.getByRole('alert').textContent).toBe(en.savedViewsError_limit)
  expect(loadSavedViews(scope, 'entries').entries).toHaveLength(20)
  store.setItem(savedViewsKey(scope, 'entries'), 'null')
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  expect(screen.getByRole('alert').textContent).toBe(en.savedViewsError_invalid)
  await user.click(screen.getByRole('button', { name: en.nextPage }))
  await waitFor(() => expect(request.mock.lastCall?.[0].offset).toBe(30))
})
