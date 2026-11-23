import { Profiler } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useParams } from '@tanstack/react-router'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { Frame } from '../src/frame'
import { ReadPage } from '../src/read'
import { adaptConsoleModel } from '../src/api/runtime-model'
import { validateListSearch } from '../../console-generated/src/list-model'

vi.hoisted(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, name, { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => { values.delete(key) },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size },
    } })
  }
})
let client: QueryClient
let release: (() => void) | undefined
afterEach(() => { release?.(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('purges both visited views and access identities across the real org-keyed Frame/ReadPage remount', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  // Keep authority timestamps stable: a clock tick must not conceal retained owners.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const me = { role: 'admin', user: { id: 'A', email: 'a@example.test', name: 'A' }, memberships: ['org', 'other'].map(organization_id => ({ organization_id, name: organization_id, role: 'admin' })) }
  const profile = { displayName: 'A', completeness: { complete: true } }
  const schema = { instance: 'teardown', displayName: 'Test', roles: ['admin'], locale: 'en' }
  const build = { sha: 'a'.repeat(40), builtAt: '2026-11-15T00:00:00Z', revision: 1 }
  const contract = {
    contractVersion: 2, console: null,
    model: { instance: 'teardown', revision: 1, locale: 'en', timeZone: 'UTC', commands: [], workflows: [], limits: { root: 100, maxOffset: 100, children: 20, relations: 4, exists: 4 }, entities: {
      entries: { displayField: 'name', rowAccess: true, rowInvitations: true, accountLink: { field: 'user', entity: 'accounts' },
        fields: { id: { type: 'string' }, name: { type: 'string' }, user: { type: 'ref', entity: 'accounts' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' },
        list: { pageSize: 10, columns: [{ field: 'name' }], views: [{ id: 'active', label: 'Active view', where: { name: { eq: 'active' } } }] } },
    } },
    capabilities: { revision: 1, organization: { role: 'admin' }, commands: [], workflows: {}, resources: { 'invitations.read': true }, entities: { entries: { readable: ['id', 'name'], writable: [], operations: ['read'] } } },
  } as unknown as ConsoleModelContract
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
  client.setQueryData(['me'], me); client.setQueryData(['profile'], profile)
  client.setQueryData(['instance'], schema); client.setQueryData(['build'], build)
  for (const org of ['org', 'other']) {
    client.setQueryData(['bootstrap', org], {})
    client.setQueryData(['console-model', org], adaptConsoleModel(contract))
    client.setQueryData(['capabilities', org], contract.capabilities)
  }
  let gate: Promise<void> | undefined
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    const org = new Headers(options?.headers).get('X-Organization-Id') ?? 'org'
    if (path === '/query') {
      const view = JSON.parse(String(options?.body)).view ?? 'all'
      await gate
      return Response.json({ data: [{ id: view, name: `ROW_${org}_${view}` }], next_cursor: null, total: org === 'org' ? 71 : 33, viewTotals: { all: 71, active: 70 } })
    }
    if (path.includes('/row-access/')) { await gate; return Response.json({ state: 'signed_in', inconsistency: null, can_invite: false, can_cancel: false, linked_accounts: [{ id: org, label: `ACCESS_${org}` }] }) }
    if (path.startsWith('/me/invitations')) return Response.json({ data: [] })
    if (path === '/me/profile') return Response.json(profile)
    if (path.startsWith('/me')) return Response.json(me)
    if (path.endsWith('/console-model')) return Response.json(contract)
    if (path.endsWith('/capabilities')) return Response.json(contract.capabilities)
    if (path === '/build.json') return Response.json(build)
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const snapshots: string[] = []
  function Page() {
    const { orgId, entity } = useParams({ strict: false })
    // Enforce Frame's keyed subtree lifetime even if Router publishes child params first.
    return <Profiler id="read" onRender={() => { snapshots.push(document.body.textContent ?? '') }}><ReadPage key={orgId} orgId={orgId!} entity={entity!} /></Profiler>
  }
  const root = createRootRoute({ component: Frame })
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: Page })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByText('ROW_org_all'); await screen.findByText('ACCESS_org')
  await act(async () => { await router.navigate({ to: '.', search: { view: 'active' } as any }) })
  await screen.findByText('ROW_org_active'); await screen.findByText('ACCESS_org')
  const oldKeys = client.getQueryCache().getAll().filter(query => query.queryKey[0] === 'data-table' || query.queryKey[0] === 'row-access').map(query => query.queryKey)
  expect(oldKeys.filter(key => key[0] === 'data-table')).toHaveLength(2)
  expect(oldKeys.filter(key => key[0] === 'row-access')).toHaveLength(2)
  await act(async () => { await router.navigate({ to: '/o/$orgId/e/$entity', params: { orgId: 'other', entity: 'entries' } }) })
  await screen.findByText('ROW_other_all'); await screen.findByText('ACCESS_other')
  // The observer must outlive RuntimeLocalization's org key and remove *all* old views.
  expect.soft(oldKeys.filter(queryKey => client.getQueryData(queryKey) !== undefined)).toEqual([])
  gate = new Promise(resolve => { release = resolve })
  snapshots.length = 0
  await act(async () => { await router.navigate({ to: '/o/$orgId/e/$entity', params: { orgId: 'org', entity: 'entries' } }) })
  expect.soft(screen.queryByText('ROW_org_all')).toBeNull()
  expect.soft(screen.queryByText('ACCESS_org')).toBeNull()
  expect.soft(screen.queryByText(/of 71/)).toBeNull()
  expect.soft(snapshots.filter(text => text.includes('ROW_org_') || text.includes('ACCESS_org'))).toEqual([])
  await waitFor(() => expect(client.isFetching({ queryKey: ['data-table'] })).toBeGreaterThan(0))
  await act(async () => { release?.(); gate = undefined })
  expect(await screen.findByText('ROW_org_all')).toBeTruthy()
  expect(await screen.findByText('ACCESS_org')).toBeTruthy()
})
