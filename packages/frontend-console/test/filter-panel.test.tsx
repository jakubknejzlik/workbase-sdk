import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { validateListSearch } from '../../console-generated/src/list-model'
import { changeSavedViews } from '../../console-generated/src/saved-views'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import { applyView } from './saved-views-menu'

const scope = { instance: 'filter-panel', userId: 'actor', orgId: 'org' }
const model: Model = { instance: scope.instance, revision: 1, limits: { root: 100, children: 100, relations: 4, exists: 4 }, pickerHints: { entries: { team_id: { labelTemplate: '{secret}' } } }, entities: {
  entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'enum', values: ['active', 'inactive'] }, team_id: { type: 'ref', entity: 'teams' }, created: { type: 'datetime' } }, columns: ['name'], relations: { team: { entity: 'teams', field: 'team_id', cardinality: 'n:1' } }, routes: { list: '', detail: '' }, views: [{ kind: 'calendar', startField: 'created' }], list: { columns: [{ field: 'name' }], filter: { status: { kind: 'enum', placement: 'panel', operators: ['in'], label: 'Status' }, team_id: { kind: 'relation', placement: 'panel', operators: ['in'], label: 'Team' } } } },
  teams: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, secret: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
} }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: Object.keys(model.entities.entries.fields), writable: [], operations: ['read'] }, teams: { readable: ['id', 'name', 'secret'], writable: [], operations: ['read'] } } }
const filters = [{ field: 'status', predicate: { in: ['active'] } }, { field: 'team_id', predicate: { in: ['team-b'] } }]
const clients: QueryClient[] = []
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), key: (index: number) => [...values.keys()][index], get length() { return values.size } }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(options: { toolbarRelation?: boolean; narrow?: boolean; calendar?: boolean; embedded?: boolean; filters?: typeof filters; caps?: Capabilities } = {}) {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: !!options.narrow, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true } }))
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', field_status: 'Status', field_team_id: 'Team', value_active: 'Active', value_inactive: 'Inactive' } } } })
  const definition = structuredClone(model)
  if (options.toolbarRelation) definition.entities.entries.list!.filter!.team_id = { kind: 'relation', placement: 'toolbar', operators: ['in'], label: 'Team' }
  let release: (() => void) | undefined, verificationGate: Promise<void> | undefined
  const request = vi.fn(async (query: ReadQuery) => {
    if (query.entity === 'teams') {
      if (query.where?.id && query.select.join() === 'id') await verificationGate
      const ids = query.where?.id ? (query.where.id as { in: string[] }).in : [query.cursor ? 'team-b' : 'team-a']
      return { data: ids.filter(id => ['team-a', 'team-b'].includes(id)).map(id => ({ id, name: 'Same label', secret: 'CUSTOM_TEMPLATE_CANARY' })), next_cursor: query.cursor || query.where?.id ? null : 'target-next' }
    }
    return { data: [{ id: query.offset || query.cursor ? 'second' : 'first', name: 'Entry', created: '2026-11-17T00:00:00Z' }], next_cursor: query.cursor ? null : 'source-next', total: 100, offset: query.offset, limit: query.limit }
  })
  let update!: (value: { model: Model; caps: Capabilities }) => void
  function Fixture() {
    const [context, setContext] = useState({ model: definition, caps: options.caps ?? caps }); update = setContext
    return <GeneratedReadPage {...context} orgId="org" entity="entries" request={request} savedViewsScope={scope} contextList={options.embedded ? { entity: 'parents', id: 'parent', list: 'entries' } : undefined} />
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: Fixture })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) })
  await router.load()
  if (options.filters || options.calendar) await router.navigate({ to: '.', search: { filters: options.filters, ...(options.calendar ? { presentation: 'calendar', calendarDate: '2026-11-17' } : {}) } as any })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  await waitFor(() => expect(request).toHaveBeenCalled())
  return { holdVerification: () => { verificationGate = new Promise(resolve => { release = resolve }) }, releaseVerification: () => { release?.(); verificationGate = undefined }, router, request, update, user: userEvent.setup(), source: () => request.mock.calls.map(([query]) => query).filter(query => query.entity === 'entries').at(-1)! }
}
it.each([{ narrow: false }, { narrow: true }, { calendar: true }, { narrow: true, calendar: true }, { embedded: true }])('stages hidden scalar and exact-ID relation filters independently of columns: %j', async options => {
  const { user, source, request } = await mount(options)
  await user.click(screen.getByText(en.sortAndFilter))
  const panel = screen.getByRole('group', { name: en.sortAndFilter })
  await user.click(within(panel).getByRole('checkbox', { name: 'Active' }))
  expect(JSON.stringify(source().where ?? {})).not.toContain('status')
  const picker = within(panel).getByRole('combobox', { name: 'Team' })
  await user.click(picker)
  if (!options.narrow && !options.calendar && !options.embedded) {
    await user.type(picker, 'Same')
    await waitFor(() => expect(request.mock.calls.some(([query]) => query.entity === 'teams' && JSON.stringify(query.where) === JSON.stringify({ name: { contains: 'Same' } }))).toBe(true))
  }
  await user.click(await screen.findByRole('option', { name: 'Same label' }))
  await user.click(picker)
  await user.click(screen.getByRole('button', { name: en.loadMore }))
  await waitFor(() => expect(request.mock.calls.some(([query]) => query.entity === 'teams' && query.cursor === 'target-next')).toBe(true))
  await user.click((await screen.findAllByRole('option', { name: 'Same label' })).at(-1)!)
  expect(screen.queryByText('CUSTOM_TEMPLATE_CANARY')).toBeNull()
  expect(JSON.stringify(source().where ?? {})).not.toContain('team_id')
  await user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(JSON.stringify(source().where ?? {})).toContain('"team_id":{"in":["team-a","team-b"]}'))
  expect(JSON.stringify(source().where ?? {})).toContain('"status":{"in":["active"]}')
  expect(source().labelWhere).toBeUndefined()
  expect(screen.queryByRole('columnheader', { name: /Status|Team/ })).toBeNull()
  expect(model.entities.entries.list!.columns).toEqual([{ field: 'name' }])
  if (options.embedded) expect(source().select).not.toContain('team_id')
  await user.click(screen.getByText(en.sortAndFilter))
  await user.click(within(screen.getByRole('group', { name: en.sortAndFilter })).getByRole('checkbox', { name: 'Inactive' }))
  await user.click(within(screen.getByRole('group', { name: en.sortAndFilter })).getByRole('button', { name: en.cancel }))
  expect(JSON.stringify(source().where ?? {})).not.toContain('inactive')
})
it('uses the same synchronous pruning for URL and saved views, resets paging, and retains hidden readable filters', async () => {
  changeSavedViews(scope, 'entries', { kind: 'save', name: 'Hidden filters', state: { search: '', sort: null, userFilters: filters, presetFilters: [], limit: 30 } })
  const { user, router, update, source } = await mount({ filters })
  await waitFor(() => expect(source()?.where).toEqual({ and: filters.map(filter => ({ [filter.field]: filter.predicate })) }))
  await user.click(screen.getByRole('button', { name: en.nextPage }))
  await waitFor(() => expect(source().offset).toBe(30))
  const changed = structuredClone(model); delete changed.entities.entries.list!.filter!.team_id
  const reduced = structuredClone(caps); reduced.entities.entries.readable = reduced.entities.entries.readable.filter(field => field !== 'status')
  await act(async () => update({ model: changed, caps: reduced }))
  await waitFor(() => expect(router.state.location.search.filters).toBeUndefined())
  expect(source().cursor).toBeUndefined()
  expect(screen.getByText(en.listStateDropped)).toBeTruthy()
  await applyView(user, 'Hidden filters')
  await waitFor(() => expect((router.state.location.state as any).generatedList).toMatchObject({ cursors: [], notice: 'listStateDropped' }))
  expect(router.state.location.search.filters).toBeUndefined()
})
it('exposes no relation options or selected labels without target read, even for restored IDs', async () => {
  const denied = structuredClone(caps); denied.entities.teams.operations = []
  const { request } = await mount({ filters, caps: denied })
  await screen.findByText(en.listStateDropped)
  await userEvent.click(screen.getByText(en.sortAndFilter))
  expect(screen.queryByRole('combobox', { name: 'Team' })).toBeNull()
  expect(screen.queryByText('Same label')).toBeNull()
  expect(screen.queryByText('CUSTOM_TEMPLATE_CANARY')).toBeNull()
  expect(request.mock.calls.some(([query]) => query.entity === 'teams')).toBe(false)
})

it('merges a panel Apply with a toolbar relation selection still awaiting fresh ID verification', async () => {
  const test = await mount({ toolbarRelation: true })
  await test.user.click(screen.getByText(en.sortAndFilter))
  const panel = screen.getByRole('group', { name: en.sortAndFilter })
  await test.user.click(within(panel).getByRole('checkbox', { name: 'Active' }))
  test.holdVerification()
  await test.user.click(screen.getByRole('combobox', { name: 'Team' }))
  await test.user.click(await screen.findByRole('option', { name: 'Same label' }))
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'team_id', predicate: { in: ['team-a'] } }]))
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual([{ field: 'team_id', predicate: { in: ['team-a'] } }, { field: 'status', predicate: { in: ['active'] } }]))
  await act(async () => test.releaseVerification())
  await waitFor(() => expect(test.source().where).toEqual({ and: [{ team_id: { in: ['team-a'] } }, { status: { in: ['active'] } }] }))
})
