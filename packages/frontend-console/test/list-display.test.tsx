import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

// Host zone != instance zone: every rendered instant must follow the instance.
const host = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
afterAll(() => { if (host === undefined) delete process.env.TZ; else process.env.TZ = host })
const model: Model = { instance: 'display', revision: 1, timeZone: 'Asia/Tokyo', limits: { root: 100, maxOffset: 100, children: 20, relations: 4, exists: 4 }, entities: {
  entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active'] }, created: { type: 'datetime' }, due: { type: 'date' }, amount: { type: 'number' } }, columns: ['name', 'status', 'created', 'due', 'amount'], relations: {}, routes: { list: '', detail: '' },
    list: { pageSize: 10, columns: [{ field: 'name' }, { field: 'status' }, { field: 'created', cell: { kind: 'datetime' }, defaultVisible: false }, { field: 'due', cell: { kind: 'date' } }, { field: 'amount', cell: { kind: 'number' }, defaultVisible: true }], filter: { created: { kind: 'date', placement: 'panel', operators: ['gte', 'lt'] } }, views: [{ id: 'active', label: 'Active view', where: { status: { eq: 'active' } } }] } },
} }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: Object.keys(model.entities.entries.fields), writable: [], operations: ['read'] } } }
let client: QueryClient
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(language: 'en' | 'cs' = 'en', search?: Record<string, unknown>) {
  const request = vi.fn(async (query: ReadQuery) => ({ data: [{ id: '1', name: 'Current', status: 'active', created: '2026-11-17T23:30:00Z', due: '2026-11-17', amount: 1234567.5 }], next_cursor: null, offset: query.offset, limit: query.limit, total: 73, viewTotals: { all: 73, active: 42 } }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" request={request} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) }); await router.load()
  if (search) await router.navigate({ to: '.', search: search as any })
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: { ...en, field_name: 'Name', field_status: 'Status', field_created: 'Created', field_due: 'Due', field_amount: 'Amount', value_active: 'Active' } }, cs: { translation: { ...cs, field_name: 'Name', field_status: 'Status', field_created: 'Created', field_due: 'Due', field_amount: 'Amount', value_active: 'Active' } } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await screen.findByText('Current')
  return { request, user: userEvent.setup() }
}
const headers = () => screen.getAllByRole('columnheader').map(header => header.textContent!.trim()).filter(Boolean)
const openMenu = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: en.listDisplay })); return screen.findByRole('dialog', { name: en.listDisplayHeading }) }

it('honors defaultVisible, toggles without refetching or touching rows/counts/total, and keeps the first column', async () => {
  const { request, user } = await mount()
  expect(headers()).toEqual(expect.arrayContaining(['Name', 'Status', 'Due', 'Amount']))
  expect(headers()).not.toContain('Created')
  const calls = request.mock.calls.length, query = structuredClone(request.mock.calls.at(-1)![0]), row = screen.getByText('Current')
  expect(screen.getByRole('button', { name: /Active view.*42/ })).toBeTruthy(); expect(screen.getByText(/1.*10.*73/)).toBeTruthy()
  const menu = await openMenu(user)
  expect(within(menu).queryByRole('checkbox', { name: 'Name' })).toBeNull()
  expect(within(menu).getByRole('checkbox', { name: 'Created' }).getAttribute('aria-checked')).toBe('false')
  await user.click(within(menu).getByRole('checkbox', { name: 'Created' }))
  await waitFor(() => expect(headers()).toContain('Created'))
  await user.click(within(menu).getByRole('checkbox', { name: 'Status' }))
  await waitFor(() => expect(headers()).not.toContain('Status'))
  // Presentation only: same query, no request, same mounted row, same counts and total.
  expect(request.mock.calls).toHaveLength(calls)
  expect(request.mock.calls.at(-1)![0]).toEqual(query)
  expect(screen.getByText('Current')).toBe(row)
  expect(screen.getByRole('button', { name: /Active view.*42/ })).toBeTruthy(); expect(screen.getByText(/1.*10.*73/)).toBeTruthy()
  // Reset restores the configured defaults.
  await user.click(within(menu).getByRole('button', { name: en.listDisplayReset }))
  await waitFor(() => expect(headers()).not.toContain('Created'))
  expect(headers()).toContain('Status'); expect(request.mock.calls).toHaveLength(calls)
})
it('renders date, datetime and number cells in the instance zone and locale, never the host zone', async () => {
  const { user } = await mount('cs')
  // Created is hidden by default; show it from the (Czech) menu.
  await user.click(screen.getByRole('button', { name: cs.listDisplay }))
  await user.click(within(await screen.findByRole('dialog', { name: cs.listDisplayHeading })).getByRole('checkbox', { name: 'Created' }))
  // 23:30Z on 17 Nov is 08:30 on 18 Nov in Tokyo (UTC+9) but 15:30 on the 17th in the host zone.
  expect(await screen.findByText(/18\. 11\. 2026.*8:30/)).toBeTruthy()
  expect(screen.queryByText(/17\. 11\. 2026.*15:30/)).toBeNull()
  // Date-only stays on its own calendar day, and numbers follow the locale.
  expect(screen.getByText('17. 11. 2026')).toBeTruthy()
  expect(screen.getByText(/^1\s234\s567,5$/)).toBeTruthy()
})
it('shows date filter chips and sends day boundaries for the instance zone, not the host zone', async () => {
  const { request } = await mount('cs', { filters: [{ field: 'created', predicate: { gte: '2026-11-17' } }] })
  // Midnight of 17 Nov in Tokyo is 15:00Z on the 16th; the host (Los Angeles) would send 08:00Z on the 17th.
  await waitFor(() => expect(request.mock.calls.at(-1)![0].where).toEqual({ and: [{ created: { gte: '2026-11-16T15:00:00.000Z' } }] }))
  expect(await screen.findByRole('button', { name: /17\. 11\. 2026/ })).toBeTruthy()
})

it('uses an explicit list-v2 density variant without changing the query, URL or saved settings', async () => {
  const { request, user } = await mount()
  const table = document.querySelector('[data-slot="data-table"]')!
  expect(table.getAttribute('data-list-density')).toBe('comfortable')
  const calls = request.mock.calls.length, row = screen.getByText('Current')
  const menu = await openMenu(user)
  await user.click(within(menu).getByRole('checkbox', { name: en.listDisplayCompact }))
  expect(table.getAttribute('data-list-density')).toBe('compact')
  expect(request.mock.calls).toHaveLength(calls)
  expect(screen.getByText('Current')).toBe(row)
  expect(JSON.stringify(request.mock.calls)).not.toMatch(/compact|density/)
  await user.click(within(menu).getByRole('button', { name: en.listDisplayReset }))
  expect(table.getAttribute('data-list-density')).toBe('comfortable')
})
