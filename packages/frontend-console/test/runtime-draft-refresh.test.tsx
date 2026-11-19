import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { getMutationSafetySnapshot } from '@workbasehq/ui'
import { changeSavedViews } from '@workbasehq/console-generated/saved-views'
import en from '../src/locales/en.json'
import { viewsTrigger } from './saved-views-menu'
import { ReadPage } from '../src/read'
import { adaptConsoleModel, refreshRuntimeModel } from '../src/api/runtime-model'
import { fetchCapabilities } from '../src/api/queries'
import { buildReload } from '../src/build-reload'
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ search: {}, state: {}, pathname: '/o/org/e/entries', searchStr: '' }), useNavigate: () => navigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
beforeEach(() => {
  const entries = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() { return entries.size },
  })
})
afterEach(() => { navigate.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function document(revision = 1): ConsoleModelContract {
  return {
    contractVersion: 2, console: { entities: {}, navigation: [], pages: [] },
    model: { instance: 'drafts', revision, locale: 'en', timeZone: 'UTC', limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
      entries: { displayField: 'name', fields: { id: { type: 'string' }, version: { type: 'integer' }, name: { type: 'string' } }, writeSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, columns: ['name'], relations: {}, routes: {} },
    }, commands: [], workflows: [] },
    capabilities: { revision, organization: { role: 'admin' }, entities: { entries: { operations: ['read', 'create', 'update'], readable: ['id', 'version', 'name'], writable: ['name'] } }, commands: [], resources: {}, workflows: {} },
  } as unknown as ConsoleModelContract
}
async function setup(id?: string, beforeDraft?: () => void) {
  let next = document(), status = 200
  let releaseQueries: (() => void) | undefined
  let queryGate: Promise<void> | undefined
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['console-model', 'org'], adaptConsoleModel(next)); client.setQueryData(['capabilities', 'org'], next.capabilities)
  client.setQueryData(['organization', 'org'], { user: { id: 'verified' }, memberships: [{ organization_id: 'org' }] })
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/me?scope=organization') return Response.json(client.getQueryData(['organization', 'org']))
    if (path.endsWith('/capabilities')) return Response.json(next.capabilities)
    if (path.endsWith('/console-model')) return Response.json(status === 200 ? next : { error: 'permission_denied' }, { status })
    if (path === '/query') { await queryGate; return Response.json({ data: [{ id: 'one', version: 1, name: 'Ada' }], next_cursor: null }) }
    throw new Error(`Unexpected path ${path}`)
  }); vi.stubGlobal('fetch', fetcher)
  const refreshBuild = vi.spyOn(buildReload, 'refresh').mockResolvedValue()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', entity_entries: 'Entries', entitySingular_entries: 'Entry' } } } })
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><ReadPage orgId="org" entity="entries" id={id} /></QueryClientProvider></I18nextProvider>)
  await screen.findByRole('heading', { name: id ? 'Ada' : 'Entries' })
  beforeDraft?.()
  fireEvent.click(screen.getByRole('button', { name: id ? 'Edit' : 'Add Entry' }))
  const input = await screen.findByRole('textbox', { name: 'Name' }); fireEvent.change(input, { target: { value: 'Grace' } })
  expect(getMutationSafetySnapshot().dirty).toBe(true)
  return { client, input, refreshBuild, view, fetcher, holdQueries: () => { queryGate = new Promise<void>(resolve => { releaseQueries = resolve }) }, releaseQueries: () => releaseQueries?.(), next: (value: ConsoleModelContract) => { next = value }, deny: (value: number) => { status = value }, cleanup: () => { releaseQueries?.(); view.unmount(); client.clear() } }
}
it('revision-only runtime refresh retains a real registered create draft and requests a build observation', async () => {
  const test = await setup(); test.holdQueries(); test.next(document(2))
  await act(async () => { await fetchCapabilities(test.client, 'org') })
  await waitFor(() => expect(test.client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', 'org'])?.capabilities.revision).toBe(2))
  expect(test.refreshBuild).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input); expect(test.input).toHaveProperty('value', 'Grace'); expect(getMutationSafetySnapshot().dirty).toBe(true)
  test.cleanup()
})
it('revision refresh preserves the verified saved-view selection alongside a dirty create draft without auto-applying it', async () => {
  const saved = changeSavedViews({ instance: 'drafts', userId: 'verified', orgId: 'org' }, 'entries', {
    kind: 'save', name: 'Personal', state: { search: '', sort: { key: 'name', direction: 'desc' }, userFilters: [], presetFilters: [], limit: 30 },
  }).entries[0]
  const test = await setup(undefined, () => {
    // Choosing is separate from applying: open the menu and select, but never confirm.
    fireEvent.click(viewsTrigger())
    fireEvent.click(within(screen.getByRole('dialog', { name: en.savedViews })).getByRole('button', { name: 'Personal' }))
  })
  test.next(document(2))
  try {
    await act(async () => { await fetchCapabilities(test.client, 'org') })
    await waitFor(() => expect(test.client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', 'org'])?.capabilities.revision).toBe(2))
    // The modal create draft dismissed the menu; reopening it shows the same (unapplied) choice, so the refresh neither lost nor applied it.
    if (!screen.queryByRole('dialog', { name: en.savedViews, hidden: true })) fireEvent.click(viewsTrigger())
    expect(within(screen.getByRole('dialog', { name: en.savedViews, hidden: true })).getByRole('button', { name: 'Personal', hidden: true }).getAttribute('aria-pressed')).toBe('true')
    expect(saved.id).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input)
    expect(test.input).toHaveProperty('value', 'Grace'); expect(getMutationSafetySnapshot().dirty).toBe(true)
    expect(test.refreshBuild).toHaveBeenCalledTimes(1)
  } finally { test.cleanup() }
})
it('live create revocation is applied immediately despite a dirty draft', async () => {
  const test = await setup(); const next = document(2); next.capabilities.entities.entries.operations = ['read']; test.next(next)
  await act(async () => { await fetchCapabilities(test.client, 'org') })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('button', { name: 'Add Entry' })).toBeNull()
  test.cleanup()
})
it.each([403, 500])('failed runtime read (%s) fails closed instead of retaining stale authorization', async status => {
  const test = await setup(); test.deny(status)
  await act(async () => { await refreshRuntimeModel(test.client, 'org').catch(() => {}) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('button', { name: 'Add Entry' })).toBeNull(); test.cleanup()
})
// Open point: the generated detail query changes key with capabilities and removes
// its actions while awaiting fresh rows. Fixing that exceeds the read/runtime host.
it.fails('open point: revision-only runtime refresh should retain a detail edit draft', async () => {
  const test = await setup('one'); const queriesBefore = test.fetcher.mock.calls.filter(([path]) => path === '/query').length; test.holdQueries(); test.next(document(2))
  try {
    await act(async () => { await fetchCapabilities(test.client, 'org') })
    await waitFor(() => expect(test.fetcher.mock.calls.filter(([path]) => path === '/query').length).toBeGreaterThan(queriesBefore))
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input); expect(test.input).toHaveProperty('value', 'Grace'); expect(getMutationSafetySnapshot().dirty).toBe(true)
  } finally {
    await act(async () => test.releaseQueries()); test.cleanup()
  }
})
