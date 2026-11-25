import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import { saveListPreferences, loadListPreferences } from '../../console-generated/src/list-preferences'
const model: Model = { instance: 'composition', revision: 1, timeZone: 'Europe/Prague', limits: { root: 100, maxOffset: 40, children: 20, relations: 4, exists: 4 }, entities: {
  entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active', 'inactive'] }, quick: { type: 'bool' } }, columns: ['name', 'status'], relations: {}, routes: { list: '', detail: '' }, list: { pageSize: 10, columns: [{ field: 'name' }, { field: 'status' }], filter: { status: { kind: 'enum', placement: 'panel', operators: ['in'] }, quick: { kind: 'boolean', placement: 'toolbar', operators: ['eq'] } }, views: [{ id: 'active', label: 'Active view', where: { status: { eq: 'active' } } }] } },
} }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: Object.keys(model.entities.entries.fields), writable: [], operations: ['read'] } } }
let client: QueryClient
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(options: { enumToolbar?: boolean; access?: boolean; invitations?: boolean; readAccess?: boolean; accessPlacement?: 'toolbar' | 'column'; missingTotals?: boolean; empty?: boolean; create?: boolean; context?: boolean; initial?: string; total?: number; range?: boolean; lowerBound?: 'number' | 'date' } = {}) {
  const definition = structuredClone(model), permissions = structuredClone(caps)
  if (options.enumToolbar) { definition.entities.entries.fields.status.values = ['active', 'inactive', 'pending', 'archived']; definition.entities.entries.list!.filter!.status = { kind: 'enum', placement: 'toolbar', operators: ['in'] } }
  if (options.range) { definition.entities.entries.fields.amount = { type: 'number' }; definition.entities.entries.list!.filter!.amount = { kind: 'number', placement: 'panel', operators: ['eq', 'gte', 'lte'] }; permissions.entities.entries.readable.push('amount') }
  if (options.lowerBound) { definition.entities.entries.fields.amount = { type: options.lowerBound === 'date' ? 'datetime' : 'number' }; definition.entities.entries.list!.filter!.amount = { kind: options.lowerBound, placement: 'panel', operators: ['gte'] }; permissions.entities.entries.readable.push('amount') }
  if (options.access) { definition.entities.entries.rowInvitations = options.invitations ?? true; definition.entities.entries.rowAccess = options.readAccess ?? true; definition.entities.entries.list!.views!.push({ id: 'linked', label: 'Linked view', where: {}, rowAccess: 'signed_in' }); definition.entities.entries.list!.rowAccess = options.accessPlacement === 'column' ? { column: true } : { placement: options.accessPlacement ?? 'panel' }; permissions.resources = { 'invitations.read': true } }
  const create = vi.fn()
  if (options.create) permissions.entities.entries.operations.push('create')
  const preferenceScope = { instance: model.instance, userId: 'composition-user', orgId: 'org' }
  saveListPreferences(preferenceScope, 'entries', { visible: ['name'], density: 'compact' })
  let mode = 'success', release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const request = vi.fn(async (query: ReadQuery) => {
    await gate
    if (mode !== 'success') throw Object.assign(new Error(mode), { code: mode, status: mode === 'denied' ? 403 : 400 })
    return { data: options.empty ? [] : [{ id: String(query.offset ?? 0), name: `Current ${query.search?.text ?? ''}`, status: 'active' }], next_cursor: null, offset: query.offset, limit: query.limit, ...(!options.missingTotals ? { total: options.total ?? (options.empty ? 0 : query.where ? 7 : query.view ? 42 : 73), viewTotals: { all: options.empty ? 0 : query.where ? 19 : 73, active: options.empty ? 0 : query.where ? 7 : 42 } } : {}) }
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <GeneratedReadPage model={definition} caps={permissions} orgId="org" entity="entries" request={request} savedViewsScope={preferenceScope} primaryAction={options.create ? { label: "Create entry", onAction: create } : undefined} contextList={options.context ? { entity: "parents", id: "parent", list: "entries" } : undefined} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [options.initial ?? '/o/org/e/entries'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', field_status: 'Status', field_quick: 'Quick', value_active: 'Active', value_inactive: 'Inactive' } } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await waitFor(() => expect(request).toHaveBeenCalled())
  if (!options.empty) await screen.findByText('Current')
  return { router, request, create, preferenceScope, user: userEvent.setup(), hold: () => { gate = new Promise(resolve => { release = resolve }) }, release: () => { release?.(); gate = undefined }, fail: (value: string) => { mode = value } }
}
const openPanel = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByText(en.sortAndFilter)); return screen.getByRole('group', { name: en.sortAndFilter }) }
it('keeps draft edits out of rows/counts, URL and chips; Cancel retains an immediate toolbar change', async () => {
  const test = await mount(), panel = await openPanel(test.user)
  const before = test.request.mock.calls.length, url = test.router.state.location.href
  await test.user.click(within(panel).getByRole('checkbox', { name: 'Inactive' }))
  expect(test.request.mock.calls).toHaveLength(before)
  expect(test.router.state.location.href).toBe(url)
  expect(screen.queryByRole('button', { name: /Remove.*Inactive/ })).toBeNull()
  await test.user.click(screen.getByRole('combobox', { name: en.filterValue }))
  await test.user.click(screen.getByRole('option', { name: en.yes }))
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'quick', predicate: { eq: true } }]))
  expect(within(panel).getByRole('checkbox', { name: 'Inactive' }).getAttribute('aria-checked')).toBe('true')
  await test.user.click(within(panel).getByRole('button', { name: en.cancel }))
  expect(test.router.state.location.search.filters).toEqual([{ field: 'quick', predicate: { eq: true } }])
})
it('merges Apply into latest confirmed state once, resets paging, and restores it through history', async () => {
  const test = await mount()
  await test.user.click(screen.getByRole('button', { name: '3' }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 20, includeTotal: true, includeViewTotals: true }))
  const panel = await openPanel(test.user)
  await test.user.click(within(panel).getByRole('checkbox', { name: 'Inactive' }))
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  const before = test.request.mock.calls.length
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(before + 1))
  expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 0, view: 'active', where: { and: [{ status: { in: ['inactive'] } }] } })
  expect(test.router.state.location.search.view).toBe('active')
  expect(await screen.findByText('1–7 of 7')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Active view.*7/ })).toBeTruthy()
  await act(async () => test.router.history.back())
  await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
  await act(async () => test.router.history.forward())
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'status', predicate: { in: ['inactive'] } }]))
})
it('uses exact server counts and total, caps reachable pages, and orders the shared slots', async () => {
  const test = await mount()
  expect(screen.getByRole('button', { name: /Active view.*42/ })).toBeTruthy()
  expect(screen.getByText(/1.*10.*73/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '6' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Filter column.*Status/ })).toBeNull()
  const slots = [...document.querySelectorAll('[data-list-slot]')].map(node => node.getAttribute('data-list-slot'))
  expect(slots).toEqual(['tabs', 'toolbar', 'chips', 'table', 'footer'])
  await openPanel(test.user)
  const open = [...document.querySelectorAll('[data-list-slot]')].map(node => node.getAttribute('data-list-slot'))
  expect(open).toEqual(['tabs', 'toolbar', 'panel', 'chips', 'table', 'footer'])
})
it.each(['query_too_expensive', 'denied'])('hides old rows/counts during loading and after %s', async failure => {
  const test = await mount(); test.hold(); test.fail(failure)
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(2))
  expect(screen.queryByText('Current')).toBeNull()
  expect(screen.queryByRole('button', { name: /Active view.*42/ })).toBeNull()
  expect(screen.queryByText(/1.*10.*73/)).toBeNull()
  await act(async () => test.release())
  await waitFor(() => expect(screen.queryByTestId('data-table-loading')).toBeNull())
  expect(screen.queryByRole('button', { name: /Active view.*42/ })).toBeNull()
  expect(screen.queryByText(/1.*10.*73/)).toBeNull()
})

it('keeps same-key rows and counts mounted during a held background refetch, but hides them when the key changes', async () => {
  const test = await mount()
  const row = screen.getByText('Current')
  test.hold()
  let invalidation: Promise<void> | undefined
  await act(async () => { invalidation = client.invalidateQueries({ refetchType: 'active' }) })
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(2))
  expect(test.request.mock.calls[1][0]).toEqual(test.request.mock.calls[0][0])
  expect(screen.getByText('Current')).toBe(row)
  expect(document.body.contains(row)).toBe(true)
  expect(screen.getByRole('button', { name: /Active view.*42/ })).toBeTruthy()
  expect(screen.getByText(/1.*10.*73/)).toBeTruthy()
  await act(async () => test.release())
  await invalidation
  await waitFor(() => expect(screen.getByText('Current')).toBe(row))
  test.hold()
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(3))
  expect(screen.queryByText('Current')).toBeNull()
  expect(screen.queryByRole('button', { name: /Active view.*42/ })).toBeNull()
  expect(screen.queryByText(/1.*10.*73/)).toBeNull()
  await act(async () => test.release())
})
it('hides invalidated cached rows and counts after A → pending B → A until A settles', async () => {
  const test = await mount()
  const originalQuery = test.request.mock.calls[0][0]
  test.hold()
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(2))
  expect(screen.queryByText('Current')).toBeNull()
  await act(async () => { await client.invalidateQueries({ type: 'inactive', refetchType: 'none' }) })
  await act(async () => test.router.history.back())
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(3))
  expect(test.request.mock.calls[2][0]).toEqual(originalQuery)
  expect(screen.queryByText('Current')).toBeNull()
  expect(screen.queryByRole('button', { name: /Active view.*42/ })).toBeNull()
  expect(screen.queryByText('1–10 of 73')).toBeNull()
  await act(async () => test.release())
  expect(await screen.findByText('Current')).toBeTruthy()
  expect(await screen.findByText('1–10 of 73')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Active view.*42/ })).toBeTruthy()
})
it('stages row access in the panel, keeps confirmed chips until Apply and clears it with its chip', async () => {
  const test = await mount({ access: true }), panel = await openPanel(test.user)
  const before = test.request.mock.calls.length, url = test.router.state.location.href
  await test.user.selectOptions(within(panel).getByRole('combobox', { name: en.rowAccessFilter }), 'invited')
  expect(test.request.mock.calls).toHaveLength(before)
  expect(test.router.state.location.href).toBe(url)
  expect(screen.queryByRole('button', { name: /Remove.*Invitation sent/ })).toBeNull()
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ rowAccess: 'invited', offset: 0 }))
  await test.user.click(screen.getByRole('button', { name: /Remove.*Invitation sent/ }))
  await waitFor(() => expect(test.router.state.location.search.rowAccess).toBeUndefined())
})
it('resets the numbered page after a page size change', async () => {
  const test = await mount()
  await test.user.click(screen.getByRole('button', { name: '3' }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0].offset).toBe(20))
  expect(screen.getByRole('option', { name: '20 / page' })).toBeTruthy()
  await test.user.selectOptions(screen.getByRole('combobox', { name: en.rowsPerPage }), '20')
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 0, limit: 20 }))
  expect(test.router.state.location.search.pageSize).toBe(20)
})
it.each([false, true])('distinguishes a missing total from an exact empty total (missing=%s)', async missingTotals => {
  await mount({ empty: true, missingTotals })
  if (!missingTotals) {
    expect(await screen.findByText('0–0 of 0')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Active view.*0/ })).toBeTruthy()
  } else {
    expect(screen.queryByText(/of 0/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Active view.*0/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '1' })).toBeNull()
  }
})
it('does not let a late list/count response replace the current confirmed signature', async () => {
  const test = await mount(); test.hold()
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(2))
  await test.user.click(screen.getByRole('button', { name: /All/ }))
  await act(async () => test.release())
  await screen.findByText('1–10 of 73')
  expect(test.router.state.location.search.view).toBe('all')
  expect(screen.queryByText('1–10 of 42')).toBeNull()
})

it('validates a draft range without requests and commits only after correction', async () => {
  const test = await mount({ range: true }), panel = await openPanel(test.user)
  const before = test.request.mock.calls.length, url = test.router.state.location.href
  await test.user.type(within(panel).getByRole('spinbutton', { name: en.filterFrom }), '10')
  await test.user.type(within(panel).getByRole('spinbutton', { name: en.filterTo }), '5')
  expect(within(panel).getByRole('button', { name: en.applyFilter }).hasAttribute('disabled')).toBe(true)
  expect(within(panel).getByRole('alert').textContent).toBe(en.filterInvalidValueRange)
  expect(test.request.mock.calls).toHaveLength(before)
  expect(test.router.state.location.href).toBe(url)
  await test.user.clear(within(panel).getByRole('spinbutton', { name: en.filterTo }))
  await test.user.type(within(panel).getByRole('spinbutton', { name: en.filterTo }), '15')
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(before + 1))
  expect(test.request.mock.calls.at(-1)?.[0].where).toEqual({ and: [{ amount: { gte: 10, lte: 15 } }] })
})
it.each(['number', 'date'] as const)('keeps the shared %s range shape for gte-only filters and sends only the lower bound', async lowerBound => {
  const test = await mount({ lowerBound }), panel = await openPanel(test.user)
  const before = test.request.mock.calls.length
  const from = within(panel).getByLabelText(en.filterFrom) as HTMLInputElement
  expect((within(panel).getByLabelText(en.filterSingle) as HTMLInputElement).disabled).toBe(true)
  expect((within(panel).getByLabelText(en.filterTo) as HTMLInputElement).disabled).toBe(true)
  expect(from.disabled).toBe(false)
  expect(from.type).toBe(lowerBound === 'date' ? 'text' : 'number')
  if (lowerBound === 'date') {
    await test.user.click(within(panel).getByRole('button', { name: en.selectDateRange }))
    expect(screen.getByRole('grid')).toBeTruthy()
    await test.user.keyboard('{Escape}')
  }
  await test.user.type(from, lowerBound === 'date' ? '2026-11-19' : '10.5')
  expect(test.request.mock.calls).toHaveLength(before)
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(before + 1))
  expect(test.request.mock.calls.at(-1)?.[0].where).toEqual({ and: [{ amount: { gte: lowerBound === 'date' ? '2026-11-18T23:00:00.000Z' /* midnight 19 Nov in the model's Europe/Prague zone, whatever the host zone */ : 10.5 } }] })
})
it('keeps confirmed toolbar filters and search when applying an older panel draft', async () => {
  const test = await mount(), panel = await openPanel(test.user)
  await test.user.click(within(panel).getByRole('checkbox', { name: 'Inactive' }))
  await test.user.type(screen.getByRole('searchbox', { name: en.search }), 'New search')
  await waitFor(() => expect(test.router.state.location.search.search).toBe('New search'))
  await test.user.click(screen.getByRole('combobox', { name: en.filterValue }))
  await test.user.click(screen.getByRole('option', { name: en.yes }))
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'quick', predicate: { eq: true } }]))
  const before = test.request.mock.calls.length
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(before + 1))
  expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 0, search: { text: 'New search' }, where: { and: [{ quick: { eq: true } }, { status: { in: ['inactive'] } }] } })
})

it.each(['toolbar', 'column'] as const)('honors row-access %s metadata without adding an Apply boundary', async accessPlacement => {
  const test = await mount({ access: true, accessPlacement })
  if (accessPlacement === 'column') {
    expect(screen.queryByRole('combobox', { name: en.rowAccessFilter })).toBeNull()
    const panel = await openPanel(test.user)
    expect(within(panel).queryByRole('combobox', { name: en.rowAccessFilter })).toBeNull()
  } else {
    await test.user.selectOptions(screen.getByRole('combobox', { name: en.rowAccessFilter }), 'expired')
    await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ rowAccess: 'expired', offset: 0 }))
    expect(test.router.state.location.search.rowAccess).toBe('expired')
  }
})

it('copies the numbered page in the URL, restores it without history state, and resets it on settings changes', async () => {
  const test = await mount()
  await test.user.click(screen.getByRole('button', { name: '3' }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0].offset).toBe(20))
  const copied = test.router.state.location.search
  expect(copied.page).toBe(3)
  await act(async () => { await test.router.navigate({ to: '.', search: copied as any, state: {} as any }) })
  await waitFor(() => expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('3'))
  expect(test.request.mock.calls.at(-1)?.[0].offset).toBe(20)
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0].offset).toBe(0))
  expect(test.router.state.location.search.page).toBeUndefined()
})

it('explains a genuinely empty configured view without an ineffective clear action', async () => {
  const test = await mount({ empty: true })
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  expect(await screen.findByRole('heading', { name: en.listS3EmptyViewHeading })).toBeTruthy()
  expect(screen.getByText(en.listS3EmptyViewHelp)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.clearSearchFilters })).toBeNull()
  await test.user.type(screen.getByRole('searchbox', { name: en.search }), 'missing')
  expect(await screen.findByText('Try changing or clearing your search and filters.')).toBeTruthy()
  await test.user.click(screen.getByRole('button', { name: en.clearSearchFilters }))
  await waitFor(() => expect(test.router.state.location.search.search).toBeUndefined())
  expect(test.router.state.location.search.view).toBe('active')
  expect(test.request.mock.calls.at(-1)?.[0].offset).toBe(0)
})
it('renders inert visible-column skeletons on a new query and one loading announcement in the footer', async () => {
  const test = await mount(); test.hold()
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(2))
  const skeletons = document.querySelectorAll('[data-list-skeleton]')
  expect(skeletons).toHaveLength(5)
  for (const row of skeletons) {
    expect(row.getAttribute('aria-hidden')).toBe('true')
    expect(row.querySelectorAll('td')).toHaveLength(screen.getAllByRole('columnheader').length)
    expect(row.querySelector('button,a,input,[tabindex]')).toBeNull()
  }
  expect(screen.getAllByRole('status').filter(node => node.textContent === en.loading)).toHaveLength(1)
  expect(document.querySelector('footer [data-list-range]')).toBeNull()
  await act(async () => test.release())
  expect(await screen.findByText('Current')).toBeTruthy()
  expect(document.querySelector('[data-list-skeleton]')).toBeNull()
})

it.each(['panel', 'toolbar'] as const)('shows read-only access tabs and %s filter without invitation-create controls', async placement => {
  const test = await mount({ access: true, invitations: false, ...(placement === 'toolbar' ? { accessPlacement: placement } : {}) })
  await test.user.click(screen.getByRole('button', { name: /Linked view/ }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0].view).toBe('linked'))
  const region = placement === 'panel' ? await openPanel(test.user) : document.body
  await test.user.selectOptions(within(region).getByRole('combobox', { name: en.rowAccessFilter }), 'signed_in')
  if (placement === 'panel') await test.user.click(within(region).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ rowAccess: 'signed_in', view: 'linked' }))
  expect(screen.queryByRole('columnheader', { name: en.rowAccess })).toBeNull()
  expect(screen.queryByRole('button', { name: /Invite|Send invitation/ })).toBeNull()
})
it('hides access tabs and status controls when the model denies read, even with invitation-create capability', async () => {
  const test = await mount({ access: true, readAccess: false })
  expect(screen.queryByRole('button', { name: /Linked view/ })).toBeNull()
  const panel = await openPanel(test.user)
  expect(within(panel).queryByRole('combobox', { name: en.rowAccessFilter })).toBeNull()
})

it('keeps four toolbar enum choices in the existing popover and applies selection immediately to query and URL', async () => {
  const test = await mount({ enumToolbar: true })
  const trigger = screen.getByRole('button', { name: 'Status' })
  expect(screen.queryByRole('checkbox', { name: 'Active' })).toBeNull()
  await test.user.click(trigger)
  const choices = screen.getByRole('dialog', { name: 'Status' })
  expect(within(choices).getAllByRole('checkbox')).toHaveLength(4)
  await test.user.click(within(choices).getByRole('checkbox', { name: 'Active' }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 0, where: { and: [{ status: { in: ['active'] } }] } }))
  expect(test.router.state.location.search.filters).toEqual([{ field: 'status', predicate: { in: ['active'] } }])
  expect(trigger.textContent).toBe('Status(1)')
  await test.user.click(within(choices).getByRole('checkbox', { name: 'Inactive' }))
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'status', predicate: { in: ['active', 'inactive'] } }]))
  await test.user.click(within(choices).getByRole('checkbox', { name: 'Active' }))
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'status', predicate: { in: ['inactive'] } }]))
  await test.user.click(within(choices).getByRole('checkbox', { name: 'Inactive' }))
  await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
  // The original unfiltered result can be reused from the query cache.
  expect(await screen.findByText('1–10 of 73')).toBeTruthy()
  await test.user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Status' })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})


it.each([false, true])('uses only the host-authorized create action for exact empty results (create=%s)', async create => {
  const test = await mount({ empty: true, create })
  const heading = await screen.findByRole('heading', { name: en.listS3EmptyHeading })
  const feedback = heading.parentElement!
  expect(within(feedback).queryByRole('button', { name: en.clearSearchFilters })).toBeNull()
  if (create) {
    await test.user.click(within(feedback).getByRole('button', { name: 'Create entry' }))
    expect(test.create).toHaveBeenCalledTimes(1)
    await test.user.click(screen.getAllByRole('button', { name: 'Create entry' }).find(button => !feedback.contains(button))!)
    expect(test.create).toHaveBeenCalledTimes(2)
  } else expect(screen.queryByRole('button', { name: 'Create entry' })).toBeNull()
})
it.each(['context', 'preset', 'missing', 'page', 'positive-total'] as const)('never makes a first-record claim for %s emptiness', async scope => {
  await mount({ empty: true, create: true, context: scope === 'context', missingTotals: scope === 'missing', initial: scope === 'preset' ? '/o/org/e/entries?view=active' : scope === 'page' ? '/o/org/e/entries?page=2' : undefined, total: scope === 'positive-total' ? 23 : undefined })
  const page = scope === 'page' || scope === 'positive-total'
  const heading = await screen.findByRole('heading', { name: page ? en.listS3EmptyPageHeading : en.listS3EmptyViewHeading })
  expect(screen.queryByText(en.listS3CreateHelp)).toBeNull()
  expect(within(heading.parentElement!).queryByRole('button', { name: en.clearSearchFilters })).toBeNull()
  if (page) expect(within(heading.parentElement!).queryByRole('button', { name: 'Create entry' })).toBeNull()
})
it.each(['search', 'filters', 'row-access', 'combined'] as const)('clears %s empty results through the existing transition and retains view/sort/display', async kind => {
  const search = kind === 'search' || kind === 'combined', filters = kind === 'filters' || kind === 'combined', access = kind === 'row-access' || kind === 'combined'
  const initial = '/o/org/e/entries?view=active&sort=name&direction=desc&page=2' + (search ? '&search=missing' : '') + (access ? '&rowAccess=invited' : '')
  const test = await mount({ empty: true, create: true, access, initial })
  if (filters) await act(async () => { await test.router.navigate({ to: '.', search: { ...test.router.state.location.search, filters: [{ field: 'status', predicate: { in: ['inactive'] } }], page: 2 } as any }) })
  const heading = await screen.findByRole('heading', { name: en.listS3NoMatchesHeading })
  expect(within(heading.parentElement!).queryByRole('button', { name: 'Create entry' })).toBeNull()
  const display = loadListPreferences(test.preferenceScope, 'entries', { columns: [{ id: 'name' }, { id: 'status' }], primary: 'name', compact: false }).preferences
  await test.user.click(within(heading.parentElement!).getByRole('button', { name: en.clearSearchFilters }))
  await waitFor(() => expect(test.router.state.location.search).toMatchObject({ view: 'active', sort: 'name', direction: 'desc' }))
  await screen.findByRole('heading', { name: en.listS3EmptyViewHeading })
  for (const key of ['search', 'filters', 'rowAccess', 'page'] as const) expect(test.router.state.location.search[key]).toBeUndefined()
  expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ view: 'active', offset: 0, orderBy: [{ field: 'name', dir: 'desc' }] })
  expect(loadListPreferences(test.preferenceScope, 'entries', { columns: [{ id: 'name' }, { id: 'status' }], primary: 'name', compact: false }).preferences).toEqual(display)
})
