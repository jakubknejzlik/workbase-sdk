import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { Frame } from '../src/frame'
import { Failure } from '../src/screens'
import { PluginPage } from '../src/console-pages'
import { adaptConsoleModel } from '../src/api/runtime-model'

// Node 25 exposes storage globals without backing files in this test runner.
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

afterEach(() => vi.unstubAllGlobals())
it.each([
  { organizationsEnabled: false, scopes: ['instance'], home: '/o/instance' },
  { organizationsEnabled: true, scopes: ['org-a'], home: '/o/org-a' },
  { organizationsEnabled: true, scopes: ['org-a', 'org-b'], home: '/organizations' },
])('the real frame supplies recovery home $home and renders its Overview navigation', async ({ organizationsEnabled, scopes, home }) => {
  const orgId = scopes[0]
  const me = { organizationsEnabled, role: 'admin', user: { id: 'admin', email: 'admin@example.test', name: 'Admin' }, memberships: scopes.map(organization_id => ({ organization_id, name: organization_id, role: 'admin' })) }
  const profile = { displayName: 'Admin', completeness: { complete: true } }
  const document: ConsoleModelContract = {
    contractVersion: 1, console: null,
    model: { instance: 'test', revision: 1, locale: 'en', timeZone: 'UTC', entities: {}, commands: [], workflows: [], limits: {} },
    capabilities: { revision: 1, organization: { role: 'admin' }, entities: {}, commands: [], workflows: {}, resources: { 'console.overview': true } },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['me'], me)
  client.setQueryData(['profile'], profile)
  client.setQueryData(['instance'], { instance: 'test', displayName: 'Test', roles: ['admin'], locale: 'en' })
  client.setQueryData(['build'], { sha: 'a'.repeat(40), builtAt: '2026-11-15T00:00:00Z', revision: 1 })
  client.setQueryData(['bootstrap', orgId], {})
  client.setQueryData(['console-model', orgId], adaptConsoleModel(document))
  client.setQueryData(['capabilities', orgId], document.capabilities)
  client.setQueryData(['organization', orgId], me)
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/me/profile') return Response.json(profile)
    if (path.startsWith('/me')) return Response.json(me)
    if (path.endsWith('/capabilities')) return Response.json(document.capabilities)
    if (path.endsWith('/console-model')) return Response.json(document)
    throw new Error(`Unexpected request: ${path}`)
  }))
  const root = createRootRoute({ component: Frame })
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/', component: () => <><PluginPage orgId={orgId} /><Failure kind="notFound" /></> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`/o/${orgId}`] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  expect(await screen.findByRole('heading', { name: 'Overview', level: 2 })).toBeTruthy()
  const main = screen.getByRole('main')
  expect(within(main).getByRole('link', { name: home === '/organizations' ? 'Organizations' : 'Overview' }).getAttribute('href')).toBe(home)
  expect(screen.getAllByRole('link', { name: 'Overview' }).some(link => !main.contains(link))).toBe(true)
  client.clear()
})
