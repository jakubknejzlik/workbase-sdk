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
import { changeSavedViews, clearSavedViews, loadSavedViews, savedViewsKey, type SavedViewsScope } from '../../console-generated/src/saved-views'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
import { applyView, openNaming, openViewsMenu, viewsRegion, viewsTrigger } from './saved-views-menu'
const scope: SavedViewsScope = { instance: 'saved-test', userId: 'verified', orgId: 'org' }
const model: Model = { instance: scope.instance, revision: 1, limits: { root: 100, children: 100, relations: 4, exists: 4 }, entities: { entries: { fields: { id: { type: 'string' }, name: { type: 'string' }, created: { type: 'datetime' } }, columns: ['name', 'created'], relations: {}, routes: { list: '/entries', detail: '/entries/:id' } } } }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: ['id', 'name', 'created'], writable: [], operations: ['read'] } } }
function storage() { const values = new Map<string, string>(); return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } } }
let store: ReturnType<typeof storage>
const clients: QueryClient[] = []
beforeEach(() => { store = storage(); vi.stubGlobal('localStorage', store); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
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
const saveAs = async (user: Awaited<ReturnType<typeof mount>>['user'], name: string, copy: typeof en | typeof cs = en) => {
  const dialog = await openNaming(user, 'savedViewsSaveNew', copy)
  const input = within(dialog).getByRole('textbox', { name: copy.savedViewsName }); expect(document.activeElement).toBe(input)
  await user.type(input, name); await user.click(within(dialog).getByRole('button', { name: copy.savedViewsConfirm }))
}
async function appliedView(user: Awaited<ReturnType<typeof mount>>['user'], name: string, copy: typeof en | typeof cs = en) {
  const menu = await openViewsMenu(user, copy)
  expect(within(menu).getByRole('button', { name })).toBeTruthy()
  for (const label of [copy.savedViewsSaveNew, copy.savedViewsRenameThis, copy.savedViewsDeleteThis, copy.savedViewsClose, copy.savedViewsApplyView]) expect(within(menu).getByRole('button', { name: label })).toBeTruthy()
  await user.click(within(menu).getByRole('button', { name: copy.savedViewsRenameThis }))
  const dialog = await screen.findByRole('dialog')
  expect((within(dialog).getByRole('textbox', { name: copy.savedViewsName }) as HTMLInputElement).value).toBe(name)
  await user.keyboard('{Escape}')
}
it.each(['en', 'cs'] as const)('%s distinguishes the applied Alpha from staged Beta and keeps management on Alpha', async language => {
  const copy = language === 'cs' ? cs : en
  const { router, user } = await mount(language)
  await navigate(router, { sort: 'name', direction: 'asc' })
  await saveAs(user, 'Alpha', copy)
  await navigate(router, { sort: 'created', direction: 'desc' })
  await saveAs(user, 'Beta', copy)
  await applyView(user, 'Alpha', copy)
  await waitFor(() => expect(router.state.location.search.sort).toBe('name'))
  const menu = await openViewsMenu(user, copy)
  await user.click(within(menu).getByRole('button', { name: 'Beta' }))
  await user.keyboard('{Escape}')
  const reopened = await openViewsMenu(user, copy)
  expect(within(reopened).getByText(language === 'cs' ? 'Použitý pohled: Alpha' : 'Applied view: Alpha')).toBeTruthy()
  expect(within(reopened).getByRole('button', { name: 'Alpha', current: true }).getAttribute('aria-pressed')).toBe('false')
  expect(within(reopened).getByRole('button', { name: 'Beta', pressed: true }).hasAttribute('aria-current')).toBe(false)
  expect(router.state.location.search.sort).toBe('name')
  await user.click(within(reopened).getByRole('button', { name: copy.savedViewsRenameThis }))
  expect((screen.getByRole('textbox', { name: copy.savedViewsName }) as HTMLInputElement).value).toBe('Alpha')
  await user.keyboard('{Escape}')
  await navigate(router, { sort: 'name', direction: 'desc' })
  await user.click(within(viewsRegion(copy)).getByRole('button', { name: copy.savedViewsSaveChanges }))
  const saving = await screen.findByRole('dialog')
  expect((within(saving).getByRole('textbox', { name: copy.savedViewsName }) as HTMLInputElement).value).toBe('Alpha')
  expect(within(saving).getByRole('checkbox', { name: copy.savedViewsUpdateCurrent }).getAttribute('aria-checked')).toBe('true')
  await user.keyboard('{Escape}')
  const deleting = await openNaming(user, 'savedViewsDeleteThis', copy)
  expect(within(deleting).getByText(copy.savedViewsDeleteBody.replace('{{name}}', 'Alpha'))).toBeTruthy()
})
it.each(['en', 'cs'] as const)('%s icon keeps its name and tooltip, opens the unchanged menu by keyboard and restores focus', async language => {
  const copy = language === 'cs' ? cs : en
  const { user, router } = await mount(language)
  const trigger = within(viewsRegion(copy)).getByRole('button', { name: copy.savedViewsMenu })
  expect(trigger.title).toBe(copy.savedViewsMenu)
  expect(trigger.textContent).toBe('')
  expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(screen.getByRole('button', { name: copy.listDisplay })).not.toBe(trigger)
  for (const key of ['{Enter}', ' ']) {
    trigger.focus()
    await user.keyboard(key)
    const menu = await screen.findByRole('dialog', { name: copy.savedViews })
    expect(within(menu).getAllByRole('button').map(button => button.textContent)).toEqual([copy.savedViewsSaveNew, copy.savedViewsClose, copy.savedViewsApplyView])
    expect(within(menu).getByRole('button', { name: copy.savedViewsApplyView }).hasAttribute('disabled')).toBe(true)
    expect(within(menu).getByText(copy.savedViewsBrowserOnly)).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.savedViews })).toBeNull())
    expect(document.activeElement).toBe(trigger)
  }
  await navigate(router, { sort: 'created', direction: 'desc' })
  expect(within(viewsRegion(copy)).getByRole('button', { name: copy.savedViewsMenu })).toBe(trigger)
  expect(within(trigger).getByRole('img', { name: copy.savedViewsUnsaved })).toBeTruthy()
  expect(trigger.title).toBe(copy.savedViewsMenu)
})
it.each(['en', 'cs'] as const)('%s saves, applies at page one, renames, updates and deletes with accessible focus', async language => {
  const copy = language === 'cs' ? cs : en
  const { router, request, user } = await mount(language)
  await openViewsMenu(user, copy)
  expect(screen.getByText(copy.savedViewsBrowserOnly)).toBeTruthy()
  await user.keyboard('{Escape}')
  await navigate(router, { filters: [{ field: 'name', predicate: { contains: 'Saved' } }], sort: 'created', direction: 'desc', view: 'all', search: 'omit text', pageSize: 50 })
  // Save appears because the confirmed state differs from the (absent) active view; it is the bar button, not the menu item.
  await user.click(within(viewsRegion(copy)).getByRole('button', { name: copy.savedViewsSaveView }))
  const dialog = await screen.findByRole('dialog'); const input = within(dialog).getByRole('textbox', { name: copy.savedViewsName }); expect(document.activeElement).toBe(input)
  await user.type(input, '  My view  '); await user.click(within(dialog).getByRole('button', { name: copy.savedViewsConfirm }))
  expect(loadSavedViews(scope, 'entries').entries[0]).toMatchObject({ name: 'My view', search: { view: 'all', sort: 'created', direction: 'desc', filters: [{ field: 'name', predicate: { contains: 'Saved' } }] } })
  expect(loadSavedViews(scope, 'entries').entries[0].search.search).toBeUndefined()
  await appliedView(user, 'My view', copy)
  expect(document.activeElement).toBe(viewsTrigger(copy))
  const renaming = await openNaming(user, 'savedViewsRenameThis', copy)
  await user.clear(within(renaming).getByRole('textbox', { name: copy.savedViewsName })); await user.type(within(renaming).getByRole('textbox', { name: copy.savedViewsName }), 'Renamed')
  await user.click(within(renaming).getByRole('button', { name: copy.savedViewsConfirm }))
  await appliedView(user, 'Renamed', copy)
  await navigate(router, { sort: 'none' })
  await waitFor(() => expect(screen.getByRole('button', { name: copy.nextPage }).hasAttribute('disabled')).toBe(false))
  await user.click(screen.getByRole('button', { name: copy.nextPage }))
  await waitFor(() => expect(request.mock.lastCall?.[0].offset).toBe(30))
  await applyView(user, 'Renamed', copy)
  await waitFor(() => expect(document.activeElement).toBe(viewsTrigger(copy)))
  await waitFor(() => expect(request.mock.lastCall?.[0]).toMatchObject({ limit: 30, orderBy: [{ field: 'created', dir: 'desc' }], where: { and: [{ name: { contains: 'Saved' } }] } }))
  expect(request.mock.lastCall?.[0].cursor).toBeUndefined()
  expect(router.state.location.search).toMatchObject({ sort: 'created', direction: 'desc', view: 'all', pageSize: 30 })
  expect((router.state.location.state as any).generatedList.cursors).toEqual([])
  expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('1')
  await navigate(router, { sort: 'none', view: 'all' })
  await user.click(await within(viewsRegion(copy)).findByRole('button', { name: copy.savedViewsSaveChanges }))
  const updating = await screen.findByRole('dialog')
  expect(within(updating).getByRole('checkbox', { name: copy.savedViewsUpdateCurrent }).getAttribute('aria-checked')).toBe('true')
  await user.click(within(updating).getByRole('button', { name: copy.savedViewsConfirm }))
  expect(loadSavedViews(scope, 'entries').entries[0].search).toMatchObject({ sort: 'none', view: 'all' })
  expect(loadSavedViews(scope, 'entries').entries[0].search.filters).toBeUndefined()
  expect(loadSavedViews(scope, 'entries').entries).toHaveLength(1)
  const deleting = await openNaming(user, 'savedViewsDeleteThis', copy)
  await user.click(within(deleting).getByRole('button', { name: copy.savedViewsDelete }))
  expect(loadSavedViews(scope, 'entries').entries).toEqual([])
  await waitFor(() => expect(viewsTrigger(copy).getAttribute('aria-label')).toBe(copy.savedViewsMenu))
  expect(document.activeElement).toBe(viewsTrigger(copy))
})
it('revalidates saved settings against reduced capabilities and retains listStateDropped', async () => {
  const { user, router, update } = await mount()
  await navigate(router, { filters: [{ field: 'name', predicate: { contains: 'Private' } }], sort: 'created', direction: 'desc' })
  await saveAs(user, 'Mine')
  const reduced: Capabilities = { ...caps, entities: { entries: { ...caps.entities.entries, readable: ['id'] } } }
  await act(async () => update({ scope, caps: reduced }))
  await applyView(user, 'Mine')
  await waitFor(() => expect(router.state.location.search.sort).toBe('none'))
  expect(router.state.location.search.filters).toBeUndefined()
  expect(await screen.findByText(en.listStateDropped)).toBeTruthy()
  expect((router.state.location.state as any).generatedList).toMatchObject({ cursors: [], notice: 'listStateDropped' })
  // Revalidation does not rewrite the stored personal view.
  expect(loadSavedViews(scope, 'entries').entries[0].search.sort).toBe('created')
  // What was dropped by authority is not "unsaved work": the applied view is compared after the same revalidation.
  expect(within(viewsRegion()).queryByRole('button', { name: en.savedViewsSaveChanges })).toBeNull()
})
it('hides the feature without verified scope and resets mounted state on scope replacement', async () => {
  const { user, update } = await mount('en', null)
  expect(screen.queryByRole('region', { name: en.savedViews })).toBeNull()
  expect(store.getItem).not.toHaveBeenCalled()
  await act(async () => update({ scope, caps }))
  const dialog = await openNaming(user, 'savedViewsSaveNew'); await user.type(within(dialog).getByRole('textbox', { name: en.savedViewsName }), 'Unsubmitted')
  await act(async () => update({ scope: { ...scope, userId: 'other' }, caps }))
  expect(screen.queryByRole('textbox', { name: en.savedViewsName })).toBeNull()
  expect(store.setItem).not.toHaveBeenCalled()
  expect(viewsRegion().textContent).not.toContain('Unsubmitted')
  expect(viewsTrigger().getAttribute('aria-label')).toBe(en.savedViewsMenu)
})
it('never shows controls or reads a namespace for embedded lists', async () => {
  await mount('en', scope, true)
  expect(screen.queryByRole('region', { name: en.savedViews })).toBeNull()
  expect(store.getItem).not.toHaveBeenCalled()
})
it('storage events refresh the catalogue without navigation; reload and back/forward keep URL authoritative', async () => {
  const { router, history, user, view } = await mount()
  const saved = changeSavedViews(scope, 'entries', { kind: 'save', name: 'Other tab', state: { search: '', sort: { key: 'created', direction: 'desc' }, userFilters: [], presetFilters: [], limit: 30 } }).entries[0]
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  expect(within(await openViewsMenu(user)).getByRole('button', { name: 'Other tab' })).toBeTruthy()
  expect(router.state.location.search.sort).toBeUndefined()
  await user.click(screen.getByRole('button', { name: saved.name }))
  await user.click(screen.getByRole('button', { name: en.savedViewsApplyView }))
  await waitFor(() => expect(router.state.location.search.sort).toBe('created'))
  await act(async () => { history.back() })
  await waitFor(() => expect(router.state.location.search.sort).toBeUndefined())
  await act(async () => { history.forward() })
  await waitFor(() => expect(router.state.location.search.sort).toBe('created'))
  await navigate(router, { sort: 'none' })
  store.removeItem(savedViewsKey(scope, 'entries'))
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  // The applied view vanished in another tab: it can no longer be the dirty baseline.
  await waitFor(() => expect(saveBar()).toBeNull())
  expect(within(viewsRegion()).queryByRole('img', { name: en.savedViewsUnsaved })).toBeNull()
  const refreshed = await openViewsMenu(user)
  expect(within(refreshed).queryByRole('button', { name: 'Other tab' })).toBeNull()
  expect(within(refreshed).queryByRole('button', { current: true })).toBeNull()
  expect(within(refreshed).queryByRole('button', { name: en.savedViewsRenameThis })).toBeNull()
  expect(within(refreshed).queryByRole('button', { name: en.savedViewsDeleteThis })).toBeNull()
  await user.keyboard('{Escape}')
  // Returning to the deleted view's settings is dirty against the initial baseline,
  // and Save now creates a view instead of updating the deleted one.
  await navigate(router, { sort: 'created', direction: 'desc' })
  await waitFor(() => expect(saveBar()?.textContent).toBe(en.savedViewsSaveView))
  await user.click(saveBar()!)
  const saving = await screen.findByRole('dialog')
  expect((within(saving).getByRole('textbox', { name: en.savedViewsName }) as HTMLInputElement).value).toBe('')
  expect(within(saving).queryByRole('checkbox', { name: en.savedViewsUpdateCurrent })).toBeNull()
  await user.keyboard('{Escape}')
  await navigate(router, { sort: 'none' })
  expect(router.state.location.search.sort).toBe('none')
  changeSavedViews(scope, 'entries', { kind: 'save', name: 'Persisted', state: { search: '', sort: null, userFilters: [], presetFilters: [], limit: 30 } })
  view.unmount()
  const again = await mount()
  expect(within(await openViewsMenu(again.user)).getByRole('button', { name: 'Persisted' })).toBeTruthy()
})
it('explicit cleanup invalidates open save callbacks before they can recreate storage', async () => {
  const { user } = await mount()
  const dialog = await openNaming(user, 'savedViewsSaveNew'); await user.type(within(dialog).getByRole('textbox', { name: en.savedViewsName }), 'Late')
  await act(async () => clearSavedViews(scope))
  expect(screen.queryByRole('textbox', { name: en.savedViewsName })).toBeNull()
  expect(store.setItem).not.toHaveBeenCalled()
  expect(viewsTrigger().hasAttribute('disabled')).toBe(true)
})
it('reports quota and name failures visibly without claiming success', async () => {
  const { user } = await mount()
  const dialog = await openNaming(user, 'savedViewsSaveNew')
  await user.click(within(dialog).getByRole('button', { name: en.savedViewsConfirm }))
  expect(within(dialog).getByRole('alert').textContent).toBe(en.savedViewsError_name)
  await user.type(within(dialog).getByRole('textbox', { name: en.savedViewsName }), 'Quota')
  store.setItem.mockImplementation(() => { throw new Error('quota') })
  await user.click(within(dialog).getByRole('button', { name: en.savedViewsConfirm }))
  expect(within(dialog).getByRole('alert').textContent).toBe(en.savedViewsError_storage)
  expect(screen.queryByText(en.savedViewsChanged)).toBeNull()
})

it('over-limit and malformed storage report failure while the list stays usable', async () => {
  const { user, request } = await mount()
  const state = { search: '', sort: null, userFilters: [], presetFilters: [], limit: 30 }
  for (let i = 0; i < 20; i++) changeSavedViews(scope, 'entries', { kind: 'save', name: 'Existing ' + i, state })
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  const dialog = await openNaming(user, 'savedViewsSaveNew'); await user.type(within(dialog).getByRole('textbox', { name: en.savedViewsName }), 'Overflow')
  await user.click(within(dialog).getByRole('button', { name: en.savedViewsConfirm }))
  expect(within(dialog).getByRole('alert').textContent).toBe(en.savedViewsError_limit)
  expect(loadSavedViews(scope, 'entries').entries).toHaveLength(20)
  await user.keyboard('{Escape}')
  store.setItem(savedViewsKey(scope, 'entries'), 'null')
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  expect(screen.getByRole('alert').textContent).toBe(en.savedViewsError_invalid)
  await user.click(screen.getByRole('button', { name: en.nextPage }))
  await waitFor(() => expect(request.mock.lastCall?.[0].offset).toBe(30))
})

const saveBar = (copy: typeof en = en) => within(viewsRegion(copy)).queryByRole('button', { name: copy.savedViewsSaveView }) ?? within(viewsRegion(copy)).queryByRole('button', { name: copy.savedViewsSaveChanges })
it('marks dirty only for confirmed saved settings: search, paging and the draft panel never count, and it clears when the state matches again', async () => {
  const { router, user, request } = await mount()
  expect(saveBar()).toBeNull()
  expect(within(viewsRegion()).queryByRole('img', { name: en.savedViewsUnsaved })).toBeNull()
  // Not saved settings: search text, page size, page.
  await navigate(router, { search: 'text', pageSize: 50 })
  expect(saveBar()).toBeNull()
  await navigate(router, { sort: 'created', direction: 'desc' })
  expect(saveBar()?.textContent).toBe(en.savedViewsSaveView)
  expect(within(viewsRegion()).getByRole('img', { name: en.savedViewsUnsaved })).toBeTruthy()
  await navigate(router, {})
  expect(saveBar()).toBeNull()
  // The draft panel is not confirmed state: editing it neither marks dirty nor queries.
  await user.click(screen.getByText(en.sortAndFilter))
  const panel = screen.getByRole('group', { name: en.sortAndFilter }); const before = request.mock.calls.length
  await user.type(within(panel).getAllByRole('textbox')[0], 'Draft')
  expect(saveBar()).toBeNull(); expect(request.mock.calls).toHaveLength(before)
  await user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(saveBar()?.textContent).toBe(en.savedViewsSaveView))
  // Saving makes the current state the baseline; leaving it dirties, returning clears.
  await user.click(saveBar()!)
  const dialog = await screen.findByRole('dialog'); await user.type(within(dialog).getByRole('textbox', { name: en.savedViewsName }), 'Base'); await user.click(within(dialog).getByRole('button', { name: en.savedViewsConfirm }))
  await waitFor(() => expect(saveBar()).toBeNull())
  const saved = router.state.location.search
  await navigate(router, { ...saved, sort: 'created', direction: 'asc' })
  await waitFor(() => expect(saveBar()?.textContent).toBe(en.savedViewsSaveChanges))
  await navigate(router, saved as Record<string, unknown>)
  await waitFor(() => expect(saveBar()).toBeNull())
})
it('selecting a view never changes the list; switching while dirty is announced before it replaces the changes, and cancel keeps the active view', async () => {
  const { router, user } = await mount()
  const state = (key: string) => ({ search: '', sort: { key, direction: 'asc' as const }, userFilters: [], presetFilters: [], limit: 30 })
  changeSavedViews(scope, 'entries', { kind: 'save', name: 'By name', state: state('name') }); changeSavedViews(scope, 'entries', { kind: 'save', name: 'By created', state: state('created') })
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  await applyView(user, 'By name')
  await waitFor(() => expect(router.state.location.search.sort).toBe('name'))
  await appliedView(user, 'By name')
  expect(saveBar()).toBeNull()
  // Unsaved work on top of the active view.
  await navigate(router, { sort: 'name', direction: 'desc' })
  await waitFor(() => expect(saveBar()?.textContent).toBe(en.savedViewsSaveChanges))
  const menu = await openViewsMenu(user)
  expect(within(menu).getByRole('status').textContent).toBe(en.savedViewsDiscardWarning)
  await user.click(within(menu).getByRole('button', { name: 'By created' }))
  // Choosing is not applying: the confirmed state (and its unsaved change) is untouched.
  expect(router.state.location.search).toMatchObject({ sort: 'name', direction: 'desc' }); expect(saveBar()).toBeTruthy()
  // Opening and cancelling "save as new" changes neither the active view nor the list.
  await user.click(within(menu).getByRole('button', { name: en.savedViewsSaveNew }))
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.cancel }))
  await appliedView(user, 'By name'); expect(router.state.location.search).toMatchObject({ sort: 'name', direction: 'desc' })
  expect(loadSavedViews(scope, 'entries').entries).toHaveLength(2)
  // Confirming replaces the changes and makes the chosen view the baseline.
  await applyView(user, 'By created')
  await waitFor(() => expect(router.state.location.search).toMatchObject({ sort: 'created', direction: 'asc' }))
  await appliedView(user, 'By created')
  await waitFor(() => expect(saveBar()).toBeNull())
  expect((await openViewsMenu(user)).querySelector('[role=status]')).toBeNull()
})
it('a refused rename keeps the dialog open and leaves the stored view untouched instead of half-saving', async () => {
  const { router, user } = await mount()
  await navigate(router, { sort: 'created', direction: 'desc' })
  await saveAs(user, 'Keep')
  await navigate(router, { sort: 'name', direction: 'asc' })
  await user.click(await within(viewsRegion()).findByRole('button', { name: en.savedViewsSaveChanges }))
  const dialog = await screen.findByRole('dialog')
  await user.clear(within(dialog).getByRole('textbox', { name: en.savedViewsName }))
  await user.click(within(dialog).getByRole('button', { name: en.savedViewsConfirm }))
  expect(within(dialog).getByRole('alert').textContent).toBe(en.savedViewsError_name)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(loadSavedViews(scope, 'entries').entries[0]).toMatchObject({ name: 'Keep', search: { sort: 'created', direction: 'desc' } })
})

// Based on the review dismissal probe: clicking Search must leave it ready for typing.
it('keeps the outside Search destination focused after dismissing personal views', async () => {
  const { user } = await mount()
  await openViewsMenu(user)
  const search = screen.getByRole('searchbox', { name: en.search })
  await user.click(search)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: en.savedViews })).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(search))
  await user.keyboard('outside search')
  expect((search as HTMLInputElement).value).toBe('outside search')
})
it.each(['escape', 'close', 'apply', 'trigger'] as const)('restores personal views trigger focus after explicit %s', async action => {
  const { user } = await mount()
  if (action === 'apply') {
    changeSavedViews(scope, 'entries', { kind: 'save', name: 'Mine', state: { search: '', sort: null, userFilters: [], presetFilters: [], limit: 30 } })
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: savedViewsKey(scope, 'entries') })))
  }
  await openViewsMenu(user)
  await user.click(screen.getByRole('searchbox', { name: en.search }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: en.savedViews })).toBeNull())
  const menu = await openViewsMenu(user)
  // Let the menu receive focus before toggling it closed (the review-trigger probe).
  await waitFor(() => expect(document.activeElement).toBe(within(menu).getAllByRole('button')[0]))
  if (action === 'escape') await user.keyboard('{Escape}')
  else if (action === 'trigger') await user.click(viewsTrigger().querySelector('svg')!)
  else await user.click(within(menu).getByRole('button', { name: action === 'close' ? en.savedViewsClose : en.savedViewsApplyView }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: en.savedViews })).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(viewsTrigger()))
})
