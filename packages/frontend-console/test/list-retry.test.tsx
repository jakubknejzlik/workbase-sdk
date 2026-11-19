import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

it.each(['en', 'cs'] as const)('%s list error recovery preserves the committed query, settings and second page', async language => {
  const copy = language === 'cs' ? cs : en
  const model: Model = { instance: 'retry', revision: 1, limits: { root: 100, children: 20, relations: 4, exists: 4, maxOffset: 100 }, entities: {
    entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' }, list: { columns: [{ field: 'name' }], search: ['name'], pageSize: 10, views: [{ id: 'active', label: 'Active entries', where: { status: { eq: 'active' } } }] } },
  } }
  const caps: Capabilities = { revision: 1, entities: { entries: { readable: ['id', 'name', 'status'], writable: [], operations: ['read'] } } }
  let failing = true
  const request = vi.fn(async (query: ReadQuery) => {
    if (failing) throw new Error('Synthetic unavailable response')
    return { data: [{ id: 'recovered', name: 'Worker recovered' }], next_cursor: null, offset: query.offset, limit: query.limit, total: 25, viewTotals: { active: 25 } }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" request={request} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries?view=active&search=Worker&page=2&pageSize=10&sort=name&direction=desc'] }) })
  await router.load()
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { [language]: { translation: copy } } })
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  try {
    const alert = await screen.findByRole('alert')
    expect(within(alert).getAllByText(copy.requestFailed)).toHaveLength(1)
    expect(within(alert).getByText(copy.listRequestFailedDescription)).toBeTruthy()
    const url = router.state.location.href
    expect(router.state.location.search).toMatchObject({ view: 'active', search: 'Worker', page: 2, pageSize: 10, sort: 'name', direction: 'desc' })
    expect(request).toHaveBeenCalledTimes(1)
    const failedQuery = structuredClone(request.mock.calls[0]![0])
    expect(failedQuery).toMatchObject({ offset: 10, limit: 10, includeTotal: true, view: 'active', search: { text: 'Worker' } })
    failing = false
    await userEvent.setup().click(within(alert).getByRole('button', { name: copy.listRetry }))
    await screen.findByRole('link', { name: 'Worker recovered' })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![0]).toEqual(failedQuery)
    expect(router.state.location.href).toBe(url)
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Worker')
    expect(screen.getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page')
  } finally { view.unmount(); client.clear() }
})
