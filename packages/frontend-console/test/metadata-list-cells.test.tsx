import { useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { adaptConsoleModel } from '../src/api/adapt-console-model'
import { runtimeModelOptions } from '../src/api/runtime-model'
import { api } from '../src/api/client'
import { GeneratedListCell } from '../../console-generated/src/list-cell'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { defaultListState, toQueryDocument, validateListSearch } from '../../console-generated/src/list-model'
import { detailPlan, detailReadableField } from '../../console-generated/src/detail-plan'
import { inlineEditableField, writeSchema } from '../../console-generated/src/write'
import type { ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

vi.mock('../src/api/client', () => ({ api: vi.fn() }))

const metadata = ['id', 'organization_id', 'version', 'created_at', 'updated_at']
const row = { id: '0000123456789', organization_id: 'org', version: 7, name: 'Synthetic row', created_at: '2026-10-24T22:30:00Z', updated_at: '2026-10-25T01:30:00Z' }
function document() {
  return { contractVersion: 2, console: null,
    model: { instance: 'metadata-cells', revision: 1, locale: 'en', timeZone: 'Europe/Prague', commands: [], workflows: [], limits: { root: 100, maxOffset: 100, children: 10, relations: 4, exists: 4 }, entities: {
      entries: { displayField: 'name', fields: Object.fromEntries(['name', ...metadata].map(field => [field, { type: field.endsWith('_at') ? 'datetime' : field === 'version' ? 'int' : 'string', readOnly: field !== 'name' }])), columns: ['name'], relations: {}, routes: { list: '', detail: '' },
        list: { pageSize: 10, mobileCards: true, columns: [{ field: 'name' }, { field: 'id', cell: { kind: 'identifier', copy: true } }, { field: 'updated_at', cell: { kind: 'datetime' } }] },
        detail: { inlineEdit: true, groups: [{ id: 'main', label: 'Main', fields: ['name', ...metadata] }] },
        writeSchema: { type: 'object', properties: Object.fromEntries(['name', ...metadata].map(field => [field, { type: 'string' }])) },
      },
    } }, capabilities: { revision: 1, organization: { role: 'admin' }, commands: [], workflows: {}, resources: {}, entities: { entries: { readable: ['name', ...metadata], writable: ['name', ...metadata], operations: ['read', 'create', 'update'] } } },
  } as unknown as ConsoleModelContract
}
let client: QueryClient
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(doc = document(), language = 'en', values = row) {
  let runtime = adaptConsoleModel(doc)
  let updateRuntime: (next: typeof runtime) => void
  const request = vi.fn(async (_query: ReadQuery) => ({ data: [values], next_cursor: null, total: 1 }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch,
    component: () => {
      const [current, setCurrent] = useState(runtime); updateRuntime = setCurrent
      return <GeneratedReadPage model={current.model} caps={current.capabilities} orgId="org" entity="entries" request={request} />
    } })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } } })
  const tree = () => <I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>
  const rendered = render(tree())
  await screen.findAllByText(row.name)
  return { ...rendered, runtime, request, user: userEvent.setup(), refresh: async (next: ConsoleModelContract) => {
    runtime = adaptConsoleModel(next)
    await act(async () => { updateRuntime(runtime) })
  } }
}

it.each(['en', 'cs'])('renders real adapted metadata in table/cards with datetime formatting and identifier copy (%s)', async language => {
  const { container, request, user } = await mount(document(), language)
  const table = within(container.querySelector('tbody')!)
  expect(table.getByText(row.id)).toBeTruthy()
  const formatted = new Intl.DateTimeFormat(language === 'cs' ? 'cs-CZ' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }).format(new Date(row.updated_at))
  expect(table.getByText(formatted)).toBeTruthy()
  expect(within(container.querySelector('dl')!).getByText(row.id)).toBeTruthy()
  expect(within(container.querySelector('dl')!).getByText(formatted)).toBeTruthy()
  expect(request.mock.calls[0][0].select).toEqual(expect.arrayContaining(['id', 'updated_at']))
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await user.click(table.getByRole('button', { name: language === 'cs' ? cs.listIdentifierCopy : en.listIdentifierCopy }))
  expect(writeText).toHaveBeenCalledWith(row.id)
})

it.each([false, true])('keeps default/detail/form hiding and read-only metadata (explicit list: %s)', async explicit => {
  const doc = document(); if (!explicit) delete doc.model.entities.entries.list
  const { container, runtime } = await mount(doc)
  if (!explicit) expect(container.querySelector('tbody')!.textContent).toBe(row.name)
  for (const field of metadata) {
    expect(runtime.model.entities.entries.fields[field].ui?.hidden).toBe(true)
    expect(runtime.model.entities.entries.fields[field].readOnly).toBe(true)
    expect(detailReadableField(runtime.model, 'entries', runtime.capabilities, field)).toBe(false)
    expect(inlineEditableField(runtime.model, 'entries', runtime.capabilities, field)).toBe(false)
  }
  expect(detailPlan(runtime.model, 'entries', runtime.capabilities)?.groups[0].fields).toEqual([{ field: 'name' }])
  for (const view of ['create', 'edit'] as const) expect(Object.keys(writeSchema(runtime.model, 'entries', runtime.capabilities, view).properties)).toEqual(['name'])
})

it.each(['schema', 'registry', 'schema-with-overlay'])('honours user-declared hidden metadata (%s)', async source => {
  const doc = document()
  if (source !== 'registry') doc.model.entities.entries.fields.updated_at.ui = { hidden: true }
  if (source !== 'schema') doc.console = { navigation: [], pages: [], entities: { entries: { fields: { updated_at: source === 'registry' ? { hidden: true } : { kind: 'input' } } } } }
  const { container } = await mount(doc)
  expect(container.querySelector('tbody')!.textContent).not.toContain('2026')
  expect(container.querySelector('tbody')!.textContent).not.toContain('2:30')
  expect(container.querySelector('tbody')!.textContent).toContain(row.name)
})

it('rechecks readable grants after a role change, even with cached values and explicit copy cells', async () => {
  const { container, runtime, refresh } = await mount()
  expect(within(container.querySelector('tbody')!).getByText(row.id)).toBeTruthy()
  const next = document(); next.capabilities.revision++
  next.capabilities.entities.entries.readable = ['name', 'version']
  next.capabilities.entities.entries.operations = ['read']
  await refresh(next)
  await waitFor(() => expect(container.querySelector('tbody')!.textContent).not.toContain(row.id))
  expect(container.querySelector('tbody')!.textContent).not.toContain('2026')
  expect(screen.queryByRole('button', { name: en.listIdentifierCopy })).toBeNull()
  const adapted = adaptConsoleModel(next)
  expect(toQueryDocument(defaultListState(adapted.model, 'entries'), adapted.model, 'entries', adapted.capabilities).select).not.toContain('updated_at')
  expect(runtime.model.entities.entries.fields.id.ui?.hidden).toBe(true)
})

it('retains the null placeholder for server-masked metadata values', async () => {
  const { container } = await mount(document(), 'en', { ...row, updated_at: null as unknown as string })
  expect(within(container.querySelector('tbody')!).getByText('—')).toBeTruthy()
  expect(container.querySelector('tbody')!.textContent).not.toContain('2026')
})

// Exercise the production query's default structural sharing, not setQueryData
// or a freshly adapted object passed directly to the renderer (review F1).
it.each(['user-hidden', 'operators', 'JSON-equal'] as const)('renders refreshed metadata through the runtime query cache (%s)', async change => {
  const next = document()
  if (change !== 'JSON-equal') next.model.revision++
  if (change === 'user-hidden') next.model.entities.entries.fields.updated_at.ui = { hidden: true }
  if (change === 'operators') next.model.entities.entries.fields.updated_at.operators = ['eq']
  vi.mocked(api).mockReset().mockResolvedValueOnce(document()).mockResolvedValueOnce(next)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const options = runtimeModelOptions('org')
  // runtimeModelOptions has gcTime:0; keep a real observer while refreshing.
  const observer = new QueryObserver(client, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => {})
  try {
    const i18n = i18next.createInstance()
    await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
    const cell = (runtime: ReturnType<typeof adaptConsoleModel>) => <I18nextProvider i18n={i18n}><GeneratedListCell model={runtime.model} caps={runtime.capabilities} entity="entries" orgId="org" row={row} column={{ field: 'updated_at', cell: { kind: 'datetime' } }} primary={false} signed={() => null} /></I18nextProvider>
    const formatted = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }).format(new Date(row.updated_at))
    await client.fetchQuery(options)
    const before = client.getQueryData<ReturnType<typeof adaptConsoleModel>>(options.queryKey)!
    const view = render(cell(before))
    expect(view.container.textContent).toBe(formatted)
    await client.fetchQuery(options)
    const after = client.getQueryData<ReturnType<typeof adaptConsoleModel>>(options.queryKey)!
    if (change === 'JSON-equal') expect(after).toBe(before)
    view.rerender(cell(after))
    expect(view.container.textContent).toBe(change === 'user-hidden' ? '' : formatted)
    expect(api).toHaveBeenCalledTimes(2)
  } finally { unsubscribe() }
})
