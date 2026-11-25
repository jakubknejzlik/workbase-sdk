import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { createInstance } from 'i18next'
import type { ReactNode } from 'react'
import { AuditScreen } from '../src/audit'
import type { AuditPage } from '../src/api/workflows'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const event = { event_id: 'event-1', occurred_at: '2026-11-24T10:00:00Z', actor: { type: 'user', id: 'person-1', label: 'Ada Example' }, operation: 'records.updated', entity: 'records', entity_id: 'record-1', changes: { title: { before: 'Old value', after: 'New value' } }, correlation_id: 'correlation-1', schema_version: 4 }
async function mount(options: { language?: 'en' | 'cs'; page?: AuditPage; deferred?: boolean } = {}) {
  const language = options.language ?? 'en', t = language === 'cs' ? cs : en
  const world = { allowed: true, status: 200, page: options.page ?? { data: [event], next_cursor: 'next-page' } as AuditPage }
  let release: (() => void) | undefined
  const gate = options.deferred ? new Promise<void>(resolve => { release = resolve }) : undefined
  const caps = () => ({ revision: 1, organization: { role: 'owner' }, entities: {}, resources: { 'audit.read': world.allowed } })
  const requests: { path: string; method: string; body: BodyInit | null | undefined; org: string | undefined }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body, org: (init?.headers as Record<string, string>)?.['X-Organization-Id'] })
    if (path === '/o/org/capabilities') return Response.json(caps())
    if (path === '/o/org/console-model') return Response.json({ contractVersion: 2, console: null, model: { instance: 'test', revision: 1, locale: language, timeZone: 'UTC', limits: {}, entities: {}, commands: [], workflows: [] }, capabilities: caps() })
    if (path.startsWith('/audit/events?')) { await gate; return world.status === 200 ? Response.json(world.page) : Response.json({ error: 'PRIVATE_SERVER_DETAILS' }, { status: world.status }) }
    throw new Error(`Unexpected HTTP request: ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const i18n = createInstance(); await i18n.init({ lng: language, resources: { [language]: { translation: t } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><AuditScreen orgId="org" /></QueryClientProvider></I18nextProvider>)
  const user = userEvent.setup()
  return { world, requests, client, t, user, auditRequests: () => requests.filter(request => request.path.startsWith('/audit/events?')), open: async () => { await user.click(screen.getByRole('button', { name: t.sortAndFilter })) }, refetch: async () => { await act(async () => { await client.refetchQueries({ queryKey: ['audit-events', 'org'], type: 'active' }) }) }, release: async () => { await act(async () => release?.()) } }
}

it.each(['en', 'cs'] as const)('%s populated audit uses returned facts, diff and cursor paging without totals or unsupported actions', async language => {
  const test = await mount({ language }); await screen.findByText(/Ada Example/)
  expect(screen.getByText(test.t.auditDelivered)).toBeTruthy()
  expect(screen.getByRole('table').closest('[data-slot="list-page"]')).toBeTruthy()
  expect(screen.queryByRole('searchbox')).toBeNull(); expect(document.querySelector('[data-list-range]')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.previousPage }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.nextPage }).disabled).toBe(false)
  await test.user.click(document.querySelector<HTMLElement>('details > summary')!)
  expect(screen.getByText('Old value')).toBeTruthy(); expect(screen.getByText('New value')).toBeTruthy()
  await test.user.click(screen.getByText(test.t.auditTechnicalDetails))
  expect(screen.getByText('correlation-1')).toBeTruthy(); expect(screen.getByText('4')).toBeTruthy()
  expect(test.auditRequests()).toEqual([{ path: '/audit/events?limit=25', method: 'GET', body: undefined, org: 'org' }])
})
it.each(['en', 'cs'] as const)('%s drafts wait for Apply; Cancel discards and Clear waits for Apply', async language => {
  const test = await mount({ language }); await screen.findByText(/Ada Example/); await test.open()
  for (const [field, value] of Object.entries({ entity: 'records', entity_id: 'record-1', from: '2026-11-01T10:00', to: '2026-11-25T10:00' })) fireEvent.change(screen.getByLabelText(test.t[`auditFilter_${field}` as keyof typeof test.t]), { target: { value } })
  expect(test.auditRequests()).toHaveLength(1)
  await test.user.click(screen.getByRole('button', { name: test.t.auditApply }))
  await waitFor(() => expect(test.auditRequests()).toHaveLength(2))
  const applied = new URL(test.auditRequests().at(-1)!.path, 'http://local').searchParams
  expect(applied.get('entity')).toBe('records'); expect(applied.get('entity_id')).toBe('record-1')
  expect(applied.get('from')).toBe(new Date('2026-11-01T10:00').toISOString()); expect(applied.get('to')).toBe(new Date('2026-11-25T10:00').toISOString())
  await test.open(); fireEvent.change(screen.getByLabelText(test.t.auditFilter_entity), { target: { value: 'unconfirmed' } })
  await test.user.click(screen.getByRole('button', { name: test.t.cancel })); await test.open()
  expect(screen.getByLabelText<HTMLInputElement>(test.t.auditFilter_entity).value).toBe('records')
  expect(screen.getByLabelText<HTMLInputElement>(test.t.auditFilter_from).value).toBe('2026-11-01T10:00')
  await test.user.click(screen.getByRole('button', { name: test.t.clearAllFilters }))
  expect(screen.getByLabelText<HTMLInputElement>(test.t.auditFilter_entity).value).toBe(''); expect(test.auditRequests()).toHaveLength(2)
  await test.user.click(screen.getByRole('button', { name: test.t.auditApply }))
  await waitFor(() => expect(test.auditRequests().at(-1)!.path).toBe('/audit/events?limit=25'))
})
it.each(['en', 'cs'] as const)('%s page-two retry preserves path/body, applied filters, draft and cursor', async language => {
  const test = await mount({ language }); await screen.findByText(/Ada Example/); await test.open()
  fireEvent.change(screen.getByLabelText(test.t.auditFilter_entity), { target: { value: 'records' } })
  await test.user.click(screen.getByRole('button', { name: test.t.auditApply }))
  await waitFor(() => expect(test.auditRequests()).toHaveLength(2))
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.nextPage }).disabled).toBe(false))
  await test.user.click(screen.getByRole('button', { name: test.t.nextPage })); await waitFor(() => expect(test.auditRequests()).toHaveLength(3))
  await test.open(); fireEvent.change(screen.getByLabelText(test.t.auditFilter_entity), { target: { value: 'draft-only' } })
  test.world.status = 500; await test.refetch(); await screen.findByRole('alert')
  expect(screen.queryByText(/Ada Example/)).toBeNull(); expect(document.body.textContent).not.toContain('PRIVATE_SERVER_DETAILS')
  expect(screen.getByLabelText<HTMLInputElement>(test.t.auditFilter_entity).value).toBe('draft-only')
  expect(screen.queryByText(test.t.auditS5Empty)).toBeNull()
  const failed = test.auditRequests().at(-1)!; expect(failed.path).toBe('/audit/events?limit=25&entity=records&cursor=next-page')
  test.world.status = 200; await test.user.click(screen.getByRole('button', { name: test.t.listRetry })); await screen.findByText(/Ada Example/)
  expect(test.auditRequests().at(-1)).toEqual(failed); expect(screen.getByLabelText<HTMLInputElement>(test.t.auditFilter_entity).value).toBe('draft-only')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.previousPage }).disabled).toBe(false)
  await test.user.click(screen.getByRole('button', { name: test.t.cancel })); await test.user.click(screen.getByRole('button', { name: test.t.previousPage }))
  await waitFor(() => expect(test.auditRequests().at(-1)!.path).toBe('/audit/events?limit=25&entity=records'))
})
it('deferred HTTP shows loading without empty/zero flash and keeps controls mounted', async () => {
  const test = await mount({ deferred: true, page: { data: [], next_cursor: null } }); await waitFor(() => expect(test.auditRequests()).toHaveLength(1))
  expect(screen.getByRole('status').textContent).toBe(test.t.loading); expect(screen.getByRole('button', { name: test.t.sortAndFilter })).toBeTruthy()
  expect(screen.queryByText(test.t.auditS5Empty)).toBeNull(); expect(screen.queryByText(test.t.auditS5EmptyPage)).toBeNull(); expect(document.querySelector('[data-list-range]')).toBeNull()
  await test.release(); await screen.findByText(test.t.auditS5Empty)
})
it.each(['en', 'cs'] as const)('%s empty continuation keeps Next; terminal filtered scope clears; unfiltered is contextual', async language => {
  const test = await mount({ language, page: { data: [], next_cursor: 'scan-position' } }); await screen.findByText(test.t.auditS5EmptyPage)
  expect(screen.queryByText(test.t.auditS5Empty)).toBeNull(); expect(screen.queryByText(test.t.auditS5NoMatches)).toBeNull(); expect(screen.queryByRole('button', { name: test.t.clearAllFilters })).toBeNull()
  await test.user.click(screen.getByRole('button', { name: test.t.nextPage })); await waitFor(() => expect(test.auditRequests().at(-1)!.path).toBe('/audit/events?limit=25&cursor=scan-position'))
  test.world.page = { data: [], next_cursor: null }; await test.refetch(); await screen.findByText(test.t.auditS5Empty)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.nextPage }).disabled).toBe(true); expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.previousPage }).disabled).toBe(false)
  await test.open(); fireEvent.change(screen.getByLabelText(test.t.auditFilter_entity), { target: { value: 'missing' } })
  await test.user.click(screen.getByRole('button', { name: test.t.auditApply })); await screen.findByText(test.t.auditS5NoMatches)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.previousPage }).disabled).toBe(true)
  await test.user.click(screen.getByRole('button', { name: test.t.clearAllFilters })); await screen.findByText(test.t.auditS5Empty)
  expect(test.auditRequests().at(-1)!.path).toBe('/audit/events?limit=25')
})
it.each(['capability', '403'] as const)('%s loss hides cached facts and open filters', async kind => {
  const test = await mount(); await screen.findByText(/Ada Example/); await test.open()
  if (kind === '403') { test.world.status = 403; await test.refetch() } else { test.world.allowed = false; await act(async () => { await test.client.invalidateQueries({ queryKey: ['capabilities', 'org'] }) }) }
  await screen.findByText(test.t.forbidden)
  expect(screen.queryByText(/Ada Example/)).toBeNull(); expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByRole('group', { name: test.t.sortAndFilter })).toBeNull()
  expect(screen.queryByRole('button', { name: test.t.listRetry })).toBeNull(); expect(screen.queryByRole('button', { name: test.t.sortAndFilter })).toBeNull()
})
it('absent facts stay unavailable; credential-shaped actor labels and changes stay redacted', async () => {
  const absent = { ...event, actor: undefined, changes: undefined, correlation_id: undefined, schema_version: undefined }
  const secret = 'Bearer synthetic-credential-value'
  const test = await mount({ page: { data: [absent, { ...event, event_id: 'event-2', actor: { type: 'service', id: 'id', label: secret }, changes: { title: { after: secret } } }] as unknown as AuditPage['data'], next_cursor: null } })
  await screen.findByText('event-1', { exact: true }); expect(document.body.textContent).not.toContain(secret); expect(document.body.textContent).not.toContain('CMS')
  expect(screen.getAllByText(test.t.unavailable).length).toBeGreaterThan(2); expect(screen.getByText(test.t.auditNoChanges)).toBeTruthy(); expect(screen.getAllByText(test.t.redactedValue).length).toBeGreaterThan(0)
})
it.each(['en', 'cs'] as const)('%s terminal filtered page after populated history retains Previous and real clear', async language => {
  const test = await mount({ language }); await screen.findByText(/Ada Example/); await test.open()
  fireEvent.change(screen.getByLabelText(test.t.auditFilter_entity), { target: { value: 'records' } })
  await test.user.click(screen.getByRole('button', { name: test.t.auditApply })); await waitFor(() => expect(test.auditRequests()).toHaveLength(2))
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.nextPage }).disabled).toBe(false))
  test.world.page = { data: [], next_cursor: null }
  await test.user.click(screen.getByRole('button', { name: test.t.nextPage })); await screen.findByText(test.t.auditS5NoMatches)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.previousPage }).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: test.t.nextPage }).disabled).toBe(true)
  expect(screen.getByRole('button', { name: test.t.clearAllFilters })).toBeTruthy()
  expect(test.auditRequests().at(-1)!.path).toBe('/audit/events?limit=25&entity=records&cursor=next-page')
  test.world.page = { data: [event], next_cursor: 'next-page' }
  await test.user.click(screen.getByRole('button', { name: test.t.previousPage })); await screen.findByText(/Ada Example/)
  expect(test.auditRequests().at(-1)!.path).toBe('/audit/events?limit=25&entity=records')
})
