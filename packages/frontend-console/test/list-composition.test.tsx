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
const model: Model = { instance: 'composition', revision: 1, limits: { root: 100, maxOffset: 40, children: 20, relations: 4, exists: 4 }, entities: {
  entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active', 'inactive'] }, quick: { type: 'bool' } }, columns: ['name', 'status'], relations: {}, routes: { list: '', detail: '' }, list: { pageSize: 10, columns: [{ field: 'name' }, { field: 'status' }], filter: { status: { kind: 'enum', placement: 'panel', operators: ['in'] }, quick: { kind: 'boolean', placement: 'toolbar', operators: ['eq'] } }, views: [{ id: 'active', label: 'Active view', where: { status: { eq: 'active' } } }] } },
} }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: Object.keys(model.entities.entries.fields), writable: [], operations: ['read'] } } }
let client: QueryClient
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount() {
  let mode = 'success', release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const request = vi.fn(async (query: ReadQuery) => {
    await gate
    if (mode !== 'success') throw Object.assign(new Error(mode), { code: mode, status: mode === 'denied' ? 403 : 400 })
    return { data: [{ id: String((query as any).offset ?? 0), name: `Current ${query.search?.text ?? ''}`, status: 'active' }], next_cursor: null, offset: (query as any).offset, limit: query.limit, total: 73, viewTotals: { all: 73, active: 42 } }
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" request={request} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', field_status: 'Status', field_quick: 'Quick', value_active: 'Active', value_inactive: 'Inactive' } } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await screen.findByText('Current')
  return { router, request, user: userEvent.setup(), hold: () => { gate = new Promise(resolve => { release = resolve }) }, release: () => { release?.(); gate = undefined }, fail: (value: string) => { mode = value } }
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
  await test.user.click(screen.getByRole('option', { name: en.yes, exact: true }))
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'quick', predicate: { eq: true } }]))
  expect(within(panel).getByRole('checkbox', { name: 'Inactive' })).toHaveProperty('checked', true)
  await test.user.click(within(panel).getByRole('button', { name: en.cancel }))
  expect(test.router.state.location.search.filters).toEqual([{ field: 'quick', predicate: { eq: true } }])
})
it('merges Apply into latest confirmed state once, resets paging, and restores it through history', async () => {
  const test = await mount()
  await test.user.click(screen.getByRole('button', { name: '3', exact: true }))
  await waitFor(() => expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 20, includeTotal: true, includeViewTotals: true }))
  const panel = await openPanel(test.user)
  await test.user.click(within(panel).getByRole('checkbox', { name: 'Inactive' }))
  await test.user.click(screen.getByRole('button', { name: /Active view/ }))
  const before = test.request.mock.calls.length
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.request.mock.calls).toHaveLength(before + 1))
  expect(test.request.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 0, view: 'active', where: { and: [{ status: { in: ['inactive'] } }] } })
  expect(test.router.state.location.search.view).toBe('active')
  await act(async () => test.router.history.back())
  await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
  await act(async () => test.router.history.forward())
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'status', predicate: { in: ['inactive'] } }]))
})
it('uses exact server counts and total, caps reachable pages, and orders the shared slots', async () => {
  await mount()
  expect(screen.getByRole('button', { name: /Active view.*42/ })).toBeTruthy()
  expect(screen.getByText(/1.*10.*73/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '6', exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: /Filter column.*Status/ })).toBeNull()
  const slots = [...document.querySelectorAll('[data-list-slot]')].map(node => node.getAttribute('data-list-slot'))
  expect(slots).toEqual(['tabs', 'toolbar', 'chips', 'table', 'footer'])
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
