import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import type { ListColumn } from '../../core/src/list-contract'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
let client: QueryClient
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(columns: ListColumn[], options: { language?: 'en' | 'cs'; denied?: string[]; embedded?: boolean; row?: Record<string, any> } = {}) {
  const fields = { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active', 'unknown'] }, amount: { type: 'int' }, enabled: { type: 'bool' }, created: { type: 'datetime' }, owner: { type: 'ref', entity: 'people' } }
  const model: Model = { instance: 'cells', revision: 1, timeZone: 'Europe/Prague', limits: { root: 100, children: 20, relations: 4, exists: 4 }, entities: {
    entries: { displayField: 'name', fields, columns: ['name'], relations: { owner: { entity: 'people', field: 'owner', cardinality: 'n:1' } }, routes: { list: '', detail: '' }, list: { mobileCards: true, columns, relatedColumns: { owner_name: { via: 'owner', field: 'name' } } } },
    people: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
  } }
  const caps: Capabilities = { revision: 1, entities: { entries: { readable: Object.keys(fields).filter(f => !options.denied?.includes(f)), writable: [], operations: ['read'] }, people: { readable: ['id', 'name'].filter(f => !options.denied?.includes(`people.${f}`)), writable: [], operations: ['read'] } } }
  const row = { id: '0000123456789', name: 'Primary', status: 'active', amount: 0, enabled: false, created: '2026-10-24T22:30:00Z', owner: 'private-foreign-key', __labels: { owner: { status: 'ok', entity: 'people', row: { id: 'p', name: 'Readable person' } }, owner_name: { status: 'ok', entity: 'people', row: { id: 'p', name: 'Related person' } } }, ...options.row }
  const request = vi.fn(async (query: ReadQuery) => ({ data: [row], next_cursor: null }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" request={request} contextList={options.embedded ? { entity: 'people', id: 'p', list: 'entries' } : undefined} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: options.language ?? 'en', resources: { en: { translation: { ...en, value_active: 'Active', value_unknown: 'Unknown' } }, cs: { translation: { ...cs, value_active: 'Aktivní', value_unknown: 'Neznámý' } } } })
  const rendered = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await waitFor(() => expect(request).toHaveBeenCalled())
  await screen.findAllByRole('link')
  return { request, router, user: userEvent.setup(), ...rendered }
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
