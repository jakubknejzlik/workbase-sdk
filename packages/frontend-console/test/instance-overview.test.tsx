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
  contractVersion: 2, console: null,
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

it.each(['admin', 'member'])('an installed console provider continues to own its home and navigation for %s', role => {
  const registry = { entities: {}, pages: [{ id: 'custom.home', path: '/', label: 'Custom', renderer: 'custom.home' }], navigation: [{ id: 'custom.home', placement: 'settings' as const, page: 'custom.home', label: 'Custom' }] }
  const original = structuredClone(registry)
  expect(adaptConsoleModel({ ...document, console: registry, capabilities: { ...document.capabilities, organization: { role }, resources: { 'members.read': true } } }).console).toBe(registry)
  expect(registry).toEqual(original)
})

it('the fallback keeps member navigation limited to readable entities', () => {
  const registry = adaptConsoleModel({ ...document, capabilities: { ...document.capabilities, organization: { role: 'member' }, resources: { 'members.read': true } } }).console
  expect(registry.pages).toContainEqual(expect.objectContaining({ id: 'members.list' }))
  expect(registry.navigation.some(item => item.page === 'core.overview')).toBe(false)
  expect(registry.navigation.some(item => item.placement === 'settings')).toBe(false)
  expect(registry.navigation.some(item => item.page === 'members.list')).toBe(false)
})

it.each(['admin', 'owner', 'auditor'])('the fallback includes the authorized Members page and settings navigation for %s', role => {
  const registry = adaptConsoleModel({ ...document, capabilities: { ...document.capabilities, organization: { role }, resources: { 'members.read': true } } }).console
  expect(registry.pages).toContainEqual(expect.objectContaining({ id: 'members.list', path: '/settings/workspace-members', grant: 'members.read' }))
  expect(registry.navigation).toContainEqual(expect.objectContaining({ id: 'members.list', page: 'members.list', placement: 'settings', grant: 'members.read' }))
})

it.each([undefined, null, '', '   ', 0, 1, false, true, {}, []])('the fallback omits Members navigation for a malformed role (%j) despite a read grant', role => {
  // Malformed HTTP data can violate the contract's static role type.
  const organization = (role === undefined ? {} : { role }) as ConsoleModelContract['capabilities']['organization']
  const registry = adaptConsoleModel({ ...document, capabilities: { ...document.capabilities, organization, resources: { 'members.read': true } } }).console
  expect(registry.navigation.some(item => item.page === 'members.list')).toBe(false)
})

it.each([undefined, false])('the fallback omits Members without a read grant (%s)', grant => {
  const resources: Record<string, boolean> = grant === undefined ? {} : { 'members.read': grant }
  const registry = adaptConsoleModel({ ...document, capabilities: { ...document.capabilities, resources } }).console
  expect(registry.pages.some(page => page.id === 'members.list')).toBe(false)
  expect(registry.navigation.some(item => item.page === 'members.list')).toBe(false)
})

it('requires the canonical v2 console wire contract', () => {
  expect(() => adaptConsoleModel({ ...document, contractVersion: 1 } as unknown as ConsoleModelContract)).toThrow('Unsupported console contract')
  expect(adaptConsoleModel(document).contractVersion).toBe(2)
})
