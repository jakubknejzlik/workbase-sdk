import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { ReadPage } from '../src/read'
import { adaptConsoleModel } from '../src/api/runtime-model'
import type { Me } from '../src/api/queries'
import en from '../src/locales/en.json'

let client: QueryClient
let unmount: (() => void) | undefined
afterEach(() => { unmount?.(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

async function mount(loaded = true) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const identity: Me = { user: { id: 'actor', email: 'actor@example.test' }, role: 'admin', memberships: [{ organization_id: 'org', name: 'Organization', role: 'admin' }] }
  const contract = { contractVersion: 2, console: null,
    model: { instance: 'poll-write-test', revision: 1, locale: 'en', timeZone: 'UTC', commands: [], workflows: [], limits: { root: 100, maxOffset: 100, children: 20, relations: 4, exists: 4 }, entities: {
      entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
    } }, capabilities: { revision: 1, organization: { role: 'admin' }, commands: [], workflows: {}, resources: {}, entities: { entries: { readable: ['id', 'name'], writable: [], operations: ['read', 'delete'] } } },
  } as unknown as ConsoleModelContract
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  if (loaded) client.setQueryData(['organization', 'org'], identity)
  client.setQueryData(['console-model', 'org'], adaptConsoleModel(contract))
  const poll = deferred<Response>(), deletion = deferred<Response>()
  let identityRequests = 0, pollResolved = false
  const deletes: { path: string; options: RequestInit | undefined }[] = []
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/me?scope=organization') {
      identityRequests++
      if (loaded && identityRequests === 1) return Response.json(identity)
      return poll.promise
    }
    if (path === '/query') return Response.json({ data: [{ id: 'one', name: 'Sample entry' }], next_cursor: null })
    if (path === '/api/entries/one' && options?.method === 'DELETE') { deletes.push({ path, options }); return deletion.promise }
    throw new Error(`Unexpected request: ${options?.method} ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity/$id', component: () => <ReadPage orgId="org" entity="entries" id="one" /> })
  const listRoute = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', component: () => <p>Entries</p> })
  const router = createRouter({ routeTree: root.addChildren([route, listRoute]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries/one'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, entity_entries: 'Entries', field_name: 'Name' } } } })
  unmount = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>).unmount
  const user = userEvent.setup()
  if (loaded) {
    await screen.findByRole('heading', { name: 'Sample entry' })
    await waitFor(() => expect(client.getQueryState(['organization', 'org'])?.fetchStatus).toBe('idle'))
  }
  return { user, identity, contract, deletes, finishDelete: () => deletion.resolve(new Response(null, { status: 204 })), pollResolved: () => pollResolved,
    waitForPoll: () => waitFor(() => expect(identityRequests).toBe(loaded ? 2 : 1), { timeout: 4_000 }),
    resolvePoll: async (response: Response) => { await act(async () => { pollResolved = true; poll.resolve(response); await poll.promise }); await waitFor(() => expect(client.getQueryState(['organization', 'org'])?.fetchStatus).toBe('idle')) },
  }
}

async function openDelete(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: en.rowActions.replace('{{name}}', 'Sample entry') }))
  await user.click(screen.getByRole('menuitem', { name: en.delete }))
  return screen.findByRole('alertdialog', { name: en.deleteRecord })
}

it('confirms exactly one DELETE while the actual organization interval poll is still in flight', async () => {
  const view = await mount(), dialog = await openDelete(view.user)
  await view.waitForPoll()
  expect(client.getQueryState(['organization', 'org'])?.fetchStatus).toBe('fetching')
  expect(client.getQueryState(['organization', 'org'])?.status).toBe('success')
  await view.user.click(within(dialog).getByRole('button', { name: en.delete }))
  await waitFor(() => expect(view.deletes).toHaveLength(1))
  expect(view.deletes[0]).toMatchObject({ path: '/api/entries/one', options: { method: 'DELETE', headers: { 'X-Organization-Id': 'org' } } })
  expect(view.pollResolved()).toBe(false)
  expect(client.getQueryState(['organization', 'org'])?.fetchStatus).toBe('fetching')
  await view.resolvePoll(Response.json(view.identity))
  await act(async () => { view.finishDelete() })
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(view.deletes).toHaveLength(1)
})

it('sends zero DELETE requests before identity has loaded', async () => {
  const view = await mount(false)
  await view.waitForPoll()
  expect(client.getQueryState(['organization', 'org'])?.status).toBe('pending')
  expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(view.deletes).toHaveLength(0)
})

it.each(['error', 'missing user', 'foreign organization', 'permission removed'] as const)('sends zero DELETE requests with %s', async state => {
  const view = await mount()
  await openDelete(view.user)
  if (state === 'error') {
    await view.waitForPoll()
    await view.resolvePoll(Response.json({ error: 'unavailable' }, { status: 503 }))
    expect(client.getQueryState(['organization', 'org'])?.status).toBe('error')
  } else if (state === 'missing user' || state === 'foreign organization') {
    await act(async () => { client.setQueryData(['organization', 'org'], state === 'missing user' ? { ...view.identity, user: null } : { ...view.identity, memberships: [{ organization_id: 'other', name: 'Other', role: 'admin' }] }) })
  } else if (state === 'permission removed') {
    await act(async () => { client.setQueryData(['console-model', 'org'], adaptConsoleModel({ ...view.contract, capabilities: { ...view.contract.capabilities, entities: { entries: { ...view.contract.capabilities.entities.entries, operations: ['read'] } } } })) })
  }
  if (state !== 'foreign organization') await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  const dialog = screen.queryByRole('alertdialog')
  if (dialog) {
    const confirm = within(dialog).getByRole('button', { name: en.delete })
    await view.user.click(confirm)
    await screen.findByText(en.requestFailed)
    // Repeated programmatic submission must also refuse the write.
    await act(async () => { fireEvent.submit(dialog.querySelector('form')!) })
    await screen.findByText(en.requestFailed)
  } else {
    expect(screen.queryByRole('button', { name: en.delete })).toBeNull()
  }
  expect(view.deletes).toHaveLength(0)
})
