import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider } from 'react-i18next'
import { createInstance } from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { WorkspaceSettingsLayout } from '../src/settings'
import en from '../src/locales/en.json'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

it.each([
  ['admin', true, true], ['owner', true, true], ['auditor', true, true],
  ['admin', false, false], ['admin', undefined, false], ['member', true, false],
  [undefined, true, false], [null, true, false], ['', true, false], ['   ', true, false],
  [0, true, false], [1, true, false], [false, true, false], [true, true, false], [{}, true, false], [[], true, false],
])('Settings role=%j members.read=%s shows Members=%s without a server registry', async (role, grant, expected) => {
  // Exercise the actual HTTP boundary, including values outside the static contract.
  const organization = (role === undefined ? {} : { role }) as ConsoleModelContract['capabilities']['organization']
  const document: ConsoleModelContract = {
    contractVersion: 1, console: null,
    model: { instance: 'test', revision: 1, locale: 'en', timeZone: 'UTC', limits: {}, entities: {}, commands: [], workflows: [] },
    capabilities: { revision: 1, organization, entities: {}, commands: [], workflows: {}, resources: grant === undefined ? {} : { 'members.read': grant as boolean } },
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
  await waitFor(() => {
    expect(client.getQueryState(['console-model', 'org-a'])?.status).toBe('success')
    expect(client.getQueryState(['capabilities', 'org-a'])?.status).toBe('success')
  })
  if (expected) expect((await screen.findByRole('link', { name: 'Members' })).getAttribute('href')).toBe('/o/org-a/settings/workspace-members')
  else expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
})
