// @vitest-environment jsdom
import { createElement as h } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ConsoleProvider, PageView } from '../src/react'
import { entityListPage, entityDetailPage, entityCreatePage, entityEditPage } from '../src/index'
import { gate } from '../src/gate'
import { grants } from './grants'
const entities = { probe: { displayField: 'name', fields: { name: { type: 'text', required: false, readOnly: false, computed: false, userLink: false } } } }
afterEach(cleanup)
function mount(mode: 'detail' | 'create' | 'edit', denied: 'list' | 'detail' | 'both' | 'none') {
  const caps = grants(entities)
  caps.resources = { source: true, list: !['list', 'both'].includes(denied), detail: !['detail', 'both'].includes(denied) }
  const list = { ...entityListPage('probe', { title: 'probe.list', grant: 'list' }), path: '/probe', source: 'ui/probe.ts', links: {} }
  const detail = { ...entityDetailPage('probe', { title: 'probe.detail', grant: 'detail', recordParam: 'id' }), path: '/probe/$id', source: 'ui/probe/$id.ts', links: {} }
  const definition = mode === 'create' ? entityCreatePage('probe', { title: 'probe.new', grant: 'source', layout: ['name'] })
    : (mode === 'edit' ? entityEditPage : entityDetailPage)('probe', { title: 'probe.source', grant: 'source', recordParam: 'id', layout: ['name'] })
  const route = { ...definition, path: '/source', source: 'ui/source.ts', links: { list: { to: '/probe', bind: {} }, detail: { to: '/probe/$id', bind: { id: 'record.id' } } } }
  const navigate = vi.fn(), fetch = vi.fn(async () => Response.json({ id: 'one', version: 1, name: 'Private row' }))
  expect(gate(caps, { entities }).allows(list)).toBe(caps.resources.list)
  expect(gate(caps, { entities }).allows(detail)).toBe(caps.resources.detail)
  render(h(ConsoleProvider, { caps, identity: { actorId: 'a', orgId: 'A' }, t: k => k, fetch }, h(PageView, { definition, route, entities, routes: [list, detail, route], params: { id: 'one' }, search: {}, navigate })))
  return { navigate, fetch }
}
test('detail Back is absent when its list destination grant is independently denied', async () => {
  const { navigate } = mount('detail', 'list')
  await screen.findByText('Private row')
  expect(screen.queryByText('sdk:back')).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
})
test('create Back and Cancel are absent when only the list destination grant is denied', () => {
  const { navigate } = mount('create', 'list')
  expect(screen.queryByText('sdk:back')).toBeNull()
  expect(screen.queryByText('sdk:cancel')).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
})
test('edit Back and Cancel are absent when only their detail destination is denied', async () => {
  const { navigate } = mount('edit', 'detail')
  await screen.findByLabelText('domain:field.probe.name')
  expect(screen.queryByText('sdk:back')).toBeNull()
  expect(screen.queryByText('sdk:cancel')).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
})
test.each(['create', 'edit'] as const)('%s save falls back to the allowed list when only the detail grant is denied', async mode => {
  const { navigate } = mount(mode, 'detail')
  const field = await screen.findByLabelText('domain:field.probe.name')
  fireEvent.change(field, { target: { value: 'New' } }); fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/probe'))
  expect(navigate).not.toHaveBeenCalledWith('/probe/one')
})
test('save stays on the form when both generated destinations are denied', async () => {
  const { navigate } = mount('create', 'both')
  fireEvent.change(screen.getByLabelText('domain:field.probe.name'), { target: { value: 'New' } }); fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect((screen.getByLabelText('domain:field.probe.name') as unknown as { value: string }).value).toBe('Private row'))
  expect(navigate).not.toHaveBeenCalled()
})
test('allowed Back, Cancel and save destinations remain usable', async () => {
  const { navigate } = mount('create', 'none')
  fireEvent.click(screen.getByText('sdk:back')); fireEvent.click(screen.getByText('sdk:cancel'))
  expect(navigate.mock.calls).toEqual([['/probe'], ['/probe']])
  fireEvent.change(screen.getByLabelText('domain:field.probe.name'), { target: { value: 'New' } }); fireEvent.click(screen.getByText('sdk:save'))
  await waitFor(() => expect(navigate).toHaveBeenLastCalledWith('/probe/one'))
})
