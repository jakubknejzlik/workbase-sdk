import { expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { DataTable } from '@workbasehq/ui'
import { useGeneratedList } from '../../console-generated/src/useGeneratedList'
import { validateListSearch } from '../../console-generated/src/list-model'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

it.each(['en', 'cs'] as const)('%s page-size keyboard selection resets generated cursor history', async language => {
  const copy = language === 'cs' ? cs : en
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { [language]: { translation: copy } } })
  const model: Model = {
    instance: 'pagination', revision: 1, limits: { root: 100, children: 100, relations: 4, exists: 4 },
    entities: { entries: { fields: { id: { type: 'string' } }, columns: ['id'], relations: {}, routes: { list: '/entries', detail: '/entries/:id' } } },
  }
  const caps: Capabilities = { revision: 1, entities: { entries: { readable: ['id'], writable: [], operations: ['read'] } } }
  const request = vi.fn(async (query: ReadQuery) => ({ data: [{ id: query.cursor ? 'second' : 'first' }], next_cursor: query.cursor ? null : 'opaque-next' }))
  function Fixture() {
    const list = useGeneratedList({ model, caps, orgId: 'org', entity: 'entries', request })
    return <DataTable
      rows={list.data?.data ?? []} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]}
      state={list.state} onStateChange={list.onStateChange} page={list.page} range={list.range}
      onPage={list.onPage} nextCursor={list.data?.next_cursor} isFetching={list.result.isFetching}
      label="Records" searchAvailable={false} onRowClick={() => {}}
      labels={{ search: copy.search, clearSearch: copy.clearSearch, noResults: copy.noResults,
        previous: copy.previousPage, next: copy.nextPage, pageSize: copy.rowsPerPage,
        pageSizeOption: count => copy.paginationSize.replace('{{count}}', String(count)),
        sort: column => column, range: (start, end) => `${start}–${end}` }}
    />
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: Fixture })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) })
  await router.load()
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  try {
    const user = userEvent.setup()
    await screen.findByRole('cell', { name: 'first' })
    await user.click(screen.getByRole('button', { name: copy.nextPage }))
    await screen.findByRole('cell', { name: 'second' })
    expect(request.mock.lastCall?.[0]).toMatchObject({ limit: 30, cursor: 'opaque-next' })
    const trigger = screen.getByRole('combobox', { name: copy.rowsPerPage })
    await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
    trigger.focus()
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    await waitFor(() => expect(request.mock.lastCall?.[0].limit).toBe(50))
    expect(request.mock.lastCall?.[0].cursor).toBeUndefined()
    await screen.findByRole('cell', { name: 'first' })
    expect(screen.getByRole('button', { current: 'page' }).textContent).toBe('1')
    expect(request).toHaveBeenCalledTimes(3)
  } finally {
    view.unmount()
    client.clear()
  }
})
