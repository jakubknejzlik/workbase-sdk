import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useParams } from '@tanstack/react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract, ConsolePageAction } from '../../core/src/console-contract'
import { WidgetPage } from '../src/dashboard'
import { adaptConsoleModel } from '../src/api/runtime-model'
import en from '../src/locales/en.json'

afterEach(() => { vi.unstubAllGlobals() })
type Kind = 'crud' | 'placed' | 'command'
function document(kind: Kind = 'crud', actions?: ConsolePageAction[]): ConsoleModelContract {
  const command = { name: `entries/${kind === 'placed' ? 'register' : 'process'}`, permission: { entity: 'entries', operation: 'update' }, additionalPermissions: [],
    ui: { label: kind === 'placed' ? 'Register entry' : 'Process entries', ...(kind === 'placed' ? { placement: { entity: 'entries', action: 'create' } } : {}) },
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] } }
  return {
    contractVersion: 2,
    console: { entities: {}, navigation: [{ id: 'entity.entries', label: 'Entries', entity: 'entries', view: 'open', placement: 'sidebar' }], pages: [{ id: 'summary', label: 'Summary', path: '/summary', widgets: [], actions: actions ?? [
      { id: 'work', label: 'Start work', description: 'Complete the existing operation', primary: true, icon: 'Wallet', target: kind === 'crud' ? { create: 'entries' } : { command: command.name } },
      { id: 'browse', label: 'Browse entries', icon: 'Database', target: { navigation: 'entity.entries' } },
    ] }] },
    model: { instance: 'actions', revision: 1, locale: 'en', timeZone: 'UTC', limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
      entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, writeSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] }, columns: ['name'], relations: {}, routes: {} },
    }, commands: kind === 'crud' ? [] : [command], workflows: [] },
    capabilities: { revision: 1, organization: { role: 'owner' }, entities: { entries: { operations: kind === 'crud' ? ['read', 'create'] : ['read', 'update'], readable: ['id', 'name'], writable: ['name'] } }, commands: kind === 'crud' ? [] : [command.name], resources: {}, workflows: {} },
  } as unknown as ConsoleModelContract
}
async function setup(kind: Kind = 'crud', initial = document(kind)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  let next = initial, status = 200, release: (() => void) | undefined, gate: Promise<void> | undefined
  const writes: { path: string; body: any; headers: any }[] = []
  client.setQueryData(['console-model', 'org'], adaptConsoleModel(next))
  client.setQueryData(['organization', 'org'], { user: { id: 'owner' }, memberships: [{ organization_id: 'org' }] })
  vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/me?scope=organization') return Response.json(client.getQueryData(['organization', 'org']))
    if (path.endsWith('/console-model')) return Response.json(next)
    if (path.includes('/console-pages/')) return Response.json({ id: 'summary', label: 'Summary', widgets: [] })
    if (path === '/query') return Response.json({ data: [] })
    if (path.startsWith('/api/') || path.startsWith('/commands/')) {
      writes.push({ path, body: JSON.parse(String(options?.body)), headers: options?.headers }); await gate
      return Response.json(status === 200 ? { id: 'new', name: 'Ada' } : { error: 'validation_error' }, { status })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', command_name: 'Name', entitySingular_entries: 'Entry' } } } })
  const root = createRootRoute()
  const summary = createRoute({ getParentRoute: () => root, path: '/o/$orgId/summary', component: () => <WidgetPage orgId={useParams({ strict: false }).orgId!} page={initial.console!.pages[0]} /> })
  const entries = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/entries', component: () => <h1>Destination</h1> })
  const router = createRouter({ routeTree: root.addChildren([summary, entries]), history: createMemoryHistory({ initialEntries: ['/o/org/summary'] }) })
  await router.load()
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await screen.findByRole('heading', { name: 'Summary' })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  const update = async (value: ConsoleModelContract) => { next = value; await act(async () => { client.setQueryData(['console-model', 'org'], adaptConsoleModel(next)) }) }
  return { client, router, view, writes, update, initial, hold: () => { gate = new Promise(resolve => { release = resolve }) }, release: () => release?.(), status: (value: number) => { status = value }, cleanup: () => { release?.(); view.unmount(); client.clear() } }
}
const region = () => screen.getByRole('region', { name: 'Quick actions' })
const start = () => within(region()).getByRole('button', { name: /Start work/ })
it.each([0, 1, 2])('renders %s projected actions, with only the configured primary in the header', async count => {
  const doc = document(); doc.console!.pages[0].actions = doc.console!.pages[0].actions!.slice(0, count)
  const test = await setup('crud', doc)
  try {
    if (!count) expect(screen.queryByRole('region', { name: 'Quick actions' })).toBeNull()
    else {
      expect(region().querySelectorAll('a,button')).toHaveLength(count)
      expect(screen.getAllByRole('button', { name: /Start work/ })).toHaveLength(2)
      expect(region().querySelector('button button, a button, button a, a a')).toBeNull()
    }
  } finally { test.cleanup() }
})
it('navigates the current org and named view using TanStack Router', async () => {
  const test = await setup()
  try {
    await userEvent.setup().click(within(region()).getByRole('link', { name: /Browse entries/ }))
    await screen.findByRole('heading', { name: 'Destination' })
    expect(test.router.state.location.pathname).toBe('/o/org/e/entries')
    expect(test.router.state.location.search).toEqual({ view: 'open' })
  } finally { test.cleanup() }
})
it.each(['crud', 'placed', 'command'] as const)('%s opens the existing form and restores keyboard focus after cancel', async kind => {
  const test = await setup(kind), user = userEvent.setup()
  try {
    const trigger = start(); trigger.focus(); await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(globalThis.document.activeElement).toBe(trigger))
    expect(test.writes).toHaveLength(0)
  } finally { test.cleanup() }
})
it.each(['crud', 'placed', 'command'] as const)('%s validates, guards double submit, shows save error and succeeds through the existing lifecycle', async kind => {
  const test = await setup(kind)
  try {
    fireEvent.click(start())
    const dialog = await screen.findByRole('dialog'), input = within(dialog).getByRole('textbox', { name: 'Name' }), form = input.closest('form')!
    fireEvent.submit(form); await act(async () => {})
    expect(test.writes).toHaveLength(0)
    expect(within(dialog).getByText(en.invalidField)).toBeTruthy()
    fireEvent.change(input, { target: { value: 'Ada' } }); test.hold(); test.status(400)
    fireEvent.submit(form); fireEvent.submit(form)
    await waitFor(() => expect(test.writes).toHaveLength(1))
    expect(within(dialog).getAllByRole('button').some(button => button.getAttribute('aria-busy') === 'true' || button.hasAttribute('disabled'))).toBe(true)
    await act(async () => test.release())
    await within(dialog).findByRole('alert')
    expect(input).toHaveProperty('value', 'Ada')
    test.status(200); fireEvent.submit(form)
    await waitFor(() => expect(test.writes).toHaveLength(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(test.writes[0].path).toBe(kind === 'crud' ? '/api/entries' : `/commands/entries/${kind === 'placed' ? 'register' : 'process'}`)
    expect(test.writes[0].headers['X-Organization-Id']).toBe('org')
    expect(test.writes[1].body.name).toBe('Ada')
  } finally { test.cleanup() }
})
it.each(['crud', 'placed', 'command'] as const)('%s removes revoked actions, closes the dialog and denies stale submit', async kind => {
  const test = await setup(kind)
  try {
    fireEvent.click(start()); const input = await screen.findByRole('textbox', { name: 'Name' }), form = input.closest('form')!
    fireEvent.change(input, { target: { value: 'Private draft' } })
    const revoked = structuredClone(test.initial); revoked.console!.pages[0].actions = []
    await test.update(revoked)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('region', { name: 'Quick actions' })).toBeNull()
    fireEvent.submit(form); await act(async () => {})
    expect(test.writes).toHaveLength(0)
  } finally { test.cleanup() }
})
it('retains a draft across revision refresh and discards it on actor or org replacement', async () => {
  const test = await setup()
  try {
    fireEvent.click(start()); const input = await screen.findByRole('textbox', { name: 'Name' })
    fireEvent.change(input, { target: { value: 'Draft' } })
    const next = structuredClone(test.initial); next.model.revision = 2; next.capabilities.revision = 2
    await test.update(next)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input)
    expect(input).toHaveProperty('value', 'Draft')
    await act(async () => { test.client.setQueryData(['organization', 'org'], { user: { id: 'other' }, memberships: [{ organization_id: 'org' }] }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(start()); await screen.findByRole('dialog')
    await act(async () => { test.router.history.push('/o/other/summary'); await test.router.load() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(test.writes).toHaveLength(0)
  } finally { test.cleanup() }
})
it('does not promote a secondary after primary denial and keeps long labels intact', async () => {
  const doc = document(); const label = 'Velmi dlouhý název dostupné akce bez zkrácení nebo překrytí'
  doc.console!.pages[0].actions = [{ id: 'browse', label, target: { navigation: 'entity.entries' } }]
  const test = await setup('crud', doc)
  try {
    expect(within(region()).getByRole('link', { name: label })).toBeTruthy()
    expect(screen.getAllByRole('link', { name: label })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Start work/ })).toBeNull()
  } finally { test.cleanup() }
})
