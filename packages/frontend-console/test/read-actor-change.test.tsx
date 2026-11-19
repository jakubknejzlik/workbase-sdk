import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { changeSavedViews } from '../../console-generated/src/saved-views'
import { validateListSearch } from '../../console-generated/src/list-model'
import { ReadPage } from '../src/read'
import { adaptConsoleModel } from '../src/api/runtime-model'
import { organizationOptions } from '../src/api/queries'
import { viewsTrigger } from './saved-views-menu'
import en from '../src/locales/en.json'

let client: QueryClient
let unmount: (() => void) | undefined
afterEach(() => { unmount?.(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount() {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  const session = { actor: 'A', identityError: false }
  const me = () => ({ role: 'admin', user: { id: session.actor, email: `${session.actor.toLowerCase()}@example.test` }, memberships: [{ organization_id: 'org', name: 'Org', role: 'admin' }] })
  const contract = { contractVersion: 2, console: null,
    model: { instance: 'actor-test', revision: 1, locale: 'en', timeZone: 'UTC', commands: [], workflows: [], limits: { root: 100, maxOffset: 100, children: 20, relations: 4, exists: 4 }, entities: {
      entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active', 'inactive'] } }, columns: ['name', 'status'], relations: {}, routes: {}, list: { pageSize: 10, filter: { status: { kind: 'enum', placement: 'panel', operators: ['in'] } } } },
    } }, capabilities: { revision: 1, organization: { role: 'admin' }, commands: [], workflows: {}, resources: {}, entities: { entries: { readable: ['id', 'name', 'status'], writable: [], operations: ['read'] } } },
  } as unknown as ConsoleModelContract
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
  client.setQueryData(['me'], me())
  client.setQueryData(['organization', 'org'], me())
  client.setQueryData(['console-model', 'org'], adaptConsoleModel(contract))
  const actorCaches = (actor: string) => client.getQueryCache().findAll({ queryKey: ['data-table'] }).filter(query => JSON.parse(String(query.queryKey.at(-1)))[2] === actor)
  const queries: { actor: string; offset?: number; outgoingACaches: number }[] = []
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/me')) return session.identityError ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(me())
    if (path.endsWith('/console-model')) return Response.json(contract)
    if (path === '/query') { const query = JSON.parse(String(options?.body)); queries.push({ actor: session.actor, offset: query.offset, outgoingACaches: actorCaches('A').length }); return Response.json({ data: [{ id: 'one', name: `Row ${session.actor}`, status: 'active' }], next_cursor: null, total: 47, viewTotals: { all: 47 } }) }
    throw new Error(`Unexpected path: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  for (const userId of ['A', 'B']) changeSavedViews({ instance: 'actor-test', userId, orgId: 'org' }, 'entries', { kind: 'save', name: `Private ${userId}`, state: { search: '', sort: null, userFilters: [], presetFilters: [], limit: 10 } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <ReadPage orgId="org" entity="entries" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, entity_entries: 'Entries', field_name: 'Name', field_status: 'Status' } } } })
  unmount = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>).unmount
  const user = userEvent.setup()
  await screen.findByText('Row A')
  return { user, session, queries, router, actorCaches }
}

it('uses fresh scoped identity to discard panel drafts and URL paging and switch personal namespaces with identical grants', async () => {
  const { user, session, queries, router } = await mount()
  await user.click(screen.getByRole('button', { name: '3' }))
  await waitFor(() => expect(queries.at(-1)?.offset).toBe(20))
  await user.click(screen.getByRole('button', { name: en.sortAndFilter }))
  await user.click(within(screen.getByRole('group', { name: en.sortAndFilter })).getByRole('checkbox', { name: 'inactive' }))
  for (const next of ['B', 'A']) {
    session.actor = next
    await act(async () => { await client.fetchQuery({ ...organizationOptions('org'), staleTime: 0 }) })
    await waitFor(() => expect(screen.queryByRole('group', { name: en.sortAndFilter })).toBeNull())
    await screen.findByText(`Row ${next}`)
    expect(router.state.location.search.page).toBeUndefined()
    expect(queries.filter(query => query.actor === next).at(-1)?.offset).toBe(0)
    await user.click(viewsTrigger())
    const menu = screen.getByRole('dialog', { name: en.savedViews })
    expect(within(menu).getByRole('button', { name: `Private ${next}` })).toBeTruthy()
    expect(within(menu).queryByRole('button', { name: `Private ${next === 'A' ? 'B' : 'A'}` })).toBeNull()
    await user.keyboard('{Escape}')
    if (next === 'B') {
      await user.click(screen.getByRole('button', { name: '2' }))
      await waitFor(() => expect(queries.at(-1)?.offset).toBe(10))
      await user.click(screen.getByRole('button', { name: en.sortAndFilter }))
      await user.click(within(screen.getByRole('group', { name: en.sortAndFilter })).getByRole('checkbox', { name: 'inactive' }))
    }
  }
})

it.each(['B', 'A'])('recovers A → identity error → %s through the production ReadPage lifetime', async next => {
  const { user, session, queries, router, actorCaches } = await mount()
  await user.click(screen.getByRole('button', { name: '3' }))
  await waitFor(() => expect(queries.at(-1)?.offset).toBe(20))
  expect(router.state.location.search.page).toBe(3)
  const outgoingKeys = actorCaches('A').map(query => query.queryKey)
  expect(outgoingKeys.length).toBeGreaterThanOrEqual(2)

  session.identityError = true
  await act(async () => { await client.fetchQuery({ ...organizationOptions('org'), staleTime: 0 }).catch(() => {}) })
  await screen.findByRole('heading', { name: en.requestFailed })
  expect(screen.queryByText('Row A')).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  expect(router.state.location.search.page).toBe(3)
  const requestsBeforeRecovery = queries.length

  session.actor = next
  session.identityError = false
  await act(async () => { await client.fetchQuery({ ...organizationOptions('org'), staleTime: 0 }) })
  await screen.findByText(`Row ${next}`)
  expect(screen.queryByRole('heading', { name: en.requestFailed })).toBeNull()
  if (next === 'B') {
    expect.soft(router.state.location.search.page).toBeUndefined()
    const incoming = queries.slice(requestsBeforeRecovery)
    expect(incoming.length).toBeGreaterThan(0)
    expect.soft(incoming.map(query => query.offset)).toEqual(incoming.map(() => 0))
    // Teardown must finish before the recovered actor issues its first list read.
    expect.soft(incoming.map(query => query.outgoingACaches)).toEqual(incoming.map(() => 0))
    expect.soft(actorCaches('A').map(query => query.queryKey)).toEqual([])
    expect(outgoingKeys.every(queryKey => client.getQueryData(queryKey) === undefined)).toBe(true)
    expect(screen.queryByText('Row A')).toBeNull()
  } else {
    expect(router.state.location.search.page).toBe(3)
    expect(queries.at(-1)?.offset).toBe(20)
    expect(outgoingKeys.every(queryKey => client.getQueryData(queryKey) !== undefined)).toBe(true)
    await user.click(screen.getByRole('button', { name: '2' }))
    await waitFor(() => expect(queries.at(-1)?.offset).toBe(10))
    expect(router.state.location.search.page).toBe(2)
  }
})
