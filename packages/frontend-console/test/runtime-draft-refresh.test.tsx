import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { getMutationSafetySnapshot, subscribeMutationSafety } from '@workbasehq/ui'
import en from '../src/locales/en.json'
import { ReadPage } from '../src/read'
import { adaptConsoleModel, refreshRuntimeModel } from '../src/api/runtime-model'
import { fetchCapabilities } from '../src/api/queries'
import { buildReload, createBuildReloadCoordinator } from '../src/build-reload'
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ search: {}, state: {}, pathname: '/o/org/e/entries', searchStr: '' }), useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
const dispose: (() => void)[] = []
afterEach(() => { dispose.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function document(revision = 1): ConsoleModelContract {
  return {
    contractVersion: 1, console: { entities: {}, navigation: [], pages: [] },
    model: { instance: 'drafts', revision, locale: 'en', timeZone: 'UTC', limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
      entries: { displayField: 'name', fields: { id: { type: 'string' }, version: { type: 'integer' }, name: { type: 'string' } }, writeSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, columns: ['name'], relations: {}, routes: {} },
    }, commands: [], workflows: [] },
    capabilities: { revision, organization: { role: 'admin' }, entities: { entries: { operations: ['read', 'create', 'update'], readable: ['id', 'version', 'name'], writable: ['name'] } }, commands: [], resources: {}, workflows: {} },
  } as unknown as ConsoleModelContract
}
type Layout = 'simple' | 'grouped' | 'membership'
function fixture(revision = 1, layout: Layout = 'simple') {
  const next = document(revision)
  const entry = next.model.entities.entries
  entry.fields.note = { type: 'string', required: false, nullable: false, operators: [] }
  Object.assign(entry.writeSchema!.properties!, { note: { type: 'string' } })
  next.capabilities.entities.entries.readable.push('note')
  next.capabilities.entities.entries.writable.push('note')
  if (layout === 'grouped') entry.detail = { groups: [{ id: 'main', label: 'Main', fields: ['name'] }] }
  if (layout === 'membership') {
    entry.relations.tags = { entity: 'entry_tags', field: 'entry_id', cardinality: '1:n', through: { entity: 'tags', field: 'tag_id', createCommand: 'entry_tags/create', deleteCommand: 'entry_tags/delete' } }
    for (const [entity, fields] of Object.entries({ tags: { id: { type: 'string' }, name: { type: 'string' } }, entry_tags: { id: { type: 'string' }, entry_id: { type: 'ref', entity: 'entries' }, tag_id: { type: 'ref', entity: 'tags' } } })) {
      next.model.entities[entity] = { displayField: entity === 'tags' ? 'name' : undefined, fields, columns: Object.keys(fields), relations: {}, routes: {} } as unknown as typeof entry
      next.capabilities.entities[entity] = { operations: ['read'], readable: Object.keys(fields), writable: [] }
    }
    next.capabilities.commands = ['entry_tags/create', 'entry_tags/delete']
  }
  return next
}
async function setup(id?: string, layout: Layout = 'simple') {
  let next = fixture(1, layout), status = 200, detailStatus = 200, writeStatus = 200, row = { id: id ?? 'one', version: 1, name: 'Ada', note: 'Original note' }, missing = false, sha = 'A'
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>()
  const queryStatus = new Map<string, number>()
  const tasks = new Set<() => void>(), reload = vi.fn(), storage = new Map<string, string>()
  const coordinator = createBuildReloadCoordinator({ safety: getMutationSafetySnapshot, subscribe: subscribeMutationSafety,
    readBuild: async () => (await fetch('/build.json')).json(), reload, navigationSettled: () => true,
    storage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) } }), storageKey: 'attempts',
    defer: callback => { tasks.add(callback); return () => { tasks.delete(callback) } },
  })
  dispose.push(coordinator.mount()); coordinator.observe({ sha })
  const flush = () => { const batch = [...tasks]; tasks.clear(); batch.forEach(fn => fn()) }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['console-model', 'org'], adaptConsoleModel(next)); client.setQueryData(['capabilities', 'org'], next.capabilities)
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/build.json') return Response.json({ sha })
    if (path.endsWith('/capabilities')) return Response.json(next.capabilities)
    if (path.endsWith('/console-model')) return Response.json(status === 200 ? next : { error: 'permission_denied' }, { status })
    if (path === '/query') {
      const query = JSON.parse(init!.body as string)
      const kind = query.entity === 'entry_tags' ? 'membership' : ['entries', 'other'].includes(query.entity) && layout === 'grouped' && query.select.includes('note') ? 'edit' : ['entries', 'other'].includes(query.entity) ? 'detail' : 'picker'
      await (gates.get(kind) ?? gates.get('all'))?.promise
      const code = queryStatus.get(kind) ?? (kind === 'detail' ? detailStatus : 200)
      if (code !== 200) return Response.json({ error: 'permission_denied' }, { status: code })
      const data = kind === 'membership' ? [{ id: 'join', entry_id: row.id, tag_id: 'tag' }] : kind === 'picker' ? [{ id: 'tag', name: 'Tag' }] : missing ? [] : [row]
      return Response.json({ data, next_cursor: null })
    }
    if (path.startsWith('/api/')) return Response.json(writeStatus === 200 ? { ...row, ...JSON.parse(init!.body as string) } : { error: 'version_conflict' }, { status: writeStatus })
    throw new Error(`Unexpected path ${path}`)
  }); vi.stubGlobal('fetch', fetcher)
  const refreshBuild = vi.spyOn(buildReload, 'refresh').mockImplementation(coordinator.refresh)
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', field_note: 'Note', relation_tags: 'Tags', entity_entries: 'Entries', entitySingular_entries: 'Entry' } } } })
  const tree = (route: { orgId: string; entity: string; id?: string }) => <I18nextProvider i18n={i18n}><QueryClientProvider client={client}><ReadPage {...route} /></QueryClientProvider></I18nextProvider>
  const view = render(tree({ orgId: 'org', entity: 'entries', id }))
  const cleanup = () => { gates.forEach(gate => gate.release()); view.unmount(); client.clear() }; dispose.push(cleanup)
  await screen.findByRole('heading', { name: id ? 'Ada' : 'Entries' })
  fireEvent.click(screen.getByRole('button', { name: id ? 'Edit' : 'Add Entry' }))
  const input = await screen.findByRole('textbox', { name: 'Name' }); fireEvent.change(input, { target: { value: 'Grace' } })
  expect(getMutationSafetySnapshot().dirty).toBe(true)
  const dialog = screen.getByRole('dialog'), form = input.closest('form')!
  return { client, input, dialog, form, refreshBuild, view, fetcher, coordinator, reload, flush,
    holdQueries: (kind = 'all') => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); gates.set(kind, { promise, release }) },
    releaseQueries: (kind = 'all') => { gates.get(kind)?.release(); gates.delete(kind) },
    next: (value: ConsoleModelContract) => { next = value }, deny: (value: number) => { status = value },
    detailStatus: (value: number) => { detailStatus = value }, writeStatus: (value: number) => { writeStatus = value }, queryStatus: (kind: string, value: number) => { queryStatus.set(kind, value) },
    serverRow: (value: typeof row) => { row = value }, missing: () => { missing = true }, sha: (value: string) => { sha = value },
    reroute: (route: { orgId: string; entity: string; id?: string }) => view.rerender(tree(route)), cleanup,
  }
}
const writes = (test: Awaited<ReturnType<typeof setup>>) => test.fetcher.mock.calls.filter(([path]) => path.startsWith('/api/'))
const queries = (test: Awaited<ReturnType<typeof setup>>) => test.fetcher.mock.calls.filter(([path]) => path === '/query').length
function expectDraft(test: Awaited<ReturnType<typeof setup>>) {
  expect(screen.getByRole('dialog')).toBe(test.dialog)
  expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input)
  expect(test.input.closest('form')).toBe(test.form)
  expect(test.input).toHaveProperty('value', 'Grace')
  expect(getMutationSafetySnapshot().dirty).toBe(true)
}
async function refresh(test: Awaited<ReturnType<typeof setup>>, next = fixture(2)) {
  test.next(next)
  await act(async () => { await fetchCapabilities(test.client, 'org') })
  await waitFor(() => expect(test.client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', 'org'])?.capabilities.revision).toBe(next.capabilities.revision))
}
it('revision-only runtime refresh retains a real registered create draft and requests a build observation', async () => {
  const test = await setup(); test.holdQueries(); test.next(document(2))
  await act(async () => { await fetchCapabilities(test.client, 'org') })
  await waitFor(() => expect(test.client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', 'org'])?.capabilities.revision).toBe(2))
  expect(test.refreshBuild).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input); expect(test.input).toHaveProperty('value', 'Grace'); expect(getMutationSafetySnapshot().dirty).toBe(true)
  test.cleanup()
})
it('live create revocation is applied immediately despite a dirty draft', async () => {
  const test = await setup(); const next = document(2); next.capabilities.entities.entries.operations = ['read']; test.next(next)
  await act(async () => { await fetchCapabilities(test.client, 'org') })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('button', { name: 'Add Entry' })).toBeNull()
  test.cleanup()
})
it.each([403, 500])('failed runtime read (%s) fails closed instead of retaining stale authorization', async status => {
  const test = await setup(); test.deny(status)
  await act(async () => { await refreshRuntimeModel(test.client, 'org').catch(() => {}) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('button', { name: 'Add Entry' })).toBeNull(); test.cleanup()
})
it.each(['simple', 'grouped', 'membership'] as const)('revision-only refresh retains the same %s detail editor and baseline during and after delayed reads', async layout => {
  const test = await setup('one', layout), before = queries(test)
  test.holdQueries(); test.serverRow({ id: 'one', version: 9, name: 'Server replacement', note: 'Replacement note' })
  await refresh(test, fixture(2, layout))
  await waitFor(() => expect(queries(test)).toBeGreaterThan(before))
  expectDraft(test)
  expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  // Even native/programmatic submission must not write while reads are pending.
  await act(async () => { fireEvent.submit(test.form) }); expect(writes(test)).toHaveLength(0)
  await act(async () => test.releaseQueries())
  await screen.findByRole('heading', { name: 'Server replacement' })
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
  expectDraft(test)
  fireEvent.click(within(test.dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(writes(test)).toHaveLength(1))
  expect(JSON.parse(writes(test)[0][1]!.body as string)).toEqual({ name: 'Grace', version: 1 })
})
it('fresh runtime metadata and unchanged SHA cause zero reloads after a clean draft', async () => {
  const test = await setup('one'); await refresh(test); await act(async () => { await test.coordinator.refresh() }); test.flush()
  expectDraft(test)
  expect(test.fetcher.mock.calls.some(([path]) => path === '/build.json')).toBe(true)
  fireEvent.change(test.input, { target: { value: 'Ada' } }); test.flush()
  expect(getMutationSafetySnapshot().dirty).toBe(false); expect(test.reload).toHaveBeenCalledTimes(0)
})
it.each(['save', 'discard', 'revert'] as const)('pending deployment stays blocked through refresh until real draft %s', async finish => {
  const test = await setup('one'); test.sha('B'); await test.coordinator.refresh(); test.flush(); expect(test.reload).toHaveBeenCalledTimes(0)
  test.holdQueries(); await refresh(test); test.flush(); expectDraft(test); expect(test.reload).toHaveBeenCalledTimes(0)
  await act(async () => test.releaseQueries())
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
  test.flush(); expectDraft(test); expect(test.reload).toHaveBeenCalledTimes(0)
  if (finish === 'revert') fireEvent.change(test.input, { target: { value: 'Ada' } })
  else if (finish === 'save') { fireEvent.click(within(test.dialog).getByRole('button', { name: 'Save' })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()) }
  else { fireEvent.click(within(test.dialog).getByRole('button', { name: 'Cancel' })); fireEvent.click(await screen.findByRole('button', { name: 'Discard' })) }
  await waitFor(() => expect(getMutationSafetySnapshot()).toEqual({ dirty: false, submitting: false }))
  test.flush(); expect(test.reload).toHaveBeenCalledTimes(1)
})
it.each(['update', 'read', 'id', 'version'] as const)('detail %s revocation closes the editor immediately and late responses cannot restore it', async authority => {
  const test = await setup('one'); test.holdQueries(); await refresh(test)
  const next = fixture(3), grant = next.capabilities.entities.entries
  if (authority === 'update' || authority === 'read') grant.operations = grant.operations.filter(operation => operation !== authority)
  else grant.readable = grant.readable.filter(field => field !== authority)
  await refresh(test, next)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull(); expect(getMutationSafetySnapshot().dirty).toBe(false)
  await act(async () => test.releaseQueries())
  expect(screen.queryByRole('dialog')).toBeNull(); expect(writes(test)).toHaveLength(0)
})
it('new field masks apply during pending reads and forbidden dirty fields never enter submission', async () => {
  const test = await setup('one'), note = screen.getByRole('textbox', { name: 'Note' })
  fireEvent.change(note, { target: { value: 'Forbidden draft' } }); test.holdQueries()
  const next = fixture(2); next.capabilities.entities.entries.writable = ['name']; next.capabilities.entities.entries.readable = ['id', 'version', 'name']
  await refresh(test, next); expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull(); expectDraft(test)
  await act(async () => test.releaseQueries())
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
  fireEvent.click(within(test.dialog).getByRole('button', { name: 'Save' })); await waitFor(() => expect(writes(test)).toHaveLength(1))
  expect(JSON.parse(writes(test)[0][1]!.body as string)).toEqual({ name: 'Grace', version: 1 })
})
it('newly granted row actions stay disabled until the replacement row succeeds', async () => {
  const test = await setup('one'); test.holdQueries()
  const next = fixture(2); next.capabilities.entities.entries.operations.push('delete'); await refresh(test, next)
  const edit = screen.getByRole('button', { name: 'Edit', hidden: true }), remove = screen.getByRole('button', { name: 'Delete', hidden: true })
  expect(edit).toHaveProperty('disabled', true); expect(remove).toHaveProperty('disabled', true)
  await act(async () => test.releaseQueries())
  await waitFor(() => expect(remove).toHaveProperty('disabled', false)); expectDraft(test)
})
it.each([[403, false], [500, false], [403, true], [500, true]] as const)('runtime metadata error %s closes a detail editor (replacement pending=%s)', async (status, pending) => {
  const test = await setup('one')
  if (pending) { test.holdQueries(); await refresh(test); expectDraft(test) }
  test.deny(status)
  await act(async () => { await refreshRuntimeModel(test.client, 'org').catch(() => {}) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  expect(getMutationSafetySnapshot().dirty).toBe(false); expect(writes(test)).toHaveLength(0)
  await act(async () => test.releaseQueries()); expect(screen.queryByRole('dialog')).toBeNull()
})
it.each([403, 500, 404, 'missing'] as const)('replacement detail error %s overrides the retained seed', async status => {
  const test = await setup('one'); test.holdQueries(); await refresh(test); expectDraft(test)
  if (status === 'missing') test.missing(); else test.detailStatus(status)
  await act(async () => test.releaseQueries())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  expect(getMutationSafetySnapshot().dirty).toBe(false); expect(writes(test)).toHaveLength(0)
})
it.each([403, 500, 404, 'missing'] as const)('same-key detail refetch error %s overrides a cached row', async status => {
  const test = await setup('one'); if (status === 'missing') test.missing(); else test.detailStatus(status)
  await act(async () => { await test.client.refetchQueries({ queryKey: ['read'] }) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  expect(getMutationSafetySnapshot().dirty).toBe(false)
})
it.each(['grouped', 'membership'] as const)('initialized %s loader preserves the form when detail has already resolved', async layout => {
  const test = await setup('one', layout), kind = layout === 'grouped' ? 'edit' : 'membership'
  test.holdQueries(kind); await refresh(test, fixture(2, layout))
  await waitFor(() => expect(test.client.isFetching({ predicate: query => query.queryKey.includes(layout === 'grouped' ? 'edit-record' : 'form-memberships') })).toBeGreaterThan(0))
  expectDraft(test); expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  await act(async () => test.releaseQueries(kind))
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)); expectDraft(test)
})
it.each([
  ['grouped', 403, false], ['grouped', 500, false], ['grouped', 403, true], ['grouped', 500, true],
  ['membership', 403, false], ['membership', 500, false], ['membership', 403, true], ['membership', 500, true],
] as const)('%s loader error %s fails closed (cached=%s)', async (layout, status, cached) => {
  const test = await setup('one', layout); test.queryStatus(layout === 'grouped' ? 'edit' : 'membership', status)
  if (cached) await act(async () => { await test.client.refetchQueries({ queryKey: ['read'] }) })
  else await refresh(test, fixture(2, layout))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(getMutationSafetySnapshot().dirty).toBe(false)
})
it.each(['instance', 'organization', 'entity', 'record'] as const)('%s identity change cannot reuse the prior editor seed', async identity => {
  const test = await setup('one')
  if (identity === 'instance' || identity === 'entity') {
    const next = fixture(2)
    if (identity === 'instance') next.model.instance = 'another-instance'
    else { next.model.entities.other = next.model.entities.entries; next.capabilities.entities.other = next.capabilities.entities.entries }
    await refresh(test, next)
  }
  if (identity === 'record') test.serverRow({ id: 'two', version: 1, name: 'Ada', note: 'Original note' })
  if (identity !== 'instance') test.reroute({ orgId: identity === 'organization' ? 'other-org' : 'org', entity: identity === 'entity' ? 'other' : 'entries', id: identity === 'record' ? 'two' : 'one' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(getMutationSafetySnapshot().dirty).toBe(false)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  const input = await screen.findByRole('textbox', { name: 'Name' })
  expect(input).not.toBe(test.input); expect(input).toHaveProperty('value', 'Ada'); expect(getMutationSafetySnapshot().dirty).toBe(false)
})

it.each(['simple', 'grouped', 'membership'] as const)('explicit conflict reload still replaces the %s baseline and resets the draft', async layout => {
  const test = await setup('one', layout)
  test.serverRow({ id: 'one', version: 9, name: 'New baseline', note: 'New note' }); await refresh(test, fixture(2, layout))
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
  test.writeStatus(409); fireEvent.click(within(test.dialog).getByRole('button', { name: 'Save' }))
  await screen.findByText(en.write_version_conflict); expectDraft(test)
  expect(JSON.parse(writes(test)[0][1]!.body as string)).toEqual({ name: 'Grace', version: 1 })
  fireEvent.click(within(test.dialog).getByRole('button', { name: 'Reload and retry' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'New baseline'))
  expect(getMutationSafetySnapshot().dirty).toBe(false)
  if (layout === 'membership') await screen.findByRole('button', { name: 'Remove Tag' })
  test.writeStatus(200); fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Retried draft' } })
  fireEvent.click(within(test.dialog).getByRole('button', { name: 'Save' })); await waitFor(() => expect(writes(test)).toHaveLength(2))
  expect(JSON.parse(writes(test)[1][1]!.body as string)).toEqual({ name: 'Retried draft', version: 9 })
})
it('fresh model field restrictions override an unchanged writable grant during refresh', async () => {
  const test = await setup('one'); fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Old model draft' } })
  test.holdQueries(); const next = fixture(2); next.model.entities.entries.fields.note.readOnly = true; await refresh(test, next)
  expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull(); expectDraft(test)
  await act(async () => test.releaseQueries())
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
  fireEvent.click(within(test.dialog).getByRole('button', { name: 'Save' })); await waitFor(() => expect(writes(test)).toHaveLength(1))
  expect(JSON.parse(writes(test)[0][1]!.body as string)).toEqual({ name: 'Grace', version: 1 })
})
it('membership revocation removes its dirty control and excludes the relation from submission', async () => {
  const test = await setup('one', 'membership')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove Tag' }))
  test.holdQueries(); const next = fixture(2, 'membership'); next.capabilities.commands = []; await refresh(test, next)
  expect(screen.queryByRole('combobox', { name: 'Tags' })).toBeNull(); expectDraft(test)
  await act(async () => test.releaseQueries())
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
  fireEvent.click(within(test.dialog).getByRole('button', { name: 'Save' })); await waitFor(() => expect(writes(test)).toHaveLength(1))
  expect(JSON.parse(writes(test)[0][1]!.body as string)).toEqual({ name: 'Grace', version: 1 })
  expect(test.fetcher.mock.calls.some(([path]) => path.startsWith('/commands/'))).toBe(false)
})

it('newly granted memberships do not replace an already initialized edit form with loading UI', async () => {
  const test = await setup('one'); test.holdQueries('membership'); await refresh(test, fixture(2, 'membership'))
  await waitFor(() => expect(test.client.isFetching({ predicate: query => query.queryKey.includes('form-memberships') })).toBe(1))
  expectDraft(test); expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  await act(async () => test.releaseQueries('membership'))
  await waitFor(() => expect(within(test.dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)); expectDraft(test)
  await screen.findByRole('button', { name: 'Remove Tag' })
})
