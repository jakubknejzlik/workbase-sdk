// @vitest-environment jsdom
import { createElement as h } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ConsoleProvider, PageView, Shell } from '../src/react'
import { gate } from '../src/gate'
import { customPage, entityCreatePage, entityDetailPage, entityEditPage, entityListPage, type Page } from '../src/index'
import type { Manifest } from '../src/check'
import { grants } from './grants'
const entities = { probe: { displayField: 'name', fields: { name: { type: 'text', required: false, readOnly: false, computed: false, userLink: false } } } }
const caps = grants(entities)
caps.resources['page.probe'] = true
const fixtures = [
  entityListPage('probe', { title: 'test.list' }), entityDetailPage('probe', { title: 'test.detail', recordParam: 'id' }),
  entityCreatePage('probe', { title: 'test.create' }), entityEditPage('probe', { title: 'test.edit', recordParam: 'id' }),
  customPage({ title: 'test.custom', uses: ['probe.name'], component: () => h('p', null, 'Private custom component') }),
]
afterEach(cleanup)
for (const fixture of fixtures) test.each(['allowed', 'missing', 'dependency', 'unknown'] as const)(`${fixture.title}: direct URL and menu agree for %s`, async scenario => {
  const definition: Page = { ...fixture, grant: scenario === 'missing' ? undefined : scenario === 'unknown' ? 'page.unknown' : 'page.probe' }
  const effective = scenario === 'dependency' ? { ...caps, entities: { probe: { ...caps.entities.probe, operations: [] } } } : caps
  const route = { ...definition, path: '/probe', source: 'ui/probe.ts', links: {} }
  const manifest: Manifest = { version: 3, configHash: 'fixture', entities, keys: {}, slots: {}, routes: [route], nav: [{ title: definition.title, link: { to: '/probe', bind: {} } }] }
  const fetch = vi.fn(async (url: string) => Response.json(url === '/query' ? { data: [], next_cursor: null } : { id: 'one', version: 1, name: 'Private row' }))
  render(h(ConsoleProvider, { caps: effective, identity: { actorId: 'actor', orgId: 'org' }, t: key => key, fetch }, h(Shell, { manifest }, h(PageView, { definition, route, entities, params: { id: 'one' }, search: {}, navigate: () => {} }))))
  const allowed = scenario === 'allowed'
  expect(gate(effective, manifest).allows(definition)).toBe(allowed)
  expect(screen.queryByRole('link') !== null).toBe(allowed)
  if (allowed) expect(await screen.findByRole('heading')).toBeTruthy()
  else {
    expect((screen.getByRole('alert') as unknown as { textContent: string }).textContent).toBe('sdk:forbidden')
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByText('Private custom component')).toBeNull()
  }
})
test('uses declares dependencies and cannot supply an omitted or unknown grant', () => {
  const permission = gate(caps, { entities })
  for (const grant of [undefined, 'unknown']) expect(permission.allows(customPage({ title: 'test.custom', grant, uses: ['probe.name'], component: () => null }))).toBe(false)
  expect(permission.allows(customPage({ title: 'test.custom', grant: 'page.probe', uses: ['probe.missing'], component: () => null }))).toBe(false)
})
test('read identity and edit update are requirements independent of an allowed page grant', () => {
  for (const denied of [{ ...caps.entities.probe, readable: ['name'] }, { ...caps.entities.probe, operations: ['update'] }]) {
    const permission = gate({ ...caps, entities: { probe: denied } }, { entities })
    for (const fixture of fixtures.filter(f => f.mode !== 'create')) expect(permission.allows({ ...fixture, grant: 'page.probe' })).toBe(false)
  }
  expect(gate({ ...caps, entities: { probe: { ...caps.entities.probe, operations: ['read'] } } }, { entities }).allows({ ...fixtures[3], grant: 'page.probe' })).toBe(false)
  expect(gate({ ...caps, entities: { probe: { operations: ['create'], readable: [] } } }, { entities }).allows({ ...fixtures[2], grant: 'page.probe' })).toBe(true)
})

test.each(['own', 'source', 'target', 'transitive'])('server-denied derived field (%s) is absent from UI metadata, selections, operands and slot props', async reason => {
  const derived = 'derived_' + reason
  const metadata = { displayField: derived, fields: { ...entities.probe.fields, [derived]: { ...entities.probe.fields.name, computed: true } } }
  // This is the server's final decision; the client receives no dependency graph.
  const effective = { ...caps, entities: { probe: { operations: ['read'], readable: ['id', 'name'], writable: [] } } }
  const spy = vi.fn(() => h('p', null, 'Private slot'))
  const definition = entityListPage('probe', { title: 'test.derived', grant: 'page.probe', layout: [derived, { kind: 'slot', id: 'derived', props: { value: derived } }] })
  const route = { ...definition, path: '/probe', source: 'ui/probe.ts', links: {} }
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body))
    expect(input.select).toEqual(['id', 'name']); expect(input.orderBy).toEqual([{ field: 'id', dir: 'asc' }]); expect(input.search).toBeUndefined()
    return Response.json({ data: [{ id: 'one', name: 'Visible', [derived]: 'Denied derived bytes' }], next_cursor: null })
  })
  const permission = gate(effective, { entities: { probe: metadata } })
  expect(permission.metadata('probe')).toEqual({ displayField: 'id', fields: entities.probe.fields })
  render(h(ConsoleProvider, { caps: effective, identity: { actorId: 'actor', orgId: 'org' }, t: key => key, fetch, slots: { derived: { contexts: ['row'], props: { value: { kind: 'field', type: 'text' } }, component: spy } } }, h(PageView, { definition, route, entities: { probe: metadata }, params: {}, search: {}, navigate: () => {} })))
  await screen.findByText('one')
  expect(screen.queryByText('Denied derived bytes')).toBeNull(); expect(screen.queryByRole('option', { name: 'domain:field.probe.' + derived })).toBeNull()
  expect(screen.queryByLabelText('sdk:search')).toBeNull(); expect(spy).not.toHaveBeenCalled()
})

test('a create-only grant mounts writable inputs without fetching or requiring readable rows', async () => {
  const { fireEvent } = await import('@testing-library/react')
  const effective = { ...caps, entities: { probe: { operations: ['create'], readable: [], writable: ['name'] } } }
  const definition = entityCreatePage('probe', { title: 'test.createOnly', grant: 'page.probe', layout: ['name'] })
  const route = { ...definition, path: '/probe/new', source: 'ui/probe.ts', links: {} }
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    expect(init.method).toBe('POST'); expect(JSON.parse(String(init.body))).toEqual({ name: 'New record' })
    return Response.json({ id: 'new', version: 1, name: 'New record' })
  })
  render(h(ConsoleProvider, { caps: effective, identity: { actorId: 'actor', orgId: 'org' }, t: key => key, fetch }, h(PageView, { definition, route, entities, params: {}, search: {}, navigate: () => {} })))
  fireEvent.change(screen.getByLabelText('domain:field.probe.name'), { target: { value: 'New record' } })
  fireEvent.click(screen.getByText('sdk:save'))
  expect(fetch).toHaveBeenCalledTimes(1)
})
