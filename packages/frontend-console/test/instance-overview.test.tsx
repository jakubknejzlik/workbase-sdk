import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { adaptConsoleModel } from '../src/api/runtime-model'
import { PluginPage } from '../src/console-pages'

// A Members-only composition has no console provider; /console-model returns
// console:null, with the authenticated model and admin capability projection.
const document: ConsoleModelContract = {
  contractVersion: 1, console: null,
  model: { instance: 'test', revision: 1, locale: 'en', timeZone: 'UTC', limits: {}, entities: {}, commands: [], workflows: [] },
  capabilities: { revision: 1, organization: { role: 'admin' }, entities: {}, commands: [], workflows: {}, resources: {} },
}

it.each(['/o/instance', '/o/instance/'])('%s renders the built-in overview for a Members-only admin', async path => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['console-model', 'instance'], adaptConsoleModel(document))
  client.setQueryData(['capabilities', 'instance'], document.capabilities)
  client.setQueryData(['organization', 'instance'], { user: { id: 'admin' }, memberships: [{ organization_id: 'instance', name: 'Instance', role: 'admin' }] })
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/', component: () => <PluginPage orgId="instance" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  expect(await screen.findByRole('heading', { name: 'p2Overview' })).toBeTruthy()
  expect(screen.queryByText('notFound')).toBeNull()
  expect(adaptConsoleModel(document).console.navigation).toContainEqual(expect.objectContaining({ page: 'core.overview', placement: 'sidebar' }))
  client.clear()
})

it('an installed console provider continues to own its home and navigation', () => {
  const registry = { entities: {}, pages: [{ id: 'custom.home', path: '/', label: 'Custom', renderer: 'custom.home' }], navigation: [] }
  expect(adaptConsoleModel({ ...document, console: registry }).console).toBe(registry)
})

it('the fallback keeps member navigation limited to readable entities', () => {
  const registry = adaptConsoleModel({ ...document, capabilities: { ...document.capabilities, organization: { role: 'member' } } }).console
  expect(registry.navigation.some(item => item.page === 'core.overview')).toBe(false)
})
