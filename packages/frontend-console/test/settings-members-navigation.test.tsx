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
    contractVersion: 2, console: null,
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

const model = (console: ConsoleModelContract['console'] = null): ConsoleModelContract => ({
  contractVersion: 2, console,
  model: { instance: 'test', revision: 1, locale: 'en', timeZone: 'UTC', limits: {}, entities: {}, commands: [], workflows: [] },
  capabilities: { revision: 1, organization: { role: 'admin' }, entities: {}, commands: [], workflows: {}, resources: { 'members.read': true } },
})

async function mountNavigation(path: string, documents: Record<string, ConsoleModelContract | number> = { 'org-a': model() }) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    requests.push(path)
    const match = path.match(/^\/o\/([^/]+)\/(console-model|capabilities)$/)
    if (!match) throw new Error(`Unexpected settings navigation request: ${path}`)
    const document = documents[match[1]]
    if (typeof document === 'number') return Response.json({ error: 'forbidden' }, { status: document })
    if (!document) throw new Error(`Unexpected scope: ${match[1]}`)
    return Response.json(match[2] === 'capabilities' ? document.capabilities : document)
  }))
  const i18n = createInstance()
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const root = createRootRoute()
  const global = createRoute({ getParentRoute: () => root, path: '/settings', component: () => <WorkspaceSettingsLayout /> })
  const globalProfile = createRoute({ getParentRoute: () => global, path: 'profile', component: () => <p>Global profile content</p> })
  const organization = createRoute({ getParentRoute: () => root, path: '/o/$orgId/settings', component: () => <WorkspaceSettingsLayout orgId={organization.useParams().orgId} /> })
  const profile = createRoute({ getParentRoute: () => organization, path: 'profile', component: () => <p>Organization profile content</p> })
  const members = createRoute({ getParentRoute: () => organization, path: 'workspace-members', component: () => <p>Members content</p> })
  const history = createRoute({ getParentRoute: () => organization, path: 'invitations', staticData: { settingsActiveItem: 'members' }, component: () => <p>History content</p> })
  const router = createRouter({ routeTree: root.addChildren([global.addChildren([globalProfile]), organization.addChildren([profile, members, history])]), history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  if (path.startsWith('/o/')) await waitFor(() => expect(client.getQueryState(['console-model', path.split('/')[2]])?.fetchStatus).toBe('idle'))
  return { router, requests, client }
}

it('keeps global Profile and Organizations as native links without organization requests', async () => {
  const { requests } = await mountNavigation('/settings/profile')
  const profile = await screen.findByRole('link', { name: en.profileSettings })
  expect(profile.getAttribute('href')).toBe('/settings/profile')
  expect(profile.getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('link', { name: en.organizations }).getAttribute('href')).toBe('/organizations')
  expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
  expect(requests).toEqual([])
})

it('keeps organization Profile scoped and active with a direct Members destination', async () => {
  await mountNavigation('/o/org-a/settings/profile')
  const profile = await screen.findByRole('link', { name: en.profileSettings })
  expect(profile.getAttribute('href')).toBe('/o/org-a/settings/profile')
  expect(profile.getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('link', { name: 'Members' }).getAttribute('href')).toBe('/o/org-a/settings/workspace-members')
})

it.each(['workspace-members', 'invitations'])('selects Members on the real %s route without replacing its native href', async path => {
  const { requests } = await mountNavigation(`/o/org-a/settings/${path}`)
  const members = await screen.findByRole('link', { name: 'Members' })
  expect(members.getAttribute('aria-current')).toBe('page')
  expect(members.className).toContain('wb-settings-link-active')
  expect(members.getAttribute('href')).toBe('/o/org-a/settings/workspace-members')
  expect(screen.getByRole('link', { name: en.profileSettings }).getAttribute('aria-current')).toBeNull()
  members.focus()
  expect(document.activeElement).toBe(members)
  expect(members.closest('button')).toBeNull()
  expect(requests.every(path => /^\/o\/org-a\/(console-model|capabilities)$/.test(path))).toBe(true)
})

it('does not supplement an installed registry when the Members plugin is absent', async () => {
  await mountNavigation('/o/org-a/settings/profile', { 'org-a': model({ navigation: [], pages: [], entities: {} }) })
  expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
  expect(screen.getByRole('link', { name: en.profileSettings })).toBeTruthy()
})

it('fails closed on a denied registry without requesting a denied section', async () => {
  const { requests, client } = await mountNavigation('/o/org-a/settings/profile', { 'org-a': 403 })
  await waitFor(() => expect(client.getQueryState(['console-model', 'org-a'])?.status).toBe('error'))
  expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
  expect(screen.getByRole('link', { name: en.profileSettings }).getAttribute('href')).toBe('/o/org-a/settings/profile')
  expect(requests.every(path => /^\/o\/org-a\/(console-model|capabilities)$/.test(path))).toBe(true)
})

it('replaces links and active selection on scope change without keeping an old Members link', async () => {
  const reduced = model(); reduced.capabilities.resources = {}
  const { router, requests } = await mountNavigation('/o/org-a/settings/invitations', { 'org-a': model(), 'org-b': reduced })
  expect(await screen.findByRole('link', { name: 'Members' })).toBeTruthy()
  await router.navigate({ to: '/o/$orgId/settings/profile', params: { orgId: 'org-b' } })
  await waitFor(() => expect(screen.getByRole('link', { name: en.profileSettings }).getAttribute('href')).toBe('/o/org-b/settings/profile'))
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Members' })).toBeNull())
  expect(screen.getByRole('link', { name: en.profileSettings }).getAttribute('aria-current')).toBe('page')
  expect(requests).toContain('/o/org-b/console-model')
  expect(requests.every(path => /^\/o\/org-[ab]\/(console-model|capabilities)$/.test(path))).toBe(true)
})

it.each(['Long workspace administration and organization settings label', 'Dlouhý název správy pracovního prostoru a organizačního nastavení'])('retains authorized registry grouping and long native link label: %s', async label => {
  const document = model({ navigation: [{ id: 'members', label, placement: 'settings', page: 'members.list', group: { id: 'team', label: 'Team administration' } }], pages: [{ id: 'members.list', label, path: '/settings/workspace-members' }], entities: {} })
  await mountNavigation('/o/org-a/settings/profile', { 'org-a': document })
  expect(await screen.findByRole('heading', { name: 'Team administration' })).toBeTruthy()
  expect(screen.getByRole('link', { name: label }).getAttribute('href')).toBe('/o/org-a/settings/workspace-members')
})
