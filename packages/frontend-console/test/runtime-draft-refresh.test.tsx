import { useCommandMutation } from '../../console-generated/src/write-screens'
import type { ReactNode } from 'react'
import userEvent from '@testing-library/user-event'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { getMutationSafetySnapshot } from '@workbasehq/ui'
import { changeSavedViews } from '@workbasehq/console-generated/saved-views'
import en from '../src/locales/en.json'
import { viewsTrigger } from './saved-views-menu'
import { ReadPage } from '../src/read'
import { adaptConsoleModel, refreshRuntimeModel } from '../src/api/runtime-model'
import { fetchCapabilities } from '../src/api/queries'
import { buildReload } from '../src/build-reload'
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ search: {}, state: {}, pathname: '/o/org/e/entries', searchStr: '' }), useNavigate: () => navigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
beforeEach(() => {
  const entries = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() { return entries.size },
  })
})
afterEach(() => { navigate.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function document(revision = 1): ConsoleModelContract {
  return {
    contractVersion: 2, console: { entities: {}, navigation: [], pages: [] },
    model: { instance: 'drafts', revision, locale: 'en', timeZone: 'UTC', limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
      entries: { displayField: 'name', fields: { id: { type: 'string' }, version: { type: 'integer' }, name: { type: 'string' } }, writeSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, columns: ['name'], relations: {}, routes: {} },
    }, commands: [], workflows: [] },
    capabilities: { revision, organization: { role: 'admin' }, entities: { entries: { operations: ['read', 'create', 'update'], readable: ['id', 'version', 'name'], writable: ['name'] } }, commands: [], resources: {}, workflows: {} },
  } as unknown as ConsoleModelContract
}
async function setup(id?: string, beforeDraft?: () => void, initial = document(), prepare?: (rows: Record<string, Record<string, any>[]>) => void, inline = false) {
  let next = initial, status = 200, writeStatus = 200
  const rows: Record<string, Record<string, any>[]> = { entries: [{ id: 'one', version: 1, name: 'Ada', note: 'Original' }], choices: [{ id: 'tag', name: 'Tag' }, { id: 'category', name: 'Category' }, { id: 'other', name: 'Other' }], tag_joins: [{ id: 'tag-join', entry: 'one', choice: 'tag' }], category_joins: [{ id: 'category-join', entry: 'one', choice: 'category' }] }
  prepare?.(rows)
  const queryStatus: Record<string, number> = {}
  const entityGates: Record<string, Promise<void> | undefined> = {}; const releases: Record<string, () => void> = {}
  const writes: { path: string; method: string; body: any }[] = []
  const queries: any[] = []
  let releaseWrites: (() => void) | undefined
  let writeGate: Promise<void> | undefined
  let releaseQueries: (() => void) | undefined
  let queryGate: Promise<void> | undefined
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['console-model', 'org'], adaptConsoleModel(next)); client.setQueryData(['capabilities', 'org'], next.capabilities)
  client.setQueryData(['organization', 'org'], { user: { id: 'verified' }, memberships: [{ organization_id: 'org' }] })
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/me?scope=organization') return Response.json(client.getQueryData(['organization', 'org']))
    if (path.endsWith('/capabilities')) return Response.json(next.capabilities)
    if (path.endsWith('/console-model')) return Response.json(status === 200 ? next : { error: 'permission_denied' }, { status })
    if (path === '/query') {
      const query = JSON.parse(String(options?.body)); queries.push(query)
      const snapshot = structuredClone(rows[query.entity] ?? [])
      const error = queryStatus[query.entity]
      await queryGate; await entityGates[query.entity]
      if (error) return Response.json({ error: 'permission_denied' }, { status: error })
      const where = query.where ?? {}
      const matching = snapshot.filter(row => Object.entries(where).every(([name, condition]: [string, any]) => !condition.eq && !condition.in || (condition.eq ? row[name] === condition.eq : condition.in.includes(row[name]))))
      const offset = Number(query.cursor ?? 0), page = matching.slice(offset, offset + query.limit)
      return Response.json({ data: page.map(row => ({ ...Object.fromEntries(query.select.filter((name: string) => Object.hasOwn(row, name)).map((name: string) => [name, row[name]])), ...(query.labels ? { __labels: { note: { status: 'ready', text: 'Tag' } } } : {}) })), next_cursor: matching.length > offset + query.limit ? String(offset + query.limit) : null })
    }
    if (path.startsWith('/api/') || path.startsWith('/commands/')) {
      const body = JSON.parse(String(options?.body ?? '{}')); writes.push({ path, method: options?.method ?? 'GET', body })
      await writeGate
      if (writeStatus !== 200) return Response.json({ error: 'version_conflict' }, { status: writeStatus })
      return Response.json({ ...rows.entries[0], ...body, version: 10 })
    }
    throw new Error(`Unexpected path ${path}`)
  }); vi.stubGlobal('fetch', fetcher)
  const refreshBuild = vi.spyOn(buildReload, 'refresh').mockResolvedValue()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_name: 'Name', field_note: 'Note', relation_tags: 'Tags', relation_categories: 'Categories', entity_choices: 'Choices', entitySingular_choices: 'Choice', entity_entries: 'Entries', entitySingular_entries: 'Entry' } } } })
  const renderPage = (orgId = 'org', entity = 'entries', record = id) => <I18nextProvider i18n={i18n}><QueryClientProvider client={client}><ReadPage orgId={orgId} entity={entity} id={record} /></QueryClientProvider></I18nextProvider>
  const view = render(renderPage())
  await screen.findByRole('heading', { name: id ? 'Ada' : 'Entries' })
  beforeDraft?.()
  fireEvent.click(screen.getByRole('button', { name: inline ? 'Edit Name' : id ? 'Edit' : 'Add Entry' }))
  const input = await screen.findByRole('textbox', { name: 'Name' }); await waitFor(() => expect(input.matches(':disabled')).toBe(false)); fireEvent.change(input, { target: { value: 'Grace' } })
  expect(getMutationSafetySnapshot().dirty).toBe(true)
  return { holdWrites: () => { writeGate = new Promise<void>(resolve => { releaseWrites = resolve }) }, releaseWrites: () => releaseWrites?.(), client, input, rows, writes, queries, queryStatus, renderPage, writeStatus: (value: number) => { writeStatus = value }, holdEntity: (entity: string) => { entityGates[entity] = new Promise(resolve => { releases[entity] = resolve }) }, releaseEntity: (entity: string) => { releases[entity]?.(); entityGates[entity] = undefined }, refreshBuild, view, fetcher, holdQueries: () => { queryGate = new Promise<void>(resolve => { releaseQueries = resolve }) }, releaseQueries: () => releaseQueries?.(), next: (value: ConsoleModelContract) => { next = value }, deny: (value: number) => { status = value }, cleanup: () => { releaseWrites?.(); releaseQueries?.(); Object.values(releases).forEach(release => release()); view.unmount(); client.clear() } }
}
it('revision-only runtime refresh retains a real registered create draft and requests a build observation', async () => {
  const test = await setup(); test.holdQueries(); test.next(document(2))
  await act(async () => { await fetchCapabilities(test.client, 'org') })
  await waitFor(() => expect(test.client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', 'org'])?.capabilities.revision).toBe(2))
  expect(test.refreshBuild).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input); expect(test.input).toHaveProperty('value', 'Grace'); expect(getMutationSafetySnapshot().dirty).toBe(true)
  test.cleanup()
})
it('revision refresh preserves the verified saved-view selection alongside a dirty create draft without auto-applying it', async () => {
  const saved = changeSavedViews({ instance: 'drafts', userId: 'verified', orgId: 'org' }, 'entries', {
    kind: 'save', name: 'Personal', state: { search: '', sort: { key: 'name', direction: 'desc' }, userFilters: [], presetFilters: [], limit: 30 },
  }).entries[0]
  const test = await setup(undefined, () => {
    // Choosing is separate from applying: open the menu and select, but never confirm.
    fireEvent.click(viewsTrigger())
    fireEvent.click(within(screen.getByRole('dialog', { name: en.savedViews })).getByRole('button', { name: 'Personal' }))
  })
  test.next(document(2))
  try {
    await act(async () => { await fetchCapabilities(test.client, 'org') })
    await waitFor(() => expect(test.client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', 'org'])?.capabilities.revision).toBe(2))
    // The modal create draft dismissed the menu; reopening it shows the same (unapplied) choice, so the refresh neither lost nor applied it.
    if (!screen.queryByRole('dialog', { name: en.savedViews, hidden: true })) fireEvent.click(viewsTrigger())
    expect(within(screen.getByRole('dialog', { name: en.savedViews, hidden: true })).getByRole('button', { name: 'Personal', hidden: true }).getAttribute('aria-pressed')).toBe('true')
    expect(saved.id).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input)
    expect(test.input).toHaveProperty('value', 'Grace'); expect(getMutationSafetySnapshot().dirty).toBe(true)
    expect(test.refreshBuild).toHaveBeenCalledTimes(1)
  } finally { test.cleanup() }
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
it('A7 revision-only runtime refresh retains a detail edit draft', async () => {
  const test = await setup('one'); const queriesBefore = test.fetcher.mock.calls.filter(([path]) => path === '/query').length; test.holdQueries(); test.next(document(2))
  try {
    await act(async () => { await fetchCapabilities(test.client, 'org') })
    await waitFor(() => expect(test.fetcher.mock.calls.filter(([path]) => path === '/query').length).toBeGreaterThan(queriesBefore))
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input); expect(test.input).toHaveProperty('value', 'Grace'); expect(getMutationSafetySnapshot().dirty).toBe(true)
  } finally {
    await act(async () => test.releaseQueries()); test.cleanup()
  }
})

function editorDocument(kind: 'text' | 'ref' | 'members', grouped = false, revision = 1, readable = true) {
  const doc = document(revision)
  const model: any = doc.model, caps: any = doc.capabilities
  model.entities.entries.fields.note = kind === 'ref' ? { type: 'ref', entity: 'choices' } : { type: 'string' }
  model.entities.entries.writeSchema.properties.note = { type: ['string', 'null'] }
  if (readable) caps.entities.entries.readable.push('note')
  if (revision > 1) caps.entities.entries.writable.push('note')
  if (grouped) model.entities.entries.detail = { groups: [{ id: 'main', label: 'Main', fields: ['name'] }] }
  if (kind === 'ref' || kind === 'members') {
    model.entities.choices = { displayField: 'name', columns: ['name'], fields: { id: { type: 'string' }, name: { type: 'string' } }, relations: {}, routes: {} }
    caps.entities.choices = { operations: ['read'], readable: ['id', 'name'], writable: [] }
  }
  if (kind === 'members') {
    for (const [name, join] of [['tags', 'tag_joins'], ['categories', 'category_joins']]) {
      model.entities[join] = { fields: { id: { type: 'string' }, entry: { type: 'ref', entity: 'entries' }, choice: { type: 'ref', entity: 'choices' } }, columns: ['entry', 'choice'], relations: {}, routes: {} }
      caps.entities[join] = { operations: ['read'], readable: ['id', 'entry', 'choice'], writable: [] }
      model.entities.entries.relations[name] = { entity: join, cardinality: '1:n', field: 'entry', through: { entity: 'choices', field: 'choice', createCommand: `${join}/create`, deleteCommand: `${join}/delete` } }
      if (name === 'tags' || revision > 1) caps.commands.push(`${join}/create`, `${join}/delete`)
    }
  }
  return doc
}
async function refreshEditor(test: Awaited<ReturnType<typeof setup>>, doc: ConsoleModelContract) {
  test.next(doc); await act(async () => { await fetchCapabilities(test.client, 'org') })
  await waitFor(() => expect(test.client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', 'org'])?.capabilities.revision).toBe(doc.capabilities.revision))
}
function editor() { return within(screen.getByRole('dialog')) }
function submitEditor() { fireEvent.submit(screen.getByRole('textbox', { name: 'Name' }).closest('form')!) }
it.each([false, true].flatMap(grouped => [false, true].map(readable => [grouped, readable] as const)))('A4 scalar late grant grouped=%s initially-readable=%s preserves draft and version 1', async (grouped, readable) => {
  const test = await setup('one', undefined, editorDocument('text', grouped, 1, readable))
  const dialog = screen.getByRole('dialog'), form = test.input.closest('form')
  test.rows.entries[0] = { id: 'one', version: 9, name: 'Replacement', note: 'Latest note' }
  test.holdQueries()
  try {
    await refreshEditor(test, editorDocument('text', grouped, 2))
    expect(screen.getByRole('dialog')).toBe(dialog); expect(test.input.closest('form')).toBe(form)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input)
    submitEditor(); await act(async () => {}); expect(test.writes).toHaveLength(0)
    await act(async () => test.releaseQueries())
    const note = await editor().findByRole('textbox', { name: 'Note' })
    await waitFor(() => expect(note).toHaveProperty('value', 'Latest note'))
    await waitFor(() => expect(editor().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
    await userEvent.setup().type(note, ' appended')
    test.rows.entries[0].note = 'Refresh must not win'
    await refreshEditor(test, editorDocument('text', grouped, 3))
    await waitFor(() => expect(editor().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
    expect(note).toHaveProperty('value', 'Latest note appended'); expect(test.input).toHaveProperty('value', 'Grace')
    submitEditor(); await waitFor(() => expect(test.writes).toHaveLength(1))
    expect(test.writes[0]).toMatchObject({ path: '/api/entries/one', method: 'PATCH', body: { name: 'Grace', note: 'Latest note appended', version: 1 } })
  } finally { test.cleanup() }
})
it.each([false, true].flatMap(grouped => [false, true].flatMap(readable => ['clear', 'replace'].map(action => [grouped, readable, action] as const))))('A1 reference late grant grouped=%s initially-readable=%s seeds real value and %s', async (grouped, readable, action) => {
  const test = await setup('one', undefined, editorDocument('ref', grouped, 1, readable)); const user = userEvent.setup()
  test.rows.entries[0].note = 'tag'; test.rows.entries[0].version = 9; test.holdQueries()
  try {
    await refreshEditor(test, editorDocument('ref', grouped, 2))
    submitEditor(); await act(async () => {}); expect(test.writes).toHaveLength(0)
    await act(async () => test.releaseQueries())
    const note = await editor().findByRole('combobox', { name: 'Note' })
    await waitFor(() => expect(note).toHaveProperty('value', 'Tag'))
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input); expect(test.input).toHaveProperty('value', 'Grace')
    fireEvent.change(test.input, { target: { value: 'Ada' } })
    await waitFor(() => expect(getMutationSafetySnapshot().dirty).toBe(false))
    fireEvent.change(test.input, { target: { value: 'Grace' } })
    if (action === 'clear') await user.click(editor().getByRole('button', { name: /clear|remove/i }))
    else {
      await user.click(note); await user.click(await within(await screen.findByRole('listbox', { name: 'Note' })).findByRole('option', { name: 'Other' }))
      await refreshEditor(test, editorDocument('ref', grouped, 3))
      await waitFor(() => expect(note).toHaveProperty('value', 'Other'))
      await waitFor(() => expect(editor().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
    }
    submitEditor(); await waitFor(() => expect(test.writes).toHaveLength(1))
    expect(test.writes[0].body).toEqual({ name: 'Grace', note: action === 'clear' ? null : 'other', version: 1 })
  } finally { test.cleanup() }
})
it.each([false, true])('A2/A3 membership late grant grouped=%s preserves complete sets and dirty removals', async grouped => {
  const test = await setup('one', undefined, editorDocument('members', grouped)); const user = userEvent.setup()
  try {
    await user.click(await editor().findByRole('button', { name: 'Remove Tag' }))
    test.holdEntity('category_joins')
    await refreshEditor(test, editorDocument('members', grouped, 2))
    submitEditor(); await act(async () => {}); expect(test.writes).toHaveLength(0)
    expect(test.input).toHaveProperty('value', 'Grace')
    await act(async () => test.releaseEntity('category_joins'))
    await editor().findByRole('button', { name: 'Remove Category' })
    expect(editor().queryByRole('button', { name: 'Remove Tag' })).toBeNull()
    const picker = editor().getByRole('combobox', { name: 'Categories' })
    await user.click(picker); await user.click(await within(await screen.findByRole('listbox', { name: 'Categories' })).findByRole('option', { name: 'Other' }))
    submitEditor(); await waitFor(() => expect(test.writes.some(write => write.path === '/commands/category_joins/create')).toBe(true))
    expect(test.writes.filter(write => write.path.startsWith('/commands/'))).toEqual([
      { path: '/commands/tag_joins/delete', method: 'POST', body: { id: 'tag-join' } },
      { path: '/commands/category_joins/create', method: 'POST', body: { entry: 'one', choice: 'other' } },
    ])
    expect(test.writes.some(write => write.body.id === 'category-join')).toBe(false)
  } finally { test.cleanup() }
})

it.each([false, true])('A2 membership remove/re-add in either control returns mutation safety clean (multiple=%s)', async multiple => {
  const test = await setup('one', undefined, editorDocument('members'), rows => {
    if (multiple) {
      rows.category_joins.push({ id: 'category-other', entry: 'one', choice: 'other' })
      rows.tag_joins.push({ id: 'tag-other', entry: 'one', choice: 'other' })
    }
  }); const user = userEvent.setup()
  try {
    await refreshEditor(test, editorDocument('members', false, 2))
    await editor().findByRole('button', { name: 'Remove Category' })
    // Both initially enabled and newly granted fields use set equality and real RHF defaults.
    for (const [label, first] of [['Tags', 'Tag'], ['Categories', 'Category']]) {
      const field = editor().getByRole('combobox', { name: label }).closest('[data-write-field]')!
      const controls = within(field as HTMLElement)
      await user.click(controls.getByRole('button', { name: `Remove ${first}` }))
      if (multiple) await user.click(controls.getByRole('button', { name: 'Remove Other' }))
      for (const name of multiple ? ['Other', first] : [first]) {
        await user.click(controls.getByRole('combobox', { name: label }))
        await user.click(await within(await screen.findByRole('listbox', { name: label })).findByRole('option', { name }))
      }
    }
    fireEvent.change(test.input, { target: { value: 'Ada' } })
    await waitFor(() => expect(getMutationSafetySnapshot().dirty).toBe(false))
    expect(editor().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    expect(test.writes).toHaveLength(0)
  } finally { test.cleanup() }
})
it.each(['empty', 'paginated', 'incomplete', 'error'] as const)('A3 complete membership read: %s', async mode => {
  const doc = editorDocument('members'); (doc.model.limits as any).root = 1
  const test = await setup('one', undefined, doc)
  if (mode === 'empty') test.rows.category_joins = []
  if (mode === 'paginated') test.rows.category_joins.push({ id: 'category-other', entry: 'one', choice: 'other' })
  if (mode === 'incomplete') test.rows.category_joins[0] = { id: 'bad', entry: 'one' }
  if (mode === 'error') test.queryStatus.category_joins = 500
  const next = editorDocument('members', false, 2); (next.model.limits as any).root = 1
  try {
    const oldForm = test.input.closest('form')!
    await refreshEditor(test, next)
    if (mode === 'incomplete' || mode === 'error') {
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
      fireEvent.submit(oldForm); await act(async () => {}); expect(test.writes).toHaveLength(0)
    } else {
      await waitFor(() => expect(editor().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
      if (mode === 'empty') expect(editor().queryByRole('button', { name: 'Remove Category' })).toBeNull()
      else {
        await editor().findByRole('button', { name: 'Remove Category' }); await editor().findByRole('button', { name: 'Remove Other' })
        expect(test.queries.some(query => query.entity === 'category_joins' && query.cursor === '1')).toBe(true)
      }
      submitEditor(); await waitFor(() => expect(test.writes).toHaveLength(1))
      expect(test.writes[0].body).toEqual({ name: 'Grace', version: 1 })
    }
  } finally { test.cleanup() }
})
it.each(['simple', 'grouped', 'members'] as const)('A8 %s failed/empty detail reads override retained drafts', async host => {
  for (const failure of [403, 500, 404, 'empty'] as const) {
    const doc = editorDocument(host === 'members' ? 'members' : 'text', host === 'grouped')
    const test = await setup('one', undefined, doc)
    const form = test.input.closest('form')!
    try {
      if (failure === 'empty') test.rows.entries = []
      else test.queryStatus.entries = failure
      await refreshEditor(test, editorDocument(host === 'members' ? 'members' : 'text', host === 'grouped', 2))
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
      fireEvent.submit(form); fireEvent.keyDown(test.input, { key: 'Enter' }); await act(async () => {})
      expect(test.writes).toHaveLength(0)
    } finally { test.cleanup() }
  }
})
it.each(['model', 'operation', 'id', 'version', 'field', 'relation'] as const)('A8 live %s revocation cannot leak retained fields or authorize obsolete success', async mask => {
  const test = await setup('one', undefined, editorDocument('members'))
  const form = test.input.closest('form')!
  try {
    test.holdQueries(); await refreshEditor(test, editorDocument('members', false, 2))
    const revoked = editorDocument('members', false, 3)
    if (mask === 'model') delete revoked.model.entities.entries
    if (mask === 'operation') revoked.capabilities.entities.entries.operations = ['read']
    if (mask === 'id' || mask === 'version') revoked.capabilities.entities.entries.readable = revoked.capabilities.entities.entries.readable.filter(name => name !== mask)
    if (mask === 'field') revoked.capabilities.entities.entries.writable = ['note']
    if (mask === 'relation') revoked.capabilities.commands = ['category_joins/create', 'category_joins/delete']
    await refreshEditor(test, revoked)
    fireEvent.submit(form); await act(async () => {}); expect(test.writes).toHaveLength(0)
    await act(async () => test.releaseQueries())
    if (['model', 'operation', 'id', 'version'].includes(mask)) {
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    } else {
      await waitFor(() => expect(editor().queryByRole('button', { name: 'Save' })).toBeTruthy())
      if (mask === 'field') {
        expect(editor().queryByRole('textbox', { name: 'Name' })).toBeNull()
        const note = editor().getByRole('textbox', { name: 'Note' }); await waitFor(() => expect(note.matches(':disabled')).toBe(false))
        fireEvent.change(note, { target: { value: 'Allowed' } }); fireEvent.submit(note.closest('form')!)
        await waitFor(() => expect(test.writes).toHaveLength(1)); expect(test.writes[0].body).toEqual({ note: 'Allowed', version: 1 })
      } else expect(editor().queryByRole('combobox', { name: 'Tags' })).toBeNull()
    }
  } finally { test.cleanup() }
})
it('A6 a selected readable field absent from a successful response blocks authoritative submission', async () => {
  const test = await setup('one', undefined, editorDocument('text'))
  const form = test.input.closest('form')!
  delete test.rows.entries[0].note
  try {
    await refreshEditor(test, editorDocument('text', false, 2))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
    fireEvent.submit(form); await act(async () => {}); expect(test.writes).toHaveLength(0)
  } finally { test.cleanup() }
})
it('A9 only explicit conflict Reload replaces the concurrency baseline and field generation', async () => {
  const test = await setup('one', undefined, editorDocument('text'))
  try {
    test.rows.entries[0] = { id: 'one', version: 9, name: 'Fresh', note: 'Fresh note' }
    await refreshEditor(test, editorDocument('text', false, 2))
    await waitFor(() => expect(editor().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
    test.writeStatus(409); submitEditor()
    await editor().findByRole('button', { name: 'Reload and retry' })
    expect(test.writes[0].body.version).toBe(1)
    test.writeStatus(200); fireEvent.click(editor().getByRole('button', { name: 'Reload and retry' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Fresh'))
    expect(getMutationSafetySnapshot().dirty).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Fresh draft' } })
    submitEditor(); await waitFor(() => expect(test.writes).toHaveLength(2)); expect(test.writes[1].body).toEqual({ name: 'Fresh draft', version: 9 })
  } finally { test.cleanup() }
})
it.each(['actor', 'instance', 'org', 'entity', 'record'] as const)('A9 %s replacement discards the previous identity draft', async identity => {
  const test = await setup('one')
  try {
    if (identity === 'actor') await act(async () => { test.client.setQueryData(['organization', 'org'], { user: { id: 'other' }, memberships: [{ organization_id: 'org' }] }) })
    else if (identity === 'instance') { const doc = document(2); doc.model.instance = 'other'; await refreshEditor(test, doc) }
    else if (identity === 'org') {
      test.client.setQueryData(['console-model', 'other'], adaptConsoleModel(document())); test.client.setQueryData(['organization', 'other'], { user: { id: 'verified' }, memberships: [{ organization_id: 'other' }] })
      test.view.rerender(test.renderPage('other'))
    } else if (identity === 'entity') {
      const doc = document(2); doc.model.entities.other = structuredClone(doc.model.entities.entries); doc.capabilities.entities.other = structuredClone(doc.capabilities.entities.entries); test.rows.other = [{ id: 'one', name: 'Ada', version: 1 }]
      await refreshEditor(test, doc); test.view.rerender(test.renderPage('org', 'other'))
    } else { test.rows.entries.push({ id: 'two', name: 'Ada', version: 1 }); test.view.rerender(test.renderPage('org', 'entries', 'two')) }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(getMutationSafetySnapshot().dirty).toBe(false); expect(test.writes).toHaveLength(0)
  } finally { test.cleanup() }
})

it('A7/A8 inline editor retains DOM and dirty state and blocks Enter during replacement reads', async () => {
  const doc = document(); (doc.model.entities.entries as any).detail = { inlineEdit: true, fields: ['name'] }
  const test = await setup('one', undefined, doc, undefined, true)
  try {
    test.holdQueries(); const next = structuredClone(doc); next.model.revision = 2; next.capabilities.revision = 2
    await refreshEditor(test, next)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input); expect(test.input).toHaveProperty('value', 'Grace')
    fireEvent.keyDown(test.input, { key: 'Enter' }); await act(async () => {}); expect(test.writes).toHaveLength(0)
    await act(async () => test.releaseQueries())
    await waitFor(() => expect(test.input.matches(':disabled')).toBe(false)); expect(getMutationSafetySnapshot().dirty).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(test.input)
    fireEvent.keyDown(test.input, { key: 'Enter' }); await waitFor(() => expect(test.writes).toHaveLength(1))
    expect(test.writes[0].body).toEqual({ name: 'Grace', version: 1 })
  } finally { test.cleanup() }
})
it('A8 field reauthorization restores the same-session draft and its first default', async () => {
  const doc = editorDocument('text', false, 2)
  const test = await setup('one', undefined, doc)
  try {
    const note = editor().getByRole('textbox', { name: 'Note' }); fireEvent.change(note, { target: { value: 'Private draft' } })
    const revoke = editorDocument('text', false, 3); revoke.capabilities.entities.entries.writable = ['name']
    await refreshEditor(test, revoke)
    expect(editor().queryByRole('textbox', { name: 'Note' })).toBeNull()
    test.rows.entries[0].note = 'Replacement'; await refreshEditor(test, editorDocument('text', false, 4))
    await waitFor(() => expect(editor().getByRole('textbox', { name: 'Note' })).toHaveProperty('value', 'Private draft'))
    fireEvent.change(editor().getByRole('textbox', { name: 'Note' }), { target: { value: 'Original' } })
    fireEvent.change(test.input, { target: { value: 'Ada' } })
    await waitFor(() => expect(getMutationSafetySnapshot().dirty).toBe(false))
  } finally { test.cleanup() }
})

it('A8 direct command mutation rejects the current read guard', async () => {
  const client = new QueryClient(), write = vi.fn(), controls = { close: vi.fn(), submissionKey: 'key' }
  let mutation: ReturnType<typeof useCommandMutation>
  function Probe({ blocked }: { blocked: boolean }) { mutation = useCommandMutation({ write, readBlocked: blocked }, 'entries/update', controls); return null }
  const view = render(<QueryClientProvider client={client}><Probe blocked={false} /></QueryClientProvider>)
  view.rerender(<QueryClientProvider client={client}><Probe blocked /></QueryClientProvider>)
  await act(async () => { await expect(mutation!.mutateAsync({ name: 'Stale' })).rejects.toMatchObject({ code: 'action_unavailable' }) })
  expect(write).not.toHaveBeenCalled(); view.unmount(); client.clear()
})

it.each([false, true])('A6 generated write-only field keeps unknown semantics (edited=%s)', async edited => {
  const test = await setup('one', undefined, editorDocument('text', false, 1, false))
  try {
    await refreshEditor(test, editorDocument('text', false, 2, false))
    const note = await editor().findByRole('textbox', { name: 'Note' }); await waitFor(() => expect(note.matches(':disabled')).toBe(false))
    expect(note).toHaveProperty('value', '')
    if (edited) fireEvent.change(note, { target: { value: 'Unknown draft' } })
    test.rows.entries[0].note = 'Latest authorized'; await refreshEditor(test, editorDocument('text', false, 3))
    await waitFor(() => expect(note).toHaveProperty('value', edited ? 'Unknown draft' : 'Latest authorized'))
    await waitFor(() => expect(editor().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false))
    submitEditor(); await waitFor(() => expect(test.writes).toHaveLength(1))
    expect(test.writes[0].body).toEqual({ name: 'Grace', ...(edited ? { note: 'Unknown draft' } : {}), version: 1 })
  } finally { test.cleanup() }
})

it.each(['command', 'relation'] as const)('A8 %s revocation during a membership diff read blocks later join commands', async mask => {
  const test = await setup('one', undefined, editorDocument('members')); const user = userEvent.setup()
  try {
    await user.click(await editor().findByRole('button', { name: 'Remove Tag' }))
    // Revert the scalar so that the pending operation is exclusively a membership diff.
    fireEvent.change(test.input, { target: { value: 'Ada' } }); test.holdEntity('tag_joins')
    const before = test.queries.filter(query => query.entity === 'tag_joins').length
    submitEditor(); await waitFor(() => expect(test.queries.filter(query => query.entity === 'tag_joins').length).toBeGreaterThan(before))
    const revoked = editorDocument('members', false, 2)
    if (mask === 'command') revoked.capabilities.commands = []
    else revoked.capabilities.entities.choices.operations = []
    await refreshEditor(test, revoked)
    await act(async () => test.releaseEntity('tag_joins'))
    await waitFor(() => expect(test.client.isMutating()).toBe(0))
    expect(test.writes).toHaveLength(0)
  } finally { test.cleanup() }
})

// Port of review wr-ffb38ad8's real generated inline PATCH probe.
it('A7 in-flight inline save keeps deployment blocked after editor revocation until settlement', async () => {
  const doc = document(); (doc.model.entities.entries as any).detail = { inlineEdit: true, fields: ['name'] }
  const test = await setup('one', undefined, doc, undefined, true)
  test.holdWrites()
  try {
    fireEvent.keyDown(test.input, { key: 'Enter' })
    await waitFor(() => expect(test.writes).toHaveLength(1))
    expect(test.writes[0]).toEqual({ path: '/api/entries/one', method: 'PATCH', body: { name: 'Grace', version: 1 } })
    expect(getMutationSafetySnapshot().submitting).toBe(true)
    const next = structuredClone(doc); next.model.revision = 2; next.capabilities.revision = 2; next.capabilities.entities.entries.operations = ['read']
    await refreshEditor(test, next)
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
    expect(getMutationSafetySnapshot().submitting).toBe(true)
    await act(async () => test.releaseWrites())
    await waitFor(() => expect(test.client.isMutating()).toBe(0))
    await waitFor(() => expect(getMutationSafetySnapshot().submitting).toBe(false))
  } finally { await act(async () => test.releaseWrites()); test.cleanup() }
})
