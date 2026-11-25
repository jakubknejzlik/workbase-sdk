import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import { GeneratedActions, GeneratedRowActions } from '../../console-generated/src/write-screens'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { readQuery, type Model, type Capabilities, type ReadQuery } from '../../console-generated/src/read'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, ...props }: { children: ReactNode; to: string; params?: unknown }) => <a {...props} href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/o/org/e/entries', search: {}, state: {} }),
}))

async function accessMenu(state: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`${state}, ${en.rowAccessActions}`) })
  await userEvent.setup().click(trigger)
  return screen.getByRole('menu')
}
async function chooseAccessAction(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(en.rowAccessActions) }))
  await user.click(screen.getByRole('menuitem', { name: label }))
}

type Layout = 'default' | 'fields' | 'groups' | 'separate'
function fixture(layout: Layout = 'default') {
  const fields = { id: { type: 'string' }, name: { type: 'string' }, user: { type: 'ref', entity: 'accounts' }, reviewer: { type: 'ref', entity: 'accounts' } }
  const relations = { user_account: { entity: 'accounts', field: 'user', cardinality: 'n:1' }, alias: { entity: 'accounts', field: 'user', cardinality: 'n:1' }, reviewer_account: { entity: 'accounts', field: 'reviewer', cardinality: 'n:1' } }
  const detail = ['default', 'separate'].includes(layout) ? undefined : layout === 'fields' ? { fields: ['name', 'user', 'reviewer'], relations: { user_account: { columns: ['name'] }, alias: { columns: ['name'] }, reviewer_account: { columns: ['name'] } } }
    : { summary: ['user'], groups: [{ id: 'main', label: 'Information', fields: ['name', 'user', 'reviewer'] }], relations: { user_account: { columns: ['name'] }, alias: { columns: ['name'] }, reviewer_account: { columns: ['name'] } }, sections: [{ row: ['info', 'user_account', 'alias'] }] }
  const model = { instance: 'neutral', revision: 1, limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
    entries: { accountLink: { field: 'user', entity: 'accounts' }, rowAccess: true, rowInvitations: true, displayField: 'name', fields, columns: Object.keys(fields), relations, detail, routes: { list: '', detail: '' } },
    accounts: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
  } } as unknown as Model
  if (layout === 'separate') model.limits.exists = 1
  model.commands = ['link_account', 'remove_access'].map(action => ({ name: `entries/${action}`, permission: { entity: 'entries', operation: 'update' }, inputSchema: { type: 'object', properties: { rowId: { type: 'string', referenceEntity: 'entries' } }, required: ['rowId'] } }))
  const caps = { resources: { 'invitations.read': true, 'members.read': true }, revision: 1, commands: ['entries/remove_access', 'entries/link_account'], entities: Object.fromEntries(Object.entries(model.entities).map(([name, entity]) => [name, { operations: ['read'], readable: Object.keys(entity.fields), writable: [] }])) } as Capabilities
  return { model, caps }
}
async function mount(options: { recordActions?: boolean; accessRead?: boolean; list?: boolean; layout?: Layout; status?: Record<string, unknown>; error?: number; loading?: boolean; available?: boolean; transport?: boolean; manage?: boolean; commands?: string[]; searchLinkAccount?: boolean; membersRead?: boolean } = {}) {
  const { model, caps } = fixture(options.layout)
  if (options.accessRead !== undefined) caps.resources!['invitations.read'] = options.accessRead
  if (options.searchLinkAccount !== undefined) caps.resources!['members.search_link_account'] = options.searchLinkAccount
  if (options.membersRead !== undefined) caps.resources!['members.read'] = options.membersRead
  Object.assign(model.entities.entries, { rowAccess: options.available ?? true, rowInvitations: options.manage ?? true })
  if (options.manage === false) caps.commands = []
  if (options.commands) caps.commands = options.commands
  if (options.recordActions) caps.entities.entries.operations.push('delete')
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_user: 'Raw User', relation_user_account: 'Raw User account', relation_alias: 'Raw account alias', field_reviewer: 'Reviewer', relation_reviewer_account: 'Reviewer account', field_name: 'Name' } } } })
  const write = vi.fn(async (_path: string, _method: string, _body?: unknown, _key?: string) => {
    if (_path.endsWith('/members?eligible=link_account&target_entity=entries&target_row=entry')) return { data: [{ user_id: 'account', display_name: 'Workspace member' }] }
    if (options.loading) return new Promise<never>(() => {})
    if (options.error) throw { status: options.error }
    return options.status ?? { state: 'no_account', can_invite: false, can_cancel: false, inconsistency: null }
  })
  const request = vi.fn(async (query: ReadQuery) => ({ data: query.entity === 'entries' ? [{ id: 'entry', name: 'Neutral entry', user: 'account', reviewer: 'reviewer', user_account: { id: 'account', name: 'Raw account' }, alias: { id: 'account', name: 'Raw account' }, reviewer_account: { id: 'reviewer', name: 'Review person' } }] : [{ id: 'reviewer', name: 'Review person' }], next_cursor: null }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" id={options.list ? undefined : "entry"} rowActions={(row, disabled) => <GeneratedRowActions model={model} caps={caps} orgId="org" entity="entries" request={request} write={write} row={row} disabled={disabled} />} request={request} write={options.transport === false ? undefined : write} actions={row => <GeneratedActions model={model} caps={caps} orgId="org" entity="entries" request={request} write={write} row={row} />} /></QueryClientProvider></I18nextProvider>)
  if (!options.list) await screen.findByRole('heading', { name: 'Neutral entry' })
  return { write, request, client }
}

it.each(['default', 'fields', 'groups', 'separate'] as const)('one access card suppresses generic link fields and all matching aliases in %s detail', async layout => {
  const { request } = await mount({ layout })
  await accessMenu('No access')
  expect(screen.getAllByText('Application access')).toHaveLength(1)
  expect(screen.queryByText('Raw User')).toBeNull()
  expect(screen.queryByText('Raw User account')).toBeNull()
  expect(screen.queryByText('Raw account alias')).toBeNull()
  expect(screen.queryByText('Raw account')).toBeNull()
  expect(screen.getAllByText(/Review/).length).toBeGreaterThan(0)
  const root = request.mock.calls.find(([query]) => query.entity === 'entries')![0]
  expect(root.select).not.toContain('user')
  expect(root.labels ?? []).not.toContain('user')
  expect(root.include).not.toHaveProperty('user_account')
  expect(root.include).not.toHaveProperty('alias')
})
it('detail suppression preserves generic edit projection and authorization metadata', () => {
  const { model, caps } = fixture()
  const before = JSON.stringify({ model, caps })
  expect(readQuery(model, 'entries', caps, { id: 'entry', purpose: 'edit' }).select).toContain('user')
  expect(readQuery(model, 'entries', caps, { id: 'entry' }).select).not.toContain('user')
  expect(JSON.stringify({ model, caps })).toBe(before)
})
it('authorized linked account appears once inside the shared access card', async () => {
  await mount({ status: { state: 'signed_in', can_invite: false, can_cancel: false, inconsistency: null, linked_accounts: [{ id: 'account', label: 'Authorized account' }] } })
  expect(await screen.findByText('Authorized account')).toBeTruthy()
  await accessMenu('Linked account')
  expect(screen.getAllByText('Linked account')).toHaveLength(1)
})
it('policy-hidden linked identity preserves signed-in status and authorized account actions', async () => {
  await mount({ status: { state: 'signed_in', can_invite: true, can_cancel: true, inconsistency: null, linked_accounts: [] } })
  await accessMenu('Linked account')
  expect(screen.queryAllByRole('menuitem', { name: 'Link account' })).toHaveLength(0)
  expect(screen.getAllByRole('menuitem', { name: 'Remove access' })).toHaveLength(1)
  expect(screen.queryByText('Raw account')).toBeNull()
  expect(screen.queryByText('Access status denied')).toBeNull()
})
it.each(['link_account', 'remove_access'])('unavailable status preserves the authorized %s command without an invitation read', async action => {
  const { write } = await mount({ available: false, manage: false, commands: ['entries/link_account', 'entries/remove_access'] })
  await accessMenu('Access status unavailable')
  expect(screen.getAllByRole('menuitem', { name: 'Link account' })).toHaveLength(1)
  expect(screen.getAllByRole('menuitem', { name: 'Remove access' })).toHaveLength(1)
  expect(write).not.toHaveBeenCalled()
  const user = userEvent.setup()
  const label = action === 'link_account' ? 'Link account' : 'Remove access'
  await user.click(screen.getByRole('menuitem', { name: label }))
  if (action === 'link_account') { const field = await screen.findByRole('combobox', { name: 'Member' }); await waitFor(() => expect(field).not.toHaveProperty('disabled', true)); await user.click(field); await user.click(await screen.findByRole('option', { name: 'Workspace member' })) }
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: label }))
  await waitFor(() => expect(write).toHaveBeenCalledWith(`/commands/entries/${action}`, 'POST', { rowId: 'entry', ...(action === 'link_account' ? { userId: 'account' } : {}), idempotencyKey: expect.any(String) }))
  expect(write.mock.calls.every(([path, method]) => method !== 'GET' || path === '/orgs/org/members?eligible=link_account&target_entity=entries&target_row=entry')).toBe(true)
})
it.each(['no_account', 'invited', 'expired', 'signed_in'])('available %s status offers each authorized account command exactly once', async state => {
  await mount({ status: { state, can_invite: true, can_cancel: true, inconsistency: null,
    ...(['invited', 'expired'].includes(state) ? { invitation: { id: 'pending', email: 'one@example.test' } } : {}) } })
  await accessMenu({ no_account: 'No access', invited: 'Invitation sent', expired: 'Invitation expired', signed_in: 'Linked account' }[state]!)
  expect(screen.queryAllByRole('menuitem', { name: state === 'signed_in' ? 'Link account' : state === 'invited' ? en.rowChangeMemberOrEmail : en.rowFindMember })).toHaveLength(state === 'signed_in' ? 0 : 1)
  expect(screen.getAllByRole('menuitem', { name: 'Remove access' })).toHaveLength(1)
  const card = screen.getByText('Application access').closest('[data-application-access]') as HTMLElement
  expect(within(card).getByRole('button', { name: /Application access actions/ })).toBeTruthy()
})
it.each([false, true])('account commands remain individually capability gated with status available=%s', async available => {
  await mount({ available, manage: available, commands: ['entries/link_account'], status: { state: 'signed_in', can_invite: false, can_cancel: false, inconsistency: null } })
  await accessMenu(available ? 'Linked account' : 'Access status unavailable')
  expect(screen.queryAllByRole('menuitem', { name: 'Link account' })).toHaveLength(available ? 0 : 1)
  expect(screen.queryByRole('menuitem', { name: 'Remove access' })).toBeNull()
})
it.each([false, true])('no account command is exposed without a grant with status available=%s', async available => {
  const { write } = await mount({ available, manage: available, commands: [], status: { state: 'signed_in', can_invite: false, can_cancel: false, inconsistency: null } })
  if (available) await accessMenu('Linked account')
  else await screen.findByText('Access status unavailable')
  expect(screen.queryByRole('menuitem', { name: 'Link account' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Remove access' })).toBeNull()
  if (!available) expect(write).not.toHaveBeenCalled()
})
it.each(['explicit', 'array'])('multiple linked accounts (%s) warn and disable all account actions', async source => {
  const { write } = await mount({ status: { state: 'signed_in', can_invite: true, can_cancel: true, inconsistency: source === 'explicit' ? 'multiple_linked_accounts' : null, linked_accounts: source === 'array' ? [{ id: 'a', label: 'First account' }, { id: 'b', label: 'Second account' }] : [] } })
  expect((await screen.findByRole('alert')).textContent).toContain('Multiple linked accounts')
  expect(screen.queryByRole('menuitem', { name: 'Remove access' })).toBeNull()
  const trigger = screen.getByRole('button', { name: `${source === 'array' ? 'First account' : '–'} – ${en.rowAccessMultiple}, ${en.rowAccessActions}` })
  expect(trigger).toHaveProperty('disabled', true)
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  expect(screen.queryByRole('menuitem', { name: 'Link account' })).toBeNull()
})
it('background status refresh preserves the open invitation draft and disables submission until settled', async () => {
  const status = { state: 'no_account', can_invite: true, can_cancel: false, inconsistency: null }
  const { write, client } = await mount({ status })
  const user = userEvent.setup()
  await chooseAccessAction(user, 'Find member or invite')
  const dialog = screen.getByRole('dialog')
  const email = within(dialog).getByRole('combobox', { name: 'Name or email' }) as HTMLInputElement
  const submit = within(dialog).getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement
  await user.type(email, 'draft@example.test')
  await waitFor(() => expect(submit.disabled).toBe(false))
  let settle!: (value: typeof status) => void
  write.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  let refresh!: Promise<void>
  await act(async () => { refresh = client.invalidateQueries({ queryKey: ['row-access'] }) })
  await waitFor(() => expect(client.isFetching({ queryKey: ['row-access'] })).toBe(1))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(email.value).toBe('draft@example.test')
  await waitFor(() => expect(submit.disabled).toBe(true))
  await user.click(submit)
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  await act(async () => { settle(status); await refresh })
  await waitFor(() => expect(submit.disabled).toBe(false))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(within(dialog).getByRole('combobox', { name: 'Name or email' })).toBe(email)
  expect(email.value).toBe('draft@example.test')
  await user.click(submit)
  await waitFor(() => expect(write).toHaveBeenCalledWith('/orgs/org/invitations', 'POST', { email: 'draft@example.test', target: { entity: 'entries', row: 'entry' } }))
})
it.each(['explicit', 'array'])('background status refresh retains the %s multiple-account guard until reconciliation', async source => {
  const status = { state: 'signed_in', can_invite: true, can_cancel: true,
    inconsistency: source === 'explicit' ? 'multiple_linked_accounts' : null,
    linked_accounts: source === 'array' ? [{ id: 'a' }, { id: 'b' }] : [] }
  const { write, client } = await mount({ status })
  await screen.findByRole('alert')
  const expectGuard = () => {
    expect(screen.getByRole('alert').textContent).toContain('Multiple linked accounts')
    expect(screen.queryByRole('menuitem', { name: 'Link account' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Remove access' })).toBeNull()
  }
  expectGuard()
  let settle!: (value: Record<string, unknown>) => void
  write.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  let refresh!: Promise<void>
  await act(async () => { refresh = client.invalidateQueries({ queryKey: ['row-access'] }) })
  await waitFor(() => expect(client.isFetching({ queryKey: ['row-access'] })).toBe(1))
  expectGuard()
  await act(async () => { settle(status); await refresh })
  await waitFor(() => expect(client.isFetching({ queryKey: ['row-access'] })).toBe(0))
  expectGuard()
  write.mockResolvedValueOnce({ state: 'no_account', can_invite: true, can_cancel: false, inconsistency: null })
  await act(async () => { await client.invalidateQueries({ queryKey: ['row-access'] }) })
  await accessMenu('No access')
  expect(screen.getAllByRole('menuitem', { name: 'Find member or invite' })).toHaveLength(1)
  expect(screen.getAllByRole('menuitem', { name: 'Remove access' })).toHaveLength(1)
})
it.each([403, 404, 500])('status error %s never becomes no access', async error => {
  await mount({ error })
  await screen.findByRole('alert')
  expect(screen.queryByText('No access')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Find member or invite' })).toBeNull()
})
it('loading never becomes no access', async () => {
  await mount({ loading: true })
  expect(screen.getByRole('status').textContent).toContain('Loading')
  expect(screen.queryByText('No access')).toBeNull()
})
it.each([{ available: false }, { transport: false }])('unavailable access retains one read-only card: %o', async options => {
  const { write } = await mount(options)
  expect(screen.getAllByText('Application access')).toHaveLength(1)
  if (options.transport === false) expect(screen.getByText('Access status unavailable')).toBeTruthy()
  else await accessMenu('Access status unavailable')
  expect(screen.queryByText('No access')).toBeNull()
  expect(write).not.toHaveBeenCalled()
})
it.each(['invited', 'expired', 'signed_in'])('status-only %s reveals no identity or actions', async state => {
  await mount({ manage: false, status: { state, can_invite: false, can_cancel: false, inconsistency: null } })
  await accessMenu({ invited: 'Invitation sent', expired: 'Invitation expired', signed_in: 'Linked account' }[state]!)
  expect(screen.queryByRole('menuitem', { name: 'Find member or invite' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Remove access' })).toBeNull()
})

it.each([403, 404, 500])('failed refresh (%s) replaces cached status and closes the invitation dialog', async error => {
  const { write, client } = await mount({ status: { state: 'no_account', can_invite: true, can_cancel: false, inconsistency: null } })
  await accessMenu('No access')
  const user = userEvent.setup()
  await user.click(screen.getByRole('menuitem', { name: 'Find member or invite' }))
  await user.type(screen.getByRole('combobox', { name: 'Name or email' }), 'draft@example.test')
  write.mockRejectedValueOnce({ status: error })
  await act(async () => { await client.invalidateQueries({ queryKey: ['row-access'] }) })
  expect((await screen.findByRole('alert')).textContent).toContain(error === 403 ? en.rowAccessDenied : error === 404 ? en.rowAccessUnavailable : en.requestFailed)
  expect(screen.queryByText('No access')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Find member or invite' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Link account' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Remove access' })).toBeNull()
})
it('unknown status is a failure, never an access grant or no-access fallback', async () => {
  await mount({ status: { state: 'unknown', can_invite: true, inconsistency: null } })
  await screen.findByRole('alert')
  expect(screen.queryByText('No access')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Find member or invite' })).toBeNull()
})

it.each(['no_account', 'invited', 'expired', 'signed_in'])('178 search capability offers the unified action only before linking: %s', async state => {
  const { write } = await mount({ searchLinkAccount: true, status: { state, can_invite: true, can_cancel: true, inconsistency: null,
    ...(['invited', 'expired'].includes(state) ? { invitation: { id: 'pending', email: 'one@example.test' } } : {}) } })
  await accessMenu({ no_account: 'No access', invited: 'Invitation sent', expired: 'Invitation expired', signed_in: 'Linked account' }[state]!)
  expect(screen.queryAllByRole('menuitem', { name: state === 'invited' ? en.rowChangeMemberOrEmail : en.rowFindMember })).toHaveLength(state === 'signed_in' ? 0 : 1)
  expect(screen.getAllByRole('menuitem', { name: 'Remove access' })).toHaveLength(1)
  expect(screen.queryByRole('menuitem', { name: 'Link account' })).toBeNull()
  expect(write.mock.calls.some(([path]) => path.includes('/members?'))).toBe(false)
})

it.each([{ searchLinkAccount: false }, { membersRead: false }])('120 legacy compatibility never overrides an explicit capability denial: %j', async options => {
  const { write } = await mount(options)
  await accessMenu('No access')
  expect(screen.queryByRole('menuitem', { name: 'Link account' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Find member or invite' })).toBeNull()
  expect(screen.getAllByRole('menuitem', { name: 'Remove access' })).toHaveLength(1)
  expect(write.mock.calls.some(([path]) => path.includes('/members?'))).toBe(false)
})

it.each([403, 404, 500])('120 failed refresh (%s) closes the shared search dialog', async error => {
  const { write, client } = await mount({ searchLinkAccount: true })
  const user = userEvent.setup()
  await chooseAccessAction(user, 'Find member or invite')
  expect(screen.getByRole('dialog')).toBeTruthy()
  write.mockRejectedValueOnce({ status: error })
  await act(async () => { await client.invalidateQueries({ queryKey: ['row-access'] }) })
  expect((await screen.findByRole('alert')).textContent).toContain(error === 403 ? en.rowAccessDenied : error === 404 ? en.rowAccessUnavailable : en.requestFailed)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Find member or invite' })).toBeNull()
})

it.each([false, true])('178 staff without invitations.read hides access in list=%s and makes no status request', async list => {
  const { write } = await mount({ accessRead: false, list })
  await screen.findAllByText('Neutral entry')
  expect(screen.queryByText(en.rowAccess)).toBeNull()
  expect(screen.queryByText(en.rowAccessUnavailable)).toBeNull()
  expect(screen.queryByRole('columnheader', { name: en.rowAccess })).toBeNull()
  expect(write).not.toHaveBeenCalled()
})

it('209 generated list gives record and access controls distinct visible and accessible names', async () => {
  await mount({ list: true, recordActions: true, status: { state: 'invited', can_invite: true, can_cancel: true, invitation: { id: 'pending', email: 'one@example.test' }, inconsistency: null } })
  const access = await screen.findByRole('button', { name: /one@example.test – Invitation sent, Application access actions/ })
  expect(access.closest('td')!.textContent).toBe('one@example.test')
  const record = screen.getByRole('button', { name: 'Actions for Neutral entry' })
  expect(record.textContent).toBe('')
  expect(record.querySelector('svg.lucide-ellipsis[aria-hidden="true"]')).toBeTruthy()
  await userEvent.setup().click(record)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Delete'])
})

it.each(['comfortable', 'compact'])('315 A1 %s list cells, access control and all headers share measured typography', async density => {
  await mount({ list: true, recordActions: true, status: { state: 'invited', can_invite: true, can_cancel: true, invitation: { id: 'pending', email: 'alex@example.test' }, inconsistency: null } })
  const access = await screen.findByRole('button', { name: /alex@example.test.*Application access actions/ })
  const table = screen.getByRole('table')
  table.closest('[data-list-density]')!.setAttribute('data-list-density', density)
  const style = document.createElement('style')
  style.textContent = readFileSync(`${import.meta.dirname}/../src/styles.css`, 'utf8')
  document.head.append(style)
  try {
    // A1 keeps the measured 12px / 17.76px typography in both densities.
    const headers = screen.getAllByRole('columnheader')
    expect(headers.some(header => header.querySelector('button'))).toBe(true)
    expect(headers.some(header => !header.querySelector('button'))).toBe(true)
    for (const element of [table, ...screen.getAllByRole('cell'), access, ...headers, ...headers.flatMap(header => Array.from(header.querySelectorAll('button')))]) {
      expect(getComputedStyle(element)).toMatchObject({ fontSize: '12px', lineHeight: '17.76px' })
    }
  } finally { style.remove() }
})

it('209 list preserves separately authorized account actions when invitation status is unavailable', async () => {
  await mount({ list: true, available: false, manage: false, commands: ['entries/link_account', 'entries/remove_access'] })
  await userEvent.setup().click(await screen.findByRole('button', { name: /Access status unavailable, Application access actions/ }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Link account', 'Remove access'])
  expect(screen.getByRole('menu').textContent).toContain(en.rowAccessUnavailable)
  expect(screen.getByRole('menu').querySelector('[data-slot="dropdown-menu-label"] [aria-hidden="true"]')).toBeTruthy()
})
it.each([[true, true], [true, false], [false, true], [false, false]])('209 list independently gates record=%s and access=%s controls', async (recordActions, accessRead) => {
  const { write } = await mount({ list: true, recordActions, accessRead, commands: [] })
  await screen.findByRole('link', { name: 'Neutral entry' })
  if (accessRead) await screen.findByRole('button', { name: /No access, Application access actions/ })
  expect(screen.queryAllByRole('button', { name: /Application access actions/ })).toHaveLength(accessRead ? 1 : 0)
  expect(screen.queryAllByRole('button', { name: /[Aa]ctions for Neutral entry/ })).toHaveLength(recordActions ? 1 : 0)
  if (!accessRead) expect(write).not.toHaveBeenCalled()
})
