import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider } from 'react-i18next'
import { createInstance } from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { WorkspaceSettingsLayout } from '../src/settings'
import en from '../src/locales/en.json'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

it('Settings links an authorized admin to Members when the server has no console registry', async () => {
  const document: ConsoleModelContract = {
    contractVersion: 1, console: null,
    model: { instance: 'test', revision: 1, locale: 'en', timeZone: 'UTC', limits: {}, entities: {}, commands: [], workflows: [] },
    capabilities: { revision: 1, organization: { role: 'admin' }, entities: {}, commands: [], workflows: {}, resources: { 'members.read': true } },
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/o/org-a/console-model') return Response.json(document)
    if (path === '/o/org-a/capabilities') return Response.json(document.capabilities)
    throw new Error(`Unexpected request: ${path}`)
  }))
  const i18n = createInstance()
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/settings', component: () => <WorkspaceSettingsLayout orgId="org-a" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org-a/settings'] }) })
  await router.load()
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  expect((await screen.findByRole('link', { name: 'Members' })).getAttribute('href')).toBe('/o/org-a/settings/workspace-members')
})
