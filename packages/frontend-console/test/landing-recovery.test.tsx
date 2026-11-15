import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { routeTree } from '../src/routeTree.gen'
import type { Me } from '../src/api/queries'

// Node 25 may expose storage globals without backing files.
vi.hoisted(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, name, { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } })
  }
})

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
})

async function mount(path: string, me: Me | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const replace = vi.fn()
  const assign = vi.fn()
  const originalWindow = window
  vi.stubGlobal('window', new Proxy(originalWindow, { get: (target, key) => key === 'location'
    ? { pathname: path, search: '', hash: '', origin: target.location.origin, replace, assign }
    : key === 'scrollTo' ? () => {} : Reflect.get(target, key) }))
  const fetch = vi.fn(async (url: string) => {
    if (url === '/me') return me ? Response.json(me) : Response.json({ error: 'unauthorized' }, { status: 401 })
    if (url === '/me/invitations') return Response.json({ data: [], next: '/organizations' })
    if (url === '/me/profile') return Response.json({ displayName: 'Admin', completeness: { complete: true } })
    if (url === '/console-info') return Response.json({ instance: 'test', displayName: 'Test', roles: ['admin'], locale: 'en' })
    if (url === '/build.json') return Response.json({ sha: 'a'.repeat(40), builtAt: '2026-11-15T00:00:00Z', revision: 1 })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { client, router, replace, assign, fetch }
}

const account: Me = { organizationsEnabled: false, user: { id: 'admin', email: 'admin@example.test' }, memberships: [] }

it('a Members-only account without memberships or invitations reaches stable instance-access onboarding', async () => {
  const { client, router, replace } = await mount('/', account)
  await waitFor(() => expect(client.getQueryData(['invitation-inbox'])).toMatchObject({ data: [] }))
  expect(replace).not.toHaveBeenCalledWith('/')
  await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith('/organizations'))
  // Follow the document replacement through the same production route tree.
  await router.navigate({ to: '/organizations' })
  expect(await screen.findByRole('heading', { name: 'Join your team' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Create organization' })).toBeNull()
  expect(replace).toHaveBeenCalledTimes(1)
})

it('a cold top-level 404 fetches identity and recovers to the Members-only instance Overview', async () => {
  const me = { ...account, memberships: [{ organization_id: 'instance', name: 'Instance', role: 'admin' }] }
  const { client, fetch, replace, assign } = await mount('/missing-page', me)
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy()
  await waitFor(() => expect(within(screen.getByRole('main')).getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe('/o/instance'))
  expect(fetch).toHaveBeenCalledWith('/me', expect.anything())
  expect(client.getQueryData(['me'])).toEqual(me)
  expect(replace).not.toHaveBeenCalled()
  expect(assign).not.toHaveBeenCalled()
})

it('an anonymous cold 404 reads identity without navigating on a 401', async () => {
  const { client, assign, replace, fetch } = await mount('/missing-page', null)
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy()
  await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('error'))
  expect(fetch).toHaveBeenCalledWith('/me', expect.anything())
  expect(assign).not.toHaveBeenCalled()
  expect(replace).not.toHaveBeenCalled()
})
