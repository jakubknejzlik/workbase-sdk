import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { validateListSearch } from '../../console-generated/src/list-model'
import { changeSavedViews } from '../../console-generated/src/saved-views'
import type { Model, Capabilities, ReadQuery } from '../../console-generated/src/read'
import { ReadPage } from '../src/read'
import { refreshRuntimeModel } from '../src/api/runtime-model'
import en from '../src/locales/en.json'
import { applyView } from './saved-views-menu'

const scope = { instance: 'reconciliation', userId: 'actor', orgId: 'org' }
const model: Model = { instance: scope.instance, revision: 1, limits: { root: 2, children: 10, relations: 4, exists: 4 }, entities: {
  entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, team_id: { type: 'ref', entity: 'teams' } }, columns: ['name'], relations: { team: { entity: 'teams', field: 'team_id', cardinality: 'n:1' } }, routes: { list: '', detail: '' }, list: { columns: [{ field: 'name' }], filter: { team_id: { kind: 'relation', placement: 'toolbar', operators: ['in'], label: 'Team' } } } },
  teams: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, alternate: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
} }
const caps: Capabilities = { revision: 1, entities: Object.fromEntries(Object.entries(model.entities).map(([name, entity]) => [name, { readable: Object.keys(entity.fields), writable: [], operations: ['read'] }])) }
const selected = (ids: string[]) => [{ field: 'team_id', predicate: { in: ids } }]
const clients: QueryClient[] = []
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), key: (index: number) => [...values.keys()][index], get length() { return values.size } })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(ids: string[] = [], saved = false, picker = false, panel = false) {
  let readable = new Set(['readable', 'revoked']), denied = false
  let definition = structuredClone(model)
  if (panel) definition.entities.entries.list!.filter!.team_id = { kind: 'relation', placement: 'panel', operators: ['in'], label: 'Team' }
  const permissions = structuredClone(caps)
  if (picker) {
    permissions.entities.entries.operations.push('create')
    permissions.entities.entries.writable = ['team_id']
    definition.entities.entries.writeSchema = { type: 'object', properties: { team_id: { type: 'string' } } }
  }
  let release: (() => void) | undefined, gate: Promise<void> | undefined
  const queries: ReadQuery[] = []
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/me?scope=organization') return Response.json(client.getQueryData(['organization', 'org']))
    if (path.endsWith('/console-model')) return Response.json({ contractVersion: 2, model: { ...definition, commands: [], workflows: [] }, capabilities: permissions, console: { navigation: [], pages: [], entities: {} } })
    if (path === '/query') {
      const query = JSON.parse(options!.body as string) as ReadQuery; queries.push(query)
      if (query.entity === 'teams') {
        await gate
        if (denied) return Response.json({ error: 'permission_denied' }, { status: 403 })
        const ids = (query.where?.id as { in?: string[] })?.in ?? ['readable', 'revoked']
        const data = ids.filter(id => readable.has(id)).map(id => ({ id, name: id === 'revoked' ? 'REVOKED_LABEL_CANARY' : 'Readable team', alternate: definition.entities.teams.displayField === 'alternate' ? 'New display' : 'OLD_DISPLAY_CANARY' }))
        return Response.json({ data: data.map(row => Object.fromEntries(query.select.map(field => [field, row[field as keyof typeof row]]))), next_cursor: null })
      }
      return Response.json({ data: [{ id: 'entry', name: 'Entry' }], next_cursor: null, total: 6, offset: query.offset, limit: query.limit })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client)
  client.setQueryData(['console-model', 'org'], { model: definition, capabilities: permissions, console: { navigation: [], pages: [], entities: {} } })
  client.setQueryData(['organization', 'org'], { user: { id: scope.userId }, memberships: [{ organization_id: 'org' }] })
  const entry = saved ? changeSavedViews(scope, 'entries', { kind: 'save', name: 'Restored', state: { search: '', sort: null, userFilters: selected(ids), presetFilters: [], limit: 30 } }).entries[0] : undefined
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity', validateSearch: validateListSearch, component: () => <ReadPage orgId="org" entity="entries" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/org/e/entries'] }) })
  await router.load()
  if (ids.length && !saved) await router.navigate({ to: '.', search: { filters: selected(ids) } as any })
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, entity_entries: 'Entries', field_name: 'Name', field_team_id: 'Team', entitySingular_entries: 'Entry' } } } })
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></I18nextProvider>)
  const user = userEvent.setup()
  if (entry) { await screen.findByRole('region', { name: en.savedViews }); await applyView(user, entry.name) }
  return { view, client, router, user, queries, source: () => queries.filter(query => query.entity === 'entries'),
    revoke: () => { readable = new Set(['readable']) }, deny: () => { denied = true },
    hold: () => { gate = new Promise<void>(resolve => { release = resolve }) }, release: () => { release?.(); gate = undefined },
    refresh: async () => { await act(async () => { await refreshRuntimeModel(client, 'org') }) },
    redefine: () => { definition = structuredClone(definition); definition.entities.teams.displayField = 'alternate' },
  }
}
it.each([false, true])('reconciles deleted/unreadable restored IDs before querying the source (saved=%s)', async saved => {
  const test = await mount(['readable', 'deleted', 'unreadable'], saved)
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual(selected(['readable'])))
  await waitFor(() => expect(test.source().at(-1)?.where).toEqual({ and: [{ team_id: { in: ['readable'] } }] }))
  for (const query of test.source().filter(query => query.where)) expect(query.where).toEqual({ and: [{ team_id: { in: ['readable'] } }] })
  expect(test.queries.some(query => query.entity === 'teams' && JSON.stringify(query.select) === '["id"]')).toBe(true)
  for (const query of test.queries.filter(query => query.entity === 'teams' && query.select.length > 1)) {
    expect(query.where).toEqual({ id: { in: ['readable'] } })
  }
  expect(screen.queryByText('REVOKED_LABEL_CANARY')).toBeNull()
  expect(screen.getByText(en.listStateDropped)).toBeTruthy()
  expect((test.router.state.location.state as any).generatedList).toMatchObject({ cursors: [], notice: 'listStateDropped' })
})
it.each(['permission', 'actor', 'definition'] as const)('revalidates warm selected labels on %s change even with identical capability masks', async change => {
  const test = await mount(['revoked'])
  await waitFor(() => expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/).length).toBeGreaterThan(0))
  await test.user.click(screen.getByRole('button', { name: en.nextPage }))
  await waitFor(() => expect(test.source().at(-1)?.offset).toBe(2))
  test.hold()
  if (change === 'definition') test.redefine()
  else test.revoke()
  if (change === 'actor') await act(async () => { test.client.setQueryData(['organization', 'org'], { user: { id: 'other-actor' }, memberships: [{ organization_id: 'org' }] }) })
  else await test.refresh()
  await waitFor(() => expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/)).toHaveLength(0))
  await act(async () => test.release())
  if (change === 'definition') {
    await waitFor(() => expect(screen.queryAllByText(/New display/).length).toBeGreaterThan(0))
    expect(screen.queryAllByText(/OLD_DISPLAY_CANARY/)).toHaveLength(0)
  }
  else {
    await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
    expect(test.source().at(-1)?.cursor).toBeUndefined()
    // A different actor does not inherit (and then revalidate) the previous confirmed state: it is discarded outright.
    if (change === 'actor') expect(screen.queryByText(en.listStateDropped)).toBeNull()
    else expect(screen.getByText(en.listStateDropped)).toBeTruthy()
  }
})
it('does not apply unverified IDs or revive labels when revalidation fails', async () => {
  const test = await mount(['revoked'])
  await waitFor(() => expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/).length).toBeGreaterThan(0))
  test.deny(); await test.refresh()
  await waitFor(() => expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/)).toHaveLength(0))
  expect(test.router.state.location.search.filters).toEqual(selected(['revoked']))
  await screen.findByText('You do not have access to entries in this organization.')
})

it('clears an actual picker selected-reference cache after policy revocation without changing grants or the draft ID', async () => {
  const test = await mount([], false, true)
  await test.user.click(await screen.findByRole('button', { name: 'Add Entry' }))
  const picker = await within(await screen.findByRole('dialog')).findByRole('combobox', { name: 'Team' })
  await test.user.click(picker)
  await test.user.click(await screen.findByRole('option', { name: 'REVOKED_LABEL_CANARY' }))
  await waitFor(() => expect(picker).toHaveProperty('value', 'REVOKED_LABEL_CANARY'))
  const hydratedBefore = test.queries.filter(query => query.entity === 'teams' && JSON.stringify(query.where) === '{"id":{"in":["revoked"]}}').length
  test.revoke(); test.hold(); await test.refresh()
  await waitFor(() => expect(picker).toHaveProperty('value', ''))
  expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/)).toHaveLength(0)
  await act(async () => test.release())
  await waitFor(() => expect(test.queries.filter(query => query.entity === 'teams' && JSON.stringify(query.where) === '{"id":{"in":["revoked"]}}').length).toBeGreaterThan(hydratedBefore))
  expect(picker).toHaveProperty('value', '')
  expect(screen.getByRole('dialog')).toBeTruthy()
})
it('ignores an obsolete restored-ID response after navigation changes the selection', async () => {
  const test = await mount(['readable'])
  await waitFor(() => expect(test.source().length).toBeGreaterThan(0))
  test.hold()
  await act(async () => { await test.router.navigate({ to: '.', search: { filters: selected(['unreadable']) } as any }) })
  await waitFor(() => expect(test.queries.some(query => query.entity === 'teams' && JSON.stringify(query.where).includes('unreadable'))).toBe(true))
  await act(async () => { await test.router.navigate({ to: '.', search: { filters: selected(['readable']) } as any }) })
  await act(async () => test.release())
  await waitFor(() => expect(test.router.state.location.search.filters).toEqual(selected(['readable'])))
  await waitFor(() => expect(test.source().at(-1)?.where).toEqual({ and: [{ team_id: { in: ['readable'] } }] }))
  expect(screen.queryByText(en.listStateDropped)).toBeNull()
})

it('rechecks an explicitly reapplied saved view even when its selected IDs have not changed', async () => {
  const test = await mount(['revoked'], true)
  await waitFor(() => expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/).length).toBeGreaterThan(0))
  test.revoke()
  await applyView(test.user, 'Restored')
  await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
  expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/)).toHaveLength(0)
  expect(screen.getByText(en.listStateDropped)).toBeTruthy()
})

it('revalidates a previously verified URL selection after leaving and returning to it', async () => {
  const test = await mount(['revoked'])
  await waitFor(() => expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/).length).toBeGreaterThan(0))
  await act(async () => { await test.router.navigate({ to: '.', search: {} }) })
  test.revoke()
  await act(async () => { await test.router.navigate({ to: '.', search: { filters: selected(['revoked']) } as any }) })
  await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
  expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/)).toHaveLength(0)
  expect(screen.getByText(en.listStateDropped)).toBeTruthy()
})
it('retains the page after an unchanged authority refresh while revalidating the selected IDs', async () => {
  const test = await mount(['readable'])
  await waitFor(() => expect(test.source().length).toBeGreaterThan(0))
  await test.user.click(screen.getByRole('button', { name: en.nextPage }))
  await waitFor(() => expect(test.source().at(-1)?.offset).toBe(2))
  const before = test.source().length
  await test.refresh()
  await waitFor(() => expect(test.source().length).toBeGreaterThan(before))
  expect(test.source().at(-1)?.offset).toBe(2)
  expect(test.router.state.location.search.filters).toEqual(selected(['readable']))
  expect(screen.queryByText(en.listStateDropped)).toBeNull()
})


it.each(['permission', 'actor'] as const)('revalidates a panel draft applied after %s authority changes', async change => {
  const test = await mount([], false, false, true)
  await test.user.click(await screen.findByText(en.sortAndFilter))
  const panel = screen.getByRole('group', { name: en.sortAndFilter })
  const picker = within(panel).getByRole('combobox', { name: 'Team' })
  await test.user.click(picker)
  await test.user.click(await screen.findByRole('option', { name: 'REVOKED_LABEL_CANARY' }))
  await waitFor(() => expect(within(panel).queryAllByText(/REVOKED_LABEL_CANARY/).length).toBeGreaterThan(0))
  expect(test.router.state.location.search.filters).toBeUndefined()

  test.revoke()
  if (change === 'actor') await act(async () => { test.client.setQueryData(['organization', 'org'], { user: { id: 'other-actor' }, memberships: [{ organization_id: 'org' }] }) })
  else await test.refresh()
  await waitFor(() => expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/)).toHaveLength(0))
  if (change === 'actor') {
    // The draft belonged to the previous actor: the panel is gone and nothing from it can be applied.
    expect(document.body.contains(panel)).toBe(false)
    expect(screen.queryByRole('group', { name: en.sortAndFilter })).toBeNull()
    await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
    for (const query of test.source()) expect(JSON.stringify(query.where ?? {})).not.toContain('revoked')
    expect(screen.queryByText(en.listStateDropped)).toBeNull()
    return
  }
  const beforeApply = test.queries.length
  await test.user.click(within(panel).getByRole('button', { name: en.applyFilter }))

  await waitFor(() => expect(test.router.state.location.search.filters).toBeUndefined())
  expect(screen.getByText(en.listStateDropped)).toBeTruthy()
  expect(test.queries.slice(beforeApply).some(query => query.entity === 'teams' && JSON.stringify(query.select) === '["id"]' && JSON.stringify(query.where) === '{"id":{"in":["revoked"]}}')).toBe(true)
  for (const query of test.source()) expect(JSON.stringify(query.where ?? {})).not.toContain('revoked')
  expect(test.source().at(-1)?.where).toBeUndefined()
  expect(screen.queryAllByText(/REVOKED_LABEL_CANARY/)).toHaveLength(0)
  expect((test.router.state.location.state as any).generatedList).toMatchObject({ cursors: [], notice: 'listStateDropped' })
})
it('purges the replaced actor\'s cached list rows, counts and totals when the console observes a different actor', async () => {
  const test = await mount([])
  const owned = (actor: string) => test.client.getQueryCache().findAll({ queryKey: ['data-table'] }).filter(query => String(query.queryKey.at(-1)).includes(`"${actor}"`))
  await waitFor(() => expect(owned('actor').length).toBeGreaterThan(0))
  await act(async () => { test.client.setQueryData(['organization', 'org'], { user: { id: 'other-actor' }, memberships: [{ organization_id: 'org' }] }) })
  await waitFor(() => expect(owned('other-actor').length).toBeGreaterThan(0))
  expect(owned('actor')).toEqual([])
})
