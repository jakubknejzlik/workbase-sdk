import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import { GeneratedActions } from '../../console-generated/src/write-screens'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { readQuery, type Model, type Capabilities, type ReadQuery } from '../../console-generated/src/read'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, ...props }: { children: ReactNode; to: string; params?: unknown }) => <a {...props} href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

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
  const caps = { revision: 1, commands: ['entries/remove_access', 'entries/link_account'], entities: Object.fromEntries(Object.entries(model.entities).map(([name, entity]) => [name, { operations: ['read'], readable: Object.keys(entity.fields), writable: [] }])) } as Capabilities
  return { model, caps }
}
async function mount(options: { layout?: Layout; status?: Record<string, unknown>; error?: number; loading?: boolean; available?: boolean; transport?: boolean; manage?: boolean; commands?: string[] } = {}) {
  const { model, caps } = fixture(options.layout)
  Object.assign(model.entities.entries, { rowAccess: options.available ?? true, rowInvitations: options.manage ?? true })
  if (options.manage === false) caps.commands = []
  if (options.commands) caps.commands = options.commands
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_user: 'Raw User', relation_user_account: 'Raw User account', relation_alias: 'Raw account alias', field_reviewer: 'Reviewer', relation_reviewer_account: 'Reviewer account', field_name: 'Name' } } } })
  const write = vi.fn(async (_path: string, _method: string, _body?: unknown, _key?: string) => {
    if (options.loading) return new Promise<never>(() => {})
    if (options.error) throw { status: options.error }
    return options.status ?? { state: 'no_account', can_invite: false, can_cancel: false, inconsistency: null }
  })
  const request = vi.fn(async (query: ReadQuery) => ({ data: query.entity === 'entries' ? [{ id: 'entry', name: 'Neutral entry', user: 'account', reviewer: 'reviewer', user_account: { id: 'account', name: 'Raw account' }, alias: { id: 'account', name: 'Raw account' }, reviewer_account: { id: 'reviewer', name: 'Review person' } }] : [{ id: 'reviewer', name: 'Review person' }], next_cursor: null }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" id="entry" request={request} write={options.transport === false ? undefined : write} actions={row => <GeneratedActions model={model} caps={caps} orgId="org" entity="entries" request={request} write={write} row={row} />} /></QueryClientProvider></I18nextProvider>)
  await screen.findByRole('heading', { name: 'Neutral entry' })
  return { write, request, client }
}

it.each(['default', 'fields', 'groups', 'separate'] as const)('one access card suppresses generic link fields and all matching aliases in %s detail', async layout => {
  const { request } = await mount({ layout })
  await screen.findByText('No access')
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
  expect(screen.getAllByText('Signed in')).toHaveLength(1)
})
it.each(['link_account', 'remove_access'])('unavailable status preserves the authorized %s command without an invitation read', async action => {
  const { write } = await mount({ available: false, manage: false, commands: ['entries/link_account', 'entries/remove_access'] })
  expect(screen.getByText('Access status unavailable')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Link account' })).toHaveLength(1)
  expect(screen.getAllByRole('button', { name: 'Remove access' })).toHaveLength(1)
  expect(write).not.toHaveBeenCalled()
  const user = userEvent.setup()
  const label = action === 'link_account' ? 'Link account' : 'Remove access'
  await user.click(screen.getByRole('button', { name: label }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: label }))
  await waitFor(() => expect(write).toHaveBeenCalledWith(`/commands/entries/${action}`, 'POST', { rowId: 'entry', idempotencyKey: expect.any(String) }))
  expect(write.mock.calls.every(([, method]) => method !== 'GET')).toBe(true)
})
it.each(['no_account', 'invited', 'expired', 'signed_in'])('available %s status offers each authorized account command exactly once', async state => {
  await mount({ status: { state, can_invite: true, can_cancel: true, inconsistency: null,
    ...(['invited', 'expired'].includes(state) ? { invitation: { id: 'pending', email: 'one@example.test' } } : {}) } })
  await screen.findByText({ no_account: 'No access', invited: 'Invited', expired: 'Expired', signed_in: 'Signed in' }[state]!)
  expect(screen.getAllByRole('button', { name: 'Link account' })).toHaveLength(1)
  expect(screen.getAllByRole('button', { name: 'Remove access' })).toHaveLength(1)
  const card = screen.getByText('Application access').closest('[data-application-access]') as HTMLElement
  expect(within(card).queryAllByRole('button', { name: 'Remove access' })).toHaveLength(state === 'signed_in' ? 1 : 0)
})
it.each([false, true])('account commands remain individually capability gated with status available=%s', async available => {
  await mount({ available, manage: available, commands: ['entries/link_account'], status: { state: 'signed_in', can_invite: false, can_cancel: false, inconsistency: null } })
  await screen.findByText(available ? 'Signed in' : 'Access status unavailable')
  expect(screen.getAllByRole('button', { name: 'Link account' })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Remove access' })).toBeNull()
})
it.each([false, true])('no account command is exposed without a grant with status available=%s', async available => {
  const { write } = await mount({ available, manage: available, commands: [], status: { state: 'signed_in', can_invite: false, can_cancel: false, inconsistency: null } })
  await screen.findByText(available ? 'Signed in' : 'Access status unavailable')
  expect(screen.queryByRole('button', { name: 'Link account' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove access' })).toBeNull()
  if (!available) expect(write).not.toHaveBeenCalled()
})
it.each(['explicit', 'array'])('multiple linked accounts (%s) warn and disable all account actions', async source => {
  await mount({ status: { state: 'signed_in', can_invite: true, can_cancel: true, inconsistency: source === 'explicit' ? 'multiple_linked_accounts' : null, linked_accounts: source === 'array' ? [{ id: 'a', label: 'First account' }, { id: 'b', label: 'Second account' }] : [] } })
  expect((await screen.findByRole('alert')).textContent).toContain('Multiple linked accounts')
  expect(screen.queryByRole('button', { name: 'Remove access' })).toBeNull()
  expect(screen.queryByText('First account')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Link account' })).toBeNull()
})
it.each([403, 404, 500])('status error %s never becomes no access', async error => {
  await mount({ error })
  await screen.findByRole('alert')
  expect(screen.queryByText('No access')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Invite to application' })).toBeNull()
})
it('loading never becomes no access', async () => {
  await mount({ loading: true })
  expect(screen.getByRole('status').textContent).toContain('Loading')
  expect(screen.queryByText('No access')).toBeNull()
})
it.each([{ available: false }, { transport: false }])('unavailable access retains one read-only card: %o', async options => {
  const { write } = await mount(options)
  expect(screen.getAllByText('Application access')).toHaveLength(1)
  expect(screen.getByText('Access status unavailable')).toBeTruthy()
  expect(screen.queryByText('No access')).toBeNull()
  expect(write).not.toHaveBeenCalled()
})
it.each(['invited', 'expired', 'signed_in'])('status-only %s reveals no identity or actions', async state => {
  await mount({ manage: false, status: { state, can_invite: false, can_cancel: false, inconsistency: null } })
  await waitFor(() => expect(screen.getByText({ invited: 'Invited', expired: 'Expired', signed_in: 'Signed in' }[state]!)).toBeTruthy())
  expect(screen.queryByRole('button', { name: 'Invite to application' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove access' })).toBeNull()
})

it('failed refresh replaces a previously loaded no-access status', async () => {
  const { write, client } = await mount()
  await screen.findByText('No access')
  write.mockRejectedValueOnce({ status: 500 })
  await client.invalidateQueries({ queryKey: ['row-access'] })
  await screen.findByRole('alert')
  expect(screen.queryByText('No access')).toBeNull()
})
it('unknown status is a failure, never an access grant or no-access fallback', async () => {
  await mount({ status: { state: 'unknown', can_invite: true, inconsistency: null } })
  await screen.findByRole('alert')
  expect(screen.queryByText('No access')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Invite to application' })).toBeNull()
})
