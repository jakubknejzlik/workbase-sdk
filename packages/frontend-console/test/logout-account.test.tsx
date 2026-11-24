import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { Frame } from '../src/frame'
import { ReadPage } from '../src/read'
import { adaptConsoleModel } from '../src/api/runtime-model'
import { organizationOptions } from '../src/api/queries'
import { validateListSearch } from '../../console-generated/src/list-model'
import { changeSavedViews, savedViewsKey } from '../../console-generated/src/saved-views'
import { listPreferencesKey } from '../../console-generated/src/list-preferences'

vi.hoisted(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, name, { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size },
    } })
  }
})
let client: QueryClient
let unmount: (() => void) | undefined
afterEach(() => { unmount?.(); client?.clear(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const scope = (userId: string, instance = 'logout-actor', orgId = 'org') => ({ instance, userId, orgId })
async function mount() {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const assign = vi.fn()
  const realWindow = window
  vi.stubGlobal('window', new Proxy(realWindow, { get: (target, key) => key === 'location' ? { origin: 'https://console.test', pathname: '/o/org/e/entries', search: '', assign } : Reflect.get(target, key) }))
  const session = { actor: 'A' }
  const me = () => ({ role: 'admin', user: { id: session.actor, email: `${session.actor}@example.test`, name: session.actor }, memberships: [{ organization_id: 'org', name: 'Org', role: 'admin' }] })
  const profile = { displayName: 'Account', completeness: { complete: true } }
  const schema = { instance: 'logout-actor', displayName: 'Test', roles: ['admin'], locale: 'en' }
  const build = { sha: 'a'.repeat(40), builtAt: '2026-11-15T00:00:00Z', revision: 1 }
  const contract = { contractVersion: 2, console: null,
    model: { instance: schema.instance, revision: 1, locale: 'en', timeZone: 'UTC', commands: [], workflows: [], limits: { root: 100, maxOffset: 100, children: 20, relations: 4, exists: 4 }, entities: {
      entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, code: { type: 'string' } }, columns: ['name', 'code'], relations: {}, routes: {}, list: { pageSize: 10, columns: [{ field: 'name' }, { field: 'code' }] } },
    } }, capabilities: { revision: 1, organization: { role: 'admin' }, commands: [], workflows: {}, resources: {}, entities: { entries: { readable: ['id', 'name', 'code'], writable: [], operations: ['read'] } } },
  } as unknown as ConsoleModelContract
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
  client.setQueryData(['me'], me()); client.setQueryData(['organization', 'org'], me())
  client.setQueryData(['profile'], profile); client.setQueryData(['instance'], schema); client.setQueryData(['build'], build)
  client.setQueryData(['bootstrap', 'org'], {}); client.setQueryData(['console-model', 'org'], adaptConsoleModel(contract)); client.setQueryData(['capabilities', 'org'], contract.capabilities)
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/auth/logout') return new Response(null, { status: 204 })
    if (path.startsWith('/me/invitations')) return Response.json({ data: [] })
    if (path === '/me/profile') return Response.json(profile)
    if (path.startsWith('/me')) return Response.json(me())
    if (path.endsWith('/console-model')) return Response.json(contract)
    if (path.endsWith('/capabilities')) return Response.json(contract.capabilities)
    if (path === '/build.json') return Response.json(build)
    if (path === '/query') return Response.json({ data: [{ id: 'one', name: `Row ${session.actor}`, code: 'Code value' }], next_cursor: null, total: 1 })
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  for (const userId of ['A', 'B']) changeSavedViews(scope(userId), 'entries', { kind: 'save', name: `Private ${userId}`, state: { search: '', sort: null, userFilters: [], presetFilters: [], limit: 10 } })
  const retained = [listPreferencesKey(scope('other'), 'entries'), listPreferencesKey(scope('A', 'other'), 'entries'), savedViewsKey(scope('other'), 'entries'), savedViewsKey(scope('A', 'other'), 'entries')]
  for (const key of retained) localStorage.setItem(key, '{}')
  localStorage.setItem('console-language', 'en')
  const root = createRootRoute({ component: Frame })
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <ReadPage orgId="org" entity="entries" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) })
  await router.load()
  unmount = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>).unmount
  await screen.findByText('Row A')
  const user = userEvent.setup()
  const hideCode = async () => {
    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Columns' })).getByRole('checkbox', { name: 'Code' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('columnheader', { name: /Code/ })).toBeNull()
    expect(JSON.parse(localStorage.getItem(listPreferencesKey(scope(session.actor), 'entries'))!).visible).toEqual(['name'])
  }
  const logout = async () => {
    await user.click(document.querySelector('[data-slot="account"] button') as HTMLElement)
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/sign-in'))
    expect(fetcher).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }))
    for (const key of retained) expect(localStorage.getItem(key)).toBe('{}')
    expect(localStorage.getItem('console-language')).toBe('en')
  }
  return { session, hideCode, logout }
}
it('organization-verified actor change then real Frame logout clears current actor and preserves previous actor', async () => {
  const { session, hideCode, logout } = await mount()
  await hideCode()
  session.actor = 'B'
  await act(async () => { await client.fetchQuery({ ...organizationOptions('org'), staleTime: 0 }) })
  await screen.findByText('Row B')
  expect(client.getQueryData<{ user: { id: string } }>(['me'])?.user.id).toBe('A')
  expect(screen.getByRole('columnheader', { name: /Code/ })).toBeTruthy()
  await hideCode()
  for (const kind of [listPreferencesKey, savedViewsKey]) expect(localStorage.getItem(kind(scope('A'), 'entries'))).not.toBeNull()
  await logout()
  for (const kind of [listPreferencesKey, savedViewsKey]) {
    expect.soft(localStorage.getItem(kind(scope('B'), 'entries'))).toBeNull()
    expect.soft(localStorage.getItem(kind(scope('A'), 'entries'))).not.toBeNull()
  }
})
it.each(['user', 'instance', 'both'] as const)('real mounted logout with missing global %s metadata preserves other accounts and instances', async missing => {
  const { hideCode, logout } = await mount()
  await hideCode()
  // Eviction of global metadata must not select a wider storage namespace.
  await act(async () => {
    if (missing !== 'instance') client.setQueryData(['me'], { user: null, memberships: [] })
    if (missing !== 'user') client.setQueryData(['instance'], {})
  })
  await logout()
  for (const kind of [listPreferencesKey, savedViewsKey]) expect(localStorage.getItem(kind(scope('A'), 'entries'))).toBeNull()
  expect(localStorage.getItem(savedViewsKey(scope('B'), 'entries'))).not.toBeNull()
})
