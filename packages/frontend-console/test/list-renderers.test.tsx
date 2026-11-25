import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { ContextList, GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import type { ListColumn } from '../../core/src/list-contract'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
let client: QueryClient
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(columns: ListColumn[], options: { language?: 'en' | 'cs'; denied?: string[]; embedded?: boolean; contextSurface?: boolean; listV2?: boolean; row?: Record<string, any> } = {}) {
  const fields = { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active', 'unknown'] }, amount: { type: 'int' }, enabled: { type: 'bool' }, inactive: { type: 'bool' }, due: { type: 'date' }, created: { type: 'datetime' }, owner: { type: 'ref', entity: 'people' } }
  const model: Model = { instance: 'cells', revision: 1, timeZone: 'Europe/Prague', limits: { root: 100, ...(options.listV2 ? { maxOffset: 100 } : {}), children: 20, relations: 4, exists: 4 }, entities: {
    entries: { displayField: 'name', fields, columns: ['name'], relations: { owner: { entity: 'people', field: 'owner', cardinality: 'n:1' } }, routes: { list: '', detail: '' }, list: { mobileCards: true, columns, relatedColumns: { owner_name: { via: 'owner', field: 'place' } } } },
    places: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
    people: { detail: { lists: { entries: { entity: 'entries', label: 'Entries', bind: { field: 'owner', record: 'id' }, columns: ['name'] } } }, displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, place: { type: 'ref', entity: 'places' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
  } }
  const caps: Capabilities = { revision: 1, entities: { entries: { readable: Object.keys(fields).filter(f => !options.denied?.includes(f)), writable: [], operations: ['read'] }, people: { readable: ['id', 'name', 'place'].filter(f => !options.denied?.includes(`people.${f}`)), writable: [], operations: ['read'] }, places: { readable: ['id', 'name'].filter(f => !options.denied?.includes(`places.${f}`)), writable: [], operations: ['read'] } } }
  const row = { id: '0000123456789', name: 'Primary', status: 'active', amount: 0, enabled: false, created: '2026-10-24T22:30:00Z', owner: 'private-foreign-key', __labels: { owner: { status: 'ok', entity: 'people', row: { id: 'p', name: 'Readable person' } }, owner_name: { status: 'ok', entity: 'places', row: { id: 'p', name: 'Related person' } } }, ...options.row }
  const request = vi.fn(async (query: ReadQuery) => ({ data: [row], next_cursor: null }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => options.contextSurface ? <ContextList model={model} caps={caps} orgId="org" entity="people" id="p" name="entries" request={request} /> : <GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" request={request} contextList={options.embedded ? { entity: 'people', id: 'p', list: 'entries' } : undefined} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: options.language ?? 'en', resources: { en: { translation: { ...en, value_active: 'Active', value_unknown: 'Unknown' } }, cs: { translation: { ...cs, value_active: 'Aktivní', value_unknown: 'Neznámý' } } } })
  const rendered = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await waitFor(() => expect(request).toHaveBeenCalled())
  await screen.findAllByRole('link')
  return { request, router, caps, user: userEvent.setup(), ...rendered }
}
it.each(['neutral', 'positive', 'warning', 'negative'] as const)('localizes badges and uses the raw enum key for %s', async tone => {
  const { container } = await mount([{ field: 'status', cell: { kind: 'badge', tones: { active: tone } } }], { language: 'cs' })
  const badges = container.querySelectorAll('[data-list-badge]'); expect(badges.length).toBeGreaterThan(0)
  for (const badge of badges) { expect(badge.textContent).toBe('Aktivní'); expect(badge.getAttribute('data-tone')).toBe(tone) }
})
it('falls back to neutral for an unmapped or unrecognized badge tone and keeps null placeholders', async () => {
  const { container } = await mount([{ field: 'status', cell: { kind: 'badge', tones: { active: 'injected-class' as any } } }])
  expect(container.querySelector('[data-list-badge]')?.getAttribute('data-tone')).toBe('neutral')
  expect(container.innerHTML).not.toContain('injected-class')
})
it.each([true, false, undefined])('identifier preserves full leading zeros and copies only with explicit true (%s)', async copy => {
  const { container, user, router } = await mount([{ field: 'id', cell: { kind: 'identifier', copy } }])
  expect(screen.getAllByText('0000123456789').length).toBeGreaterThan(0)
  const write = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
  const buttons = screen.queryAllByRole('button', { name: en.listIdentifierCopy })
  expect(buttons.length > 0).toBe(copy === true)
  expect(container.querySelector('a a, a button')).toBeNull()
  if (copy) { await user.click(buttons[0]); expect(write).toHaveBeenCalledWith('0000123456789'); expect(await screen.findByText(en.listIdentifierCopied)).toBeTruthy(); expect(router.state.location.pathname).toBe('/o/org/e/entries') }
})
it.each(['reject', 'unavailable'])('reports localized clipboard failure: %s', async mode => {
  const { user } = await mount([{ field: 'name', cell: { kind: 'identifier', copy: true } }], { language: 'cs' })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'reject' ? { writeText: vi.fn().mockRejectedValue(new Error('denied')) } : undefined })
  await user.click(screen.getAllByRole('button', { name: cs.listIdentifierCopy })[0]); expect(await screen.findByText(cs.listIdentifierCopyFailed)).toBeTruthy()
})
it.each(['amount', 'enabled', 'created', 'owner', 'owner_name'])('renders secondary %s in desktop/mobile/embedded with one query', async secondary => {
  const { container, request } = await mount([{ field: 'name', secondary }], { embedded: true })
  const lines = container.querySelectorAll('[data-list-secondary]'); expect(lines.length).toBe(2)
  const expected = { amount: '0', enabled: en.no, created: new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }).format(new Date('2026-10-24T22:30:00Z')), owner: 'Readable person', owner_name: 'Related person' }[secondary]
  for (const line of lines) expect(line.textContent).toBe(expected)
  expect(container.querySelector('a a')).toBeNull(); expect(request).toHaveBeenCalledTimes(1)
  const query = request.mock.calls[0][0]; expect(query.select).toContain(secondary === 'owner_name' ? 'owner' : secondary)
  if (secondary.startsWith('owner')) expect(query.labels).toContain(secondary)
})
it.each([null, undefined])('omits null/absent secondary (%s)', async amount => {
  const { container } = await mount([{ field: 'name', secondary: 'amount' }], { row: { amount } }); expect(container.querySelector('[data-list-secondary]')).toBeNull()
})
it.each(['amount', 'owner', 'people.name'])('omits denied secondary even from cached row: %s', async denied => {
  const { container } = await mount([{ field: 'name', secondary: denied === 'amount' ? 'amount' : 'owner' }], { denied: [denied] }); expect(container.querySelector('[data-list-secondary]')).toBeNull(); expect(container.textContent).not.toContain('private-foreign-key')
})
it('uses unavailable text rather than foreign keys for missing secondary labels', async () => {
  const { container } = await mount([{ field: 'name', secondary: 'owner' }], { row: { __labels: {} } }); expect(container.textContent).not.toContain('private-foreign-key'); expect(screen.getAllByText(en.unavailableRecord).length).toBeGreaterThan(0)
})

it('retains configured descriptors when ContextList overrides its primary column selection', async () => {
  const { container, request } = await mount([{ field: 'name', secondary: 'amount', cell: { kind: 'identifier', copy: true } }], { contextSurface: true })
  expect(container.querySelectorAll('[data-list-secondary]').length).toBe(2)
  expect(screen.getAllByRole('button', { name: en.listIdentifierCopy }).length).toBe(2)
  expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0].select).toContain('amount')
})
it.each(['owner', 'people.place', 'places.name'])('omits denied cached related secondary along every hop: %s', async denied => {
  const { container } = await mount([{ field: 'name', secondary: 'owner_name' }], { denied: [denied] })
  expect(container.querySelector('[data-list-secondary]')).toBeNull()
})
it('renders a reference primary as a single row link without nesting target links', async () => {
  const { container } = await mount([{ field: 'owner', secondary: 'status' }])
  expect(screen.getAllByRole('link', { name: 'Readable person' }).every(link => link.getAttribute('href') === '/o/org/e/entries/0000123456789')).toBe(true)
  expect(container.querySelector('a a')).toBeNull()
})
it.each([null, 'unknown'])('keeps badge null placeholders and neutral fallback for missing mappings: %s', async status => {
  const { container } = await mount([{ field: 'status', cell: { kind: 'badge', tones: { active: 'positive' } } }], { row: { status } })
  if (status == null) { expect(container.querySelector('[data-list-badge]')).toBeNull(); expect(screen.getAllByText('—').length).toBeGreaterThan(0) }
  else expect(container.querySelector('[data-list-badge]')?.getAttribute('data-tone')).toBe('neutral')
})
it('omits identifier content and copy for denied cached primary values', async () => {
  const { container } = await mount([{ field: 'name' }, { field: 'amount', cell: { kind: 'identifier', copy: true } }], { denied: ['amount'] })
  expect(screen.queryByRole('button', { name: en.listIdentifierCopy })).toBeNull()
})

it.each([false, true])('aligns synthetic field cells and headers, retaining sort controls (list v2: %s)', async listV2 => {
  const { container, user, request } = await mount([
    { field: 'name' }, { field: 'amount' }, { field: 'due' }, { field: 'inactive' },
    // A text renderer does not turn a relation into a left-aligned text field.
    { field: 'owner', cell: { kind: 'text' } },
  ], { listV2, row: { name: 'Alex Example', amount: 12, due: '2026-11-24', inactive: false,
    __labels: { owner: { status: 'ok', entity: 'people', row: { id: 'clinic', name: 'Example Clinic' } } } } })
  const cells = within(container.querySelector('tbody tr')!).getAllByRole('cell')
  const headers = within(container.querySelector('thead')!).getAllByRole('columnheader')
  const expected = [
    ['Alex Example', 'left', 'start'], ['12', 'right', 'end'], ['Nov 24, 2026', 'center', 'center'],
    ['No', 'center', 'center'], ['Example Clinic', 'center', 'center'],
  ]
  expected.forEach(([text, align, justify], index) => {
    expect(cells[index].textContent).toBe(text)
    expect(cells[index].classList.contains(`text-${align}`)).toBe(true)
    expect(headers[index].classList.contains(`text-${align}`)).toBe(true)
    expect(headers[index].firstElementChild?.classList.contains(`justify-${justify}`)).toBe(true)
    const card = container.querySelectorAll('dl dd')[index]
    expect(card?.parentElement?.classList.contains(`text-${align}`)).toBe(true)
  })
  const sort = within(headers[1]).getByRole('button', { name: /^Sort / })
  await user.click(sort)
  await waitFor(() => expect(request.mock.calls.at(-1)![0].orderBy).toContainEqual({ field: 'amount', dir: 'asc' }))
  expect(headers[1].getAttribute('aria-sort')).toBe('ascending')
})


it.each(['en', 'cs'] as const)('renders an accessible icon-only identifier action and copies the full truncated value (%s)', async language => {
  const id = '0000123456789-abcdefghijklmnopqrstuvwxyz-0123456789'
  const labels = language === 'cs' ? cs : en
  const { user, container, router } = await mount([{ field: 'id', cell: { kind: 'identifier', copy: true } }], { language, row: { id } })
  const write = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
  const buttons = screen.getAllByRole('button', { name: labels.listIdentifierCopy })
  for (const button of buttons) {
    expect(button.textContent).toBe('')
    expect(button.getAttribute('title')).toBe(labels.listIdentifierCopy)
    expect(button.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
  }
  expect(screen.queryByText(labels.listIdentifierCopy)).toBeNull()
  for (const text of screen.getAllByText(id)) {
    expect(text.getAttribute('title')).toBe(id)
    expect(text.classList.contains('truncate')).toBe(true)
  }
  expect(container.querySelector('a button')).toBeNull()
  await user.click(buttons[0])
  expect(write).toHaveBeenCalledWith(id)
  const status = await screen.findByText(labels.listIdentifierCopied)
  expect(status.getAttribute('role')).toBe('status')
  expect(status.classList.contains('sr-only')).toBe(true)
  expect(router.state.location.pathname).toBe('/o/org/e/entries')
})
it.each(['reject', 'unavailable'])('announces identifier failure outside the cell layout (%s)', async mode => {
  const { user } = await mount([{ field: 'name' }, { field: 'id', cell: { kind: 'identifier', copy: true } }])
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'reject' ? { writeText: vi.fn().mockRejectedValue(new Error('denied')) } : undefined })
  const button = screen.getAllByRole('button', { name: en.listIdentifierCopy })[0]
  const cell = button.closest('td')!
  const childCount = cell.childElementCount
  const statusCount = cell.querySelectorAll('[role="status"]').length
  await user.click(button)
  const status = await screen.findByText(en.listIdentifierCopyFailed)
  expect(status.getAttribute('role')).toBe('status')
  expect(status.classList.contains('sr-only')).toBe(true)
  expect(cell.childElementCount).toBe(childCount)
  expect(cell.querySelectorAll('[role="status"]').length).toBe(statusCount)
})
it('rechecks identifier read grants when the copy action is clicked', async () => {
  const { user, caps } = await mount([{ field: 'name' }, { field: 'id', cell: { kind: 'identifier', copy: true } }])
  const write = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
  const button = screen.getAllByRole('button', { name: en.listIdentifierCopy })[0]
  caps.entities.entries.readable = ['name']
  await user.click(button)
  expect(write).not.toHaveBeenCalled()
})
