// @vitest-environment jsdom
import { createElement as h } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createBrowserHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { ConsoleProvider, RouteView } from '../src/react'
import { entityEditPage } from '../src/index'
const histories: ReturnType<typeof createBrowserHistory>[] = []
afterEach(() => { cleanup(); histories.splice(0).forEach(history => history.destroy()); vi.restoreAllMocks() })
test('real router back guards dirty draft and confirms before leaving', async () => {
  const confirm = vi.spyOn(globalThis as typeof globalThis & { confirm(message: string): boolean }, 'confirm').mockReturnValue(false)
  const definition = entityEditPage('probe', { title: 'probe.edit', recordParam: 'itemId', layout: ['name'] })
  const fields = { name: { type: 'string', required: true, readOnly: false, computed: false, userLink: false } }
  const route = { ...definition, path: '/items/$itemId/edit', source: 'ui/items.ts', links: { detail: { to: '/items/$itemId', bind: { itemId: 'record.id' } } } }
  const root = createRootRoute({ component: Outlet })
  const list = createRoute({ getParentRoute: () => root, path: '/items', component: () => h('p', null, 'List destination') })
  const edit = createRoute({ getParentRoute: () => root, path: '/items/$itemId/edit', component: () => h(RouteView, { definition, route, entities: { probe: { displayField: 'name', fields } }, params: edit.useParams(), search: {} }) })
  const native = globalThis as unknown as { history: { replaceState(data: unknown, unused: string, url: string): void } }
  native.history.replaceState(null, '', '/items')
  const history = createBrowserHistory(); histories.push(history)
  history.push('/items/x/edit'); history.flush()
  const router = createRouter({ routeTree: root.addChildren([list, edit]), history })
  render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'o' }, t: key => key, fetch: async () => new Response(JSON.stringify({ id: 'x', version: 1, name: 'Server' })) }, h(RouterProvider, { router })))
  fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: 'Dirty' } })
  history.back(); await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
  expect(history.location.pathname).toBe('/items/x/edit')
  confirm.mockReturnValue(true); history.back()
  expect(await screen.findByText('List destination')).toBeTruthy()
})
