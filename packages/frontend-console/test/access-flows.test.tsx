import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
import { ApplicationAccessCard, GeneratedActions, GeneratedCreateDialog, GeneratedRowActions } from '../../console-generated/src/write-screens'
import type { Model, Capabilities } from '../../console-generated/src/read'
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
const family = ['link_account', 'remove_access', 'access_invite', 'access_cancel_invite', 'access_link_account', 'access_unlink_account']
async function mount(surface: 'detail' | 'menu' | 'create' | 'edit', options: { admin?: boolean; labels?: Record<string, string>; language?: 'en' | 'cs'; linkConflict?: boolean; noMembers?: boolean; deferMutation?: boolean; membersRead?: boolean; membersFailure?: boolean; state?: string; grouped?: boolean; unavailable?: boolean; denial?: boolean; inconsistency?: string | null; accounts?: object[]; failure?: boolean; uncertainInvite?: boolean; deliveryFailure?: boolean; contact?: 'contact_email' | 'hidden'; grants?: string[]; v3?: boolean; loading?: boolean; error?: boolean; mutationDenied?: boolean } = {}) {
  const v3 = options.v3 !== false
  const model = { instance: 'neutral', limits: { root: 100, relations: 10 }, entities: { entries: { accountLink: { field: 'user', entity: 'accounts' }, rowAccess: !options.unavailable, rowInvitations: !options.unavailable, fields: { id: { type: 'string' }, version: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' } }, writeSchema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } }, columns: ['name', 'email'], relations: {}, routes: {} } }, commands: family.filter(n => v3 || !n.startsWith('access_')).map(name => ({ name: `entries/${name}`, permission: { entity: 'entries', operation: 'update' }, inputSchema: { type: 'object', properties: { rowId: { type: 'string', referenceEntity: 'entries' } }, required: ['rowId'] } })) } as unknown as Model
  const caps = { resources: { 'members.read': options.membersRead !== false, 'members.search_link_account': options.admin !== false && options.membersRead !== false }, revision: 1, commands: (options.grants ?? family).map(n => `entries/${n}`), entities: { entries: { operations: ['read', 'create', 'update'], readable: ['id', 'version', 'name', 'email'], writable: ['name', 'email'] } } } as Capabilities
  const row = { id: 'one', version: 1, name: 'Original', email: 'contact@example.test' }
  let current = options.state ?? 'no_account', version = 1, failed = false
  const statusBlock = options.loading, statusError = options.error
  const status = () => ({ state: current, can_invite: true, can_cancel: true, inconsistency: options.inconsistency ?? null, linked_accounts: options.accounts, ...(['invited', 'expired'].includes(current) ? { invitation: { id: 'pending', email: 'invited@example.test' } } : {}) })
  const write = vi.fn(async (path: string, method: string, body?: any, _key?: string): Promise<any> => {
    if (method === 'GET') {
      if (path.includes('/members?eligible=link_account')) { if (options.membersFailure) throw { status: 403 }; return { data: options.noMembers ? [] : [...(!failed ? [{ user_id: 'account', display_name: 'Workspace member', email: 'member@example.test' }] : []), ...(options.linkConflict ? [{ user_id: 'free', display_name: 'Free member', email: 'free@example.test' }] : [])].filter(member => (new URL(path, 'http://localhost').searchParams.get('q') ?? '').toLowerCase().split(/\s+/).every(token => `${member.display_name} ${member.email}`.toLowerCase().includes(token))) } }
      if (statusBlock) return new Promise(() => {})
      if (statusError) throw { status: 500 }
      if (path.endsWith('/delivery')) return { delivery: { status: options.deliveryFailure ? 'failed' : 'queued' } }
      if (path.startsWith('/api/')) { const s = status(); return { ...row, version, ...(options.unavailable ? {} : { access: { ...s, state: s.state === 'signed_in' ? 'linked' : s.state } }), actions: { invite: { enabled: current === 'no_account' || current === 'expired' }, cancel_invite: { enabled: current === 'invited' }, link_account: { enabled: current !== 'signed_in' }, unlink_account: { enabled: current === 'signed_in' } } } }
      return status()
    }
    if (path === '/api/entries') return { ...row, ...body, id: 'created', version }
    if (path === '/api/entries/one' || path === '/api/entries/created') return { ...row, ...body, version: ++version }
    if (options.linkConflict && (body?.user_id === 'account' || body?.userId === 'account')) { failed = true; throw { status: 409, code: 'account_already_linked' } }
    if (options.mutationDenied) throw { status: 403 }
    if (options.denial) throw { status: 403 }
    if (options.failure && !failed) { failed = true; throw { status: 500 } }
    current = path.endsWith('cancel_invite') || path.endsWith('unlink_account') || method === 'DELETE' ? 'no_account' : path.endsWith('link_account') ? 'signed_in' : 'invited'
    version++
    if (options.uncertainInvite && !failed && path.endsWith('/invite')) { failed = true; throw { status: 500 } }
    return options.deliveryFailure ? { delivery: { status: 'failed' } } : {}
  })
  const request = vi.fn(async () => ({ data: [{ ...row, version }], next_cursor: null }))
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: options.language ?? 'en', resources: { en: { translation: { ...en, field_name: 'Name', field_email: 'Contact email', ...options.labels } }, cs: { translation: { ...cs, ...options.labels } } } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false, ...(options.deferMutation ? { onMutate: async () => { await new Promise(resolve => setTimeout(resolve, 10)) } } : {}) } } })
  if (options.contact === 'hidden') caps.entities.entries.readable = caps.entities.entries.readable.filter(name => name !== 'email')
  if (options.contact === 'contact_email') { const entity = model.entities.entries; entity.fields.contact_email = entity.fields.email; delete entity.fields.email; entity.columns = ['name', 'contact_email']; entity.writeSchema!.properties.contact_email = entity.writeSchema!.properties.email; delete entity.writeSchema!.properties.email; caps.entities.entries.readable.push('contact_email'); caps.entities.entries.writable.push('contact_email') }
  if (options.grouped) model.entities.entries.detail = { groups: [{ id: 'main', label: 'Main', fields: ['name', 'email'] }] }
  const onDenied = vi.fn()
  const props = { model, caps, onDenied, orgId: 'org', entity: 'entries', write, request }
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}>{surface === 'create' ? <GeneratedCreateDialog {...props} open onOpenChange={vi.fn()} /> : surface === 'menu' ? <><ApplicationAccessCard {...props} row={row} /><GeneratedRowActions {...props} row={row} /></> : <>{surface === 'detail' && <ApplicationAccessCard {...props} row={row} />}<GeneratedActions {...props} row={row} /></>}</QueryClientProvider></I18nextProvider>)
  const user = userEvent.setup()
  if (surface === 'edit') await user.click(screen.getByRole('button', { name: 'Edit' }))
  return { write, request, user, client, onDenied }
}
it.each(['detail', 'menu'] as const)('review5 V3 %s removes every generic account action', async surface => {
  const { user, write } = await mount(surface)
  await screen.findByText('No access')
  expect(screen.queryByRole('button', { name: 'Access invite' })).toBeNull()
  if (surface === 'menu') { await user.click(screen.getByRole('button', { name: /Actions for/ })); expect(screen.queryByRole('menuitem', { name: /account|access|invite/i })).toBeNull() }
  expect(write.mock.calls.every(([path]) => !path.startsWith('/commands/'))).toBe(true)
})
it.each(['explicit', 'array'] as const)('review5 menu suppresses legacy mutations for %s inconsistency', async source => {
  const { user } = await mount('menu', { v3: false, state: 'signed_in', inconsistency: source === 'explicit' ? 'multiple_linked_accounts' : null, accounts: source === 'array' ? [{ id: 'a' }, { id: 'b' }] : [] })
  await screen.findByRole('alert'); await user.click(screen.getByRole('button', { name: /Actions for/ }))
  expect(screen.queryByRole('menuitem', { name: 'Link account' })).toBeNull()
})
it('review5 create offers opt-in Invite now with live contact prefill', async () => {
  const { user } = await mount('create')
  await user.click(screen.getByRole('checkbox', { name: 'Invite now' }))
  expect((screen.getByLabelText('Invitation email') as HTMLInputElement).value).toBe('')
  await user.type(screen.getByLabelText('Contact email'), 'live@example.test')
  expect((screen.getByLabelText('Invitation email') as HTMLInputElement).value).toBe('live@example.test')
})
for (const language of ['en', 'cs'] as const) for (const v3 of [true, false]) {
  it(`${language} ${v3 ? 'V3' : 'legacy'} create shows a localized invitation email error and preserves the draft`, async () => {
    const locale = language === 'cs' ? cs : en
    const message = language === 'cs' ? 'Zadejte platnou e-mailovou adresu.' : 'Enter a valid email address.'
    expect(locale).toHaveProperty('rowInviteEmailInvalid', message)
    const { user, write, request } = await mount('create', { language, v3 })
    await user.type(screen.getByLabelText(locale.field_name), 'Draft name')
    await user.click(screen.getByRole('checkbox', { name: locale.rowInviteNow }))
    const email = screen.getByLabelText(locale.rowInviteEmail)
    await user.type(email, 'bad@invalid')
    await user.click(screen.getByRole('button', { name: locale.create }))
    const error = await screen.findByRole('alert')
    expect(error.textContent).toBe(message)
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(email.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)
    const item = email.closest('[data-slot="form-item"]')!
    expect(item.querySelector('[data-slot="form-label"]')?.textContent).toBe(locale.rowInviteEmail)
    expect(item.querySelector('[data-slot="form-control"]')).toBe(email)
    expect(item.querySelector('[data-slot="form-message"]')).toBe(error)
    expect(screen.queryByText(locale.requestFailed)).toBeNull()
    expect(screen.getByLabelText(locale.field_name)).toHaveProperty('value', 'Draft name')
    expect(email).toHaveProperty('value', 'bad@invalid')
    expect(write).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    await user.clear(email)
    await user.type(email, 'valid@example.test')
    expect(screen.queryByText(message)).toBeNull()
    await user.click(screen.getByRole('button', { name: locale.create }))
    await waitFor(() => expect(write.mock.calls.some(([path, method]) => path === '/api/entries' && method === 'POST')).toBe(true))
    expect(write.mock.calls.filter(([path, method]) => path === '/api/entries' && method === 'POST')).toHaveLength(1)
  })
}
for (const language of ['en', 'cs'] as const) {
  it(`${language} create uses a localized record title when the entity has no translation`, async () => {
    await mount('create', { language, labels: { entity_entries: 'Worker' } })
    expect(screen.getByRole('dialog', { name: language === 'cs' ? 'Přidat záznam' : 'Add record' })).toBeTruthy()
  })
  it(`${language} create preserves the translated object form of the entity`, async () => {
    const name = language === 'cs' ? 'pracovníka' : 'person'
    await mount('create', { language, labels: { entityObject_entries: name, entitySingular_entries: 'Worker' } })
    expect(screen.getByRole('dialog', { name: language === 'cs' ? 'Přidat pracovníka' : 'Add person' })).toBeTruthy()
  })
  for (const v3 of [true, false]) it(`${language} ${v3 ? 'V3' : 'legacy'} link explains immediate access and keeps invitation copy in invite`, async () => {
    const locale = language === 'cs' ? cs : en
    const { user } = await mount('detail', { language, v3 })
    await user.click(await screen.findByRole('button', { name: locale.rowFindMember }))
    let dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(locale.rowFindDescription)).toBeTruthy()
    expect(within(dialog).getByText(locale.rowLinkPickerHint)).toBeTruthy()
    expect(within(dialog).queryByText(locale.rowInviteDescription)).toBeNull()
    await user.type(within(dialog).getByRole('combobox', { name: locale.rowFindQuery }), 'new@example.test')
    expect(await within(dialog).findByRole('button', { name: locale.rowFindSend })).toBeTruthy()
    expect(within(dialog).getByText(locale.rowInviteDescription)).toBeTruthy()
  })
}
it('review5 edit embeds invitation controls', async () => { await mount('edit'); expect(await screen.findByRole('button', { name: 'Find member or invite' })).toBeTruthy() })

it.each([true, false])('91 edit search preserves the live contact email until explicit invitation confirmation (v3=%s)', async v3 => {
  const { user, write } = await mount('edit', { v3, noMembers: true })
  const contact = screen.getByLabelText('Contact email')
  await user.clear(contact)
  await user.type(contact, 'live@example.test')
  await user.click(await screen.findByRole('button', { name: en.rowFindMember }))
  const dialog = screen.getByRole('dialog', { name: en.rowFindMember })
  const input = within(dialog).getByRole('combobox', { name: en.rowFindQuery })
  expect(input).toHaveProperty('value', 'live@example.test')
  const confirm = await within(dialog).findByRole('button', { name: en.rowFindSend })
  await user.tab()
  await user.click(input)
  expect(input).toHaveProperty('value', 'live@example.test')
  expect(write).toHaveBeenCalledWith('/orgs/org/members?eligible=link_account&target_entity=entries&target_row=one&q=live%40example.test', 'GET')
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  await user.click(confirm)
  await waitFor(() => expect(write).toHaveBeenCalledWith(
    v3 ? '/api/entries/one/actions/invite' : '/orgs/org/invitations', 'POST',
    v3 ? { email: 'live@example.test' } : { email: 'live@example.test', target: { entity: 'entries', row: 'one' } },
  ))
  expect(write.mock.calls.filter(([, method]) => method !== 'GET')).toHaveLength(1)
  expect(contact).toHaveProperty('value', 'live@example.test')
})

async function confirmAction(user: ReturnType<typeof userEvent.setup>, label: string, input?: [string, string]) {
  await waitFor(() => expect(screen.queryByText(en.loading)).toBeNull())
  const find = ['Invite to application', 'Link account'].includes(label) ? screen.queryByRole('button', { name: 'Find member or invite' }) : null
  let button = find ?? screen.queryByRole('button', { name: label })
  if (!button) {
    await user.click(await screen.findByRole('button', { name: 'Invitation actions' }))
    button = await screen.findByRole('menuitem', { name: label })
  }
  await user.click(button)
  const dialog = screen.getAllByRole('dialog').at(-1)!
  if (find) {
    const field = within(dialog).getByRole('combobox', { name: 'Name or email' })
    await user.clear(field)
    await user.type(field, label === 'Link account' ? 'Workspace' : input![1])
    if (label === 'Link account') await user.click(await screen.findByRole('option', { name: 'Workspace member · member@example.test' }))
    await user.click(await within(dialog).findByRole('button', { name: label === 'Link account' ? label : 'Send invitation' }))
  } else {
    if (input) { const field = await within(dialog).findByLabelText(input[0]); await user.clear(field); await user.type(field, input[1]) }
    await user.click(within(dialog).getByRole('button', { name: label }))
  }
}
it.each(['detail', 'menu', 'edit'] as const)('V3 dedicated invite/link/unlink/cancel succeed on %s without generic commands', async surface => {
  const { user, write } = await mount(surface)
  await confirmAction(user, 'Invite to application', ['Email', 'recipient@example.test'])
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/invite', 'POST', { email: 'recipient@example.test' }))
  await confirmAction(user, 'Cancel invitation')
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/cancel_invite', 'POST', {}))
  await confirmAction(user, 'Link account', ['Member', 'account'])
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/link_account', 'POST', { user_id: 'account' }))
  await confirmAction(user, 'Remove access')
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/unlink_account', 'POST', {}))
  expect(write.mock.calls.some(([path]) => path.startsWith('/commands/'))).toBe(false)
})
const mutationNames = /^(Find member or invite|Send invitation|Invite to application|Link account|Remove access|Cancel invitation|Resend|Change invitation email|Retry invitation)$/
function expectNoEnabledAccess() { expect(screen.queryAllByRole('button', { name: mutationNames }).filter(button => !(button as HTMLButtonElement).disabled)).toHaveLength(0) }
for (const v3 of [true, false]) for (const surface of ['detail', 'menu', 'edit', 'create'] as const) {
  it.each(['explicit', 'array', 'inconsistent', 'unknown', 'error', 'loading'] as const)(`${v3 ? 'V3' : 'legacy'} ${surface} guards %s status on every control`, async state => {
    const { user, write } = await mount(surface, { v3, state: state === 'unknown' ? 'unknown' : 'no_account', inconsistency: state === 'explicit' ? 'multiple_linked_accounts' : state === 'inconsistent' ? 'inconsistent' : null, accounts: state === 'array' ? [{ id: 'a' }, { id: 'b' }] : [], loading: state === 'loading', error: state === 'error' })
    if (surface === 'create') {
      await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'invite@example.test')
      await user.click(screen.getByRole('button', { name: 'Create' }))
      await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries', 'POST', expect.anything(), expect.any(String)))
    }
    if (state === 'loading') await screen.findByText(en.loading)
    else if (state === 'explicit' || state === 'array') await screen.findByText(en.rowAccessMultiple)
    else await screen.findAllByRole('alert')
    expectNoEnabledAccess()
    if (surface === 'menu') { await user.click(screen.getByRole('button', { name: /Actions for/ })); expect(screen.queryByRole('menuitem', { name: /account|access|invite/i })).toBeNull() }
    expect(write.mock.calls.some(([path, method]) => method !== 'GET' && path !== '/api/entries')).toBe(false)
  })
  it(`${v3 ? 'V3' : 'legacy'} ${surface} blocks during cached refetch after a change`, async () => {
    const { user, client, write } = await mount(surface, { v3, failure: surface === 'create' })
    if (surface === 'create') {
      await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'invite@example.test'); await user.click(screen.getByRole('button', { name: 'Create' })); await screen.findByText(en.rowInviteSavedFailed)
    } else await screen.findByText('No access')
    let finish!: (data: any) => void
    write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = client.invalidateQueries({ queryKey: ['row-access'] }) })
    await waitFor(() => expect(client.isFetching({ queryKey: ['row-access'] })).toBe(1))
    expectNoEnabledAccess()
    expect(screen.queryByText(en.loading)).toBeNull()
    await act(async () => { finish(v3 ? { id: 'one', access: { state: 'no_account' }, actions: { invite: { enabled: true } } } : { state: 'no_account', can_invite: true, can_cancel: true, inconsistency: null }); await pending })
  })
}
it.each([false, true])('create invite failure=%s retains saved ID and retries without another row', async failure => {
  const { user, write } = await mount('create', { failure })
  await user.type(screen.getByLabelText('Contact email'), 'contact@example.test')
  await user.click(screen.getByRole('checkbox', { name: 'Invite now' }))
  expect((screen.getByLabelText('Invitation email') as HTMLInputElement).value).toBe('contact@example.test')
  await user.clear(screen.getByLabelText('Invitation email')); await user.type(screen.getByLabelText('Invitation email'), 'manual@example.test')
  await user.clear(screen.getByLabelText('Contact email')); await user.type(screen.getByLabelText('Contact email'), 'changed@example.test')
  expect((screen.getByLabelText('Invitation email') as HTMLInputElement).value).toBe('manual@example.test')
  await user.click(screen.getByRole('button', { name: 'Create' }))
  if (failure) { await screen.findByText(en.rowInviteSavedFailed); const retry = await screen.findByRole('button', { name: 'Retry invitation' }); await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false)); await user.click(retry) }
  await waitFor(() => expect(write.mock.calls.filter(([path, method]) => path.endsWith('/actions/invite') && method === 'POST')).toHaveLength(failure ? 2 : 1))
  expect(write.mock.calls.filter(([path, method]) => path === '/api/entries' && method === 'POST')).toHaveLength(1)
  expect(write).toHaveBeenCalledWith('/api/entries/created/actions/invite', 'POST', { email: 'manual@example.test' })
  expect(write).toHaveBeenCalledWith('/api/entries', 'POST', { email: 'changed@example.test' }, expect.any(String))
})
it('create without opt-in saves only the entity', async () => {
  const { user, write } = await mount('create'); await user.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(write).toHaveBeenCalledTimes(1)); expect(write.mock.calls[0][0]).toBe('/api/entries')
})
it.each(['Invite to application', 'Cancel invitation', 'Change invitation email', 'Resend', 'Remove access'] as const)('edit preserves unsaved fields and reconciles version after %s', async label => {
  const state = ['Cancel invitation', 'Change invitation email', 'Resend'].includes(label) ? 'invited' : label === 'Remove access' ? 'signed_in' : 'no_account'
  const { user, write, request } = await mount('edit', { state })
  await user.clear(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'Unsaved draft')
  await confirmAction(user, label, ['Invite to application', 'Change invitation email'].includes(label) ? ['Email', 'replacement@example.test'] : undefined)
  await waitFor(() => expect(request).toHaveBeenCalled())
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved draft')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one', 'PATCH', { name: 'Unsaved draft', version: label === 'Change invitation email' ? 3 : 2 }, undefined))
})
it.each(['access_link_account', 'access_unlink_account'] as const)('V3 explicit %s is individually gated and lives inside the shared card', async grant => {
  await mount('detail', { grants: [grant], state: grant === 'access_unlink_account' ? 'signed_in' : 'no_account' }); await screen.findByText(grant === 'access_unlink_account' ? 'Signed in' : 'No access')
  const label = grant === 'access_link_account' ? 'Find member or invite' : 'Remove access'
  expect(screen.getAllByRole('button', { name: label })).toHaveLength(1)
  const card = screen.getByText('Application access').closest('[data-application-access]') as HTMLElement
  expect(within(card).getByRole('button', { name: label })).toBeTruthy()
  expect(screen.queryByRole('button', { name: grant === 'access_link_account' ? 'Remove access' : 'Link account' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Invite to application' })).toBeNull()
})
it('create reconciles a lost invitation response before retry and never invites twice', async () => {
  const { user, write } = await mount('create', { uncertainInvite: true })
  await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'recipient@example.test'); await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByText(en.rowInviteSavedFailed); await screen.findByText('Invited')
  await user.click(screen.getByRole('button', { name: 'Retry invitation' }))
  await waitFor(() => expect(screen.queryByText(en.rowInviteSavedFailed)).toBeNull())
  expect(write.mock.calls.filter(([path, method]) => path.endsWith('/actions/invite') && method === 'POST')).toHaveLength(1)
  expect(write.mock.calls.filter(([path, method]) => path === '/api/entries' && method === 'POST')).toHaveLength(1)
})
it('authorized contact_email is the fallback prefill convention', async () => {
  const { user } = await mount('create', { contact: 'contact_email' }); await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('field_contact_email'), 'fallback@example.test'); expect((screen.getByLabelText('Invitation email') as HTMLInputElement).value).toBe('fallback@example.test')
})
it('prefill never copies an unreadable contact field', async () => {
  const { user } = await mount('edit', { contact: 'hidden', membersRead: false }); await user.click(await screen.findByRole('button', { name: 'Invite to application' })); expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('')
})
it('create and detail omit invitation controls without the matching V3 grant', async () => {
  await mount('create', { grants: ['access_link_account'] }); expect(screen.queryByRole('checkbox', { name: 'Invite now' })).toBeNull()
})
it('created invitation with failed delivery remains visible and never creates another invitation', async () => {
  const { user, write } = await mount('create', { v3: false, deliveryFailure: true })
  await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'recipient@example.test'); await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByText('Invited'); await screen.findAllByText(en.rowInviteDeliveryFailed)
  expect(screen.queryByText(en.rowInviteSavedFailed)).toBeNull()
  expect(screen.getByRole('button', { name: 'Resend' })).toBeTruthy()
  expect(write.mock.calls.filter(([path, method]) => path === '/orgs/org/invitations' && method === 'POST')).toHaveLength(1)
})
it.each(['detail', 'edit', 'create'] as const)('%s invitation denial preserves the existing denial callback', async surface => {
  const { user, onDenied } = await mount(surface, { mutationDenied: true })
  if (surface === 'create') {
    await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'recipient@example.test'); await user.click(screen.getByRole('button', { name: 'Create' }))
  } else await confirmAction(user, 'Invite to application', ['Email', 'recipient@example.test'])
  await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1))
})
it('edit blocks entity save after failed version reconciliation and retries without losing the draft', async () => {
  const { user, request, write } = await mount('edit')
  request.mockRejectedValueOnce({ status: 500 })
  await user.type(screen.getByLabelText('Name'), ' draft')
  await confirmAction(user, 'Invite to application', ['Email', 'recipient@example.test'])
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true))
  await user.click(screen.getByRole('button', { name: 'Reload and retry' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Original draft')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one', 'PATCH', { name: 'Original draft', version: 2 }, undefined))
})
it.each(['detail', 'edit', 'create'] as const)('%s preserves invitation denial handling', async surface => {
  const { user, onDenied } = await mount(surface, { denial: true })
  if (surface === 'create') { await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'recipient@example.test'); await user.click(screen.getByRole('button', { name: 'Create' })) }
  else await confirmAction(user, 'Invite to application', ['Email', 'recipient@example.test'])
  await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1))
})
it.each(['access_link_account', 'access_unlink_account'] as const)('V3 %s remains in the card without Members invitation status', async grant => {
  const { write } = await mount('detail', { grants: [grant], unavailable: true, state: grant === 'access_unlink_account' ? 'signed_in' : 'no_account' })
  await screen.findByText(en.rowAccessUnavailable)
  expect(screen.getByRole('button', { name: grant === 'access_link_account' ? 'Find member or invite' : 'Remove access' })).toBeTruthy()
  expect(write.mock.calls.every(([path]) => path === '/api/entries/one')).toBe(true)
})
it.each(['detail', 'edit'] as const)('%s shows an existing invitation with delivery trouble', async surface => {
  await mount(surface, { state: 'invited', deliveryFailure: true }); await screen.findByText(en.rowInviteDeliveryFailed); expect(screen.getByText('Invited')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Invite to application' })).toBeNull()
})
it('create preserves the saved record and existing invitation when delivery fails', async () => {
  const { user, write } = await mount('create', { v3: false, deliveryFailure: true })
  await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'recipient@example.test'); await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByText('Invited'); await screen.findAllByText(en.rowInviteDeliveryFailed)
  expect(write.mock.calls.filter(([path, method]) => path === '/api/entries' && method === 'POST')).toHaveLength(1)
  expect(write.mock.calls.filter(([path, method]) => path === '/orgs/org/invitations' && method === 'POST')).toHaveLength(1)
})
it('changing a linked account in edit reconciles removal before inviting its replacement', async () => {
  const { user, write } = await mount('edit', { state: 'signed_in' })
  await confirmAction(user, 'Change invitation email', ['Email', 'replacement@example.test'])
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/invite', 'POST', { email: 'replacement@example.test' }))
  const paths = write.mock.calls.map(([path]) => path)
  const unlink = paths.indexOf('/api/entries/one/actions/unlink_account'), invite = paths.indexOf('/api/entries/one/actions/invite')
  expect(unlink).toBeGreaterThan(-1); expect(paths.slice(unlink + 1, invite)).toContain('/api/entries/one')
})
it('an in-flight access mutation blocks every other access control until reconciliation', async () => {
  const { user, write } = await mount('detail', { membersRead: false })
  await user.click(await screen.findByRole('button', { name: 'Invite to application' }))
  await user.type(screen.getByLabelText('Email'), 'recipient@example.test')
  let finish!: (data: any) => void
  write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Invite to application' }))
  await waitFor(() => expectNoEnabledAccess())
  await act(async () => { finish({}) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
it('legacy create invitation retry uses the same saved row target', async () => {
  const { user, write } = await mount('create', { v3: false, failure: true })
  await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'recipient@example.test'); await user.click(screen.getByRole('button', { name: 'Create' }))
  await screen.findByText(en.rowInviteSavedFailed)
  const retry = screen.getByRole('button', { name: 'Retry invitation' }); await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false)); await user.click(retry)
  await waitFor(() => expect(write.mock.calls.filter(([path, method]) => path === '/orgs/org/invitations' && method === 'POST')).toHaveLength(2))
  expect(write).toHaveBeenCalledWith('/orgs/org/invitations', 'POST', { email: 'recipient@example.test', target: { entity: 'entries', row: 'created' } })
  expect(write.mock.calls.filter(([path, method]) => path === '/api/entries' && method === 'POST')).toHaveLength(1)
})
for (const surface of ['detail', 'menu', 'edit', 'create'] as const) {
  it.each(['no_account', 'invited', 'expired', 'signed_in'] as const)(`${surface} renders known %s state and authorized controls`, async state => {
    const { user } = await mount(surface, { state, failure: surface === 'create', accounts: state === 'signed_in' ? [{ id: 'account', label: 'Authorized linked account' }] : [] })
    if (surface === 'create') { await user.click(screen.getByRole('checkbox', { name: 'Invite now' })); await user.type(screen.getByLabelText('Invitation email'), 'recipient@example.test'); await user.click(screen.getByRole('button', { name: 'Create' })) }
    await screen.findByText({ no_account: 'No access', invited: 'Invited', expired: 'Expired', signed_in: 'Signed in' }[state])
    const label = state === 'no_account' ? 'Find member or invite' : state === 'signed_in' ? 'Remove access' : 'Resend'
    await waitFor(() => expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false))
    if (state === 'signed_in') expect(screen.getByText('Authorized linked account')).toBeTruthy()
    if (state === 'expired') expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
  })
}
it('grouped edit preserves its cached form and unsaved fields when an access refresh read fails', async () => {
  const { user, request, write } = await mount('edit', { grouped: true })
  await user.type(await screen.findByLabelText('Name'), ' draft')
  request.mockRejectedValueOnce({ status: 500 })
  await confirmAction(user, 'Invite to application', ['Email', 'recipient@example.test'])
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Original draft')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one', 'PATCH', { name: 'Original draft', version: 2 }, undefined))
})
it('edit changes an expired invitation directly after verifying live invite availability', async () => {
  const { user, write } = await mount('edit', { state: 'expired' })
  await confirmAction(user, 'Change invitation email', ['Email', 'replacement@example.test'])
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/invite', 'POST', { email: 'replacement@example.test' }))
  expect(write.mock.calls.some(([path]) => path.endsWith('/cancel_invite'))).toBe(false)
})
it.each(['unknown', 'error', 'refetch'] as const)('explicit-only V3 availability still guards %s responses', async state => {
  const { write, client } = await mount('detail', { unavailable: true, grants: ['access_link_account'] })
  await screen.findByText(en.rowAccessUnavailable)
  let finish!: (data: any) => void
  if (state === 'error') write.mockRejectedValueOnce({ status: 500 })
  else if (state === 'unknown') write.mockResolvedValueOnce({ access: { state: 'unknown' }, actions: { link_account: { enabled: true } } })
  else write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  let pending!: Promise<void>
  await act(async () => { pending = client.invalidateQueries({ queryKey: ['row-access'] }); if (state !== 'refetch') await pending })
  if (state === 'refetch') await waitFor(() => expect(client.isFetching({ queryKey: ['row-access'] })).toBe(1))
  await waitFor(expectNoEnabledAccess)
  if (state === 'refetch') await act(async () => { finish({ actions: { link_account: { enabled: true } } }); await pending })
})
it('create with unavailable invitation status omits Invite now despite an invitation grant', async () => {
  await mount('create', { unavailable: true, grants: ['access_invite'] })
  expect(screen.queryByRole('checkbox', { name: 'Invite now' })).toBeNull()
})

it('review6 Link picker requests eligible Members and submits without users capabilities', async () => {
  const { user, write, request } = await mount('detail', { deferMutation: true })
  await user.click(await screen.findByRole('button', { name: 'Find member or invite' }))
  await user.type(screen.getByRole('combobox', { name: 'Name or email' }), 'Workspace')
  await waitFor(() => expect(write).toHaveBeenCalledWith('/orgs/org/members?eligible=link_account&target_entity=entries&target_row=one&q=Workspace', 'GET'))
  await user.click(await screen.findByRole('option', { name: 'Workspace member · member@example.test' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Link account' }))
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/link_account', 'POST', { user_id: 'account' }))
  expect(write.mock.calls.some(([path]) => /users|accounts/.test(path))).toBe(false)
  expect(request.mock.calls).toEqual([])
})
it('14 staff without members.read has no Link picker even with an explicit link grant', async () => {
  const { write } = await mount('detail', { membersRead: false, grants: ['access_link_account'] })
  await screen.findByText('No access')
  expect(screen.queryByRole('button', { name: 'Link account' })).toBeNull()
  expect(write.mock.calls.some(([path]) => path.split('?')[0].endsWith('/members'))).toBe(false)
})
it('14 failed Members read never falls back to a raw account id input', async () => {
  const { user, write } = await mount('detail', { membersFailure: true })
  await user.click(await screen.findByRole('button', { name: 'Find member or invite' }))
  await user.type(screen.getByRole('combobox', { name: 'Name or email' }), 'Workspace')
  await screen.findByRole('alert')
  expect(screen.queryByRole('textbox', { name: 'Member' })).toBeNull()
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Link account' })).toBeNull()
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
})

it.each(['en', 'cs'].flatMap(language => [true, false].map(v3 => ({ language: language as 'en' | 'cs', v3 }))))
('89 $language Link conflict stays on Member and retries using refreshed choices (v3=$v3)', async ({ language, v3 }) => {
  const labels = language === 'cs' ? cs : en
  const message = language === 'cs' ? 'Tento účet je již propojen s jiným záznamem. Vyberte jiného člena.' : 'This account is already linked to another record. Choose another member.'
  const { user, write, client } = await mount('detail', { language, v3, linkConflict: true })
  // Another row/entity's cache cannot provide this target's choices.
  client.setQueryData(['account-link-members', 'org', 'other', 'two'], { data: [{ user_id: 'wrong', display_name: 'Wrong target' }] })
  await user.click(await screen.findByRole('button', { name: labels.rowFindMember }))
  await user.type(screen.getByRole('combobox', { name: labels.rowFindQuery }), 'member')
  expect(screen.queryByRole('option', { name: 'Wrong target' })).toBeNull()
  await user.click(await screen.findByRole('option', { name: 'Workspace member · member@example.test' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: labels.rowInvite_link }))
  const error = await screen.findByText(message)
  const field = screen.getByRole('combobox', { name: labels.rowFindQuery })
  expect(field.getAttribute('aria-invalid')).toBe('true')
  expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)
  expect(screen.queryByText(labels.requestFailed)).toBeNull()
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(field).not.toHaveProperty('value', 'Workspace member · member@example.test')
  const memberReads = () => write.mock.calls.filter(([path]) => path.includes('/members?'))
  await waitFor(() => expect(memberReads().length).toBeGreaterThanOrEqual(2))
  expect(client.getQueryCache().getAll().find(q => q.queryKey[0] === 'account-link-members' && q.queryKey[2] === 'entries' && q.queryKey[5] === 'member')?.queryKey).toEqual(['account-link-members', 'org', 'entries', 'one', expect.any(Object), 'member'])
  await user.click(field)
  expect(screen.queryByRole('option', { name: 'Workspace member · member@example.test' })).toBeNull()
  await user.click(await screen.findByRole('option', { name: 'Free member · free@example.test' }))
  await waitFor(() => expect(screen.queryByText(message)).toBeNull())
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: labels.rowInvite_link }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const writes = write.mock.calls.filter(([, method]) => method === 'POST')
  expect(writes.map(([, , body]) => v3 ? body.user_id : body.userId)).toEqual(['account', 'free'])
  expect(memberReads().length).toBeGreaterThanOrEqual(3)
})
it.each(['en', 'cs'] as const)('89 %s Link displays a localized empty state', async language => {
  const labels = language === 'cs' ? cs : en
  const { user } = await mount('detail', { language, noMembers: true })
  await user.click(await screen.findByRole('button', { name: labels.rowFindMember }))
  await user.type(screen.getByRole('combobox', { name: labels.rowFindQuery }), 'Nobody')
  await screen.findByText(language === 'cs' ? 'Žádní členové k propojení.' : 'No members available to link.')
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: labels.rowInvite_link })).toBeNull()
})

it.each([true, false])('89 unlink invalidates cached Link choices for other targets (v3=%s)', async v3 => {
  const { user, client } = await mount('detail', { v3, state: 'signed_in' })
  const key = ['account-link-members', 'org', 'entries', 'other-row']
  client.setQueryData(key, { data: [] })
  await user.click(await screen.findByRole('button', { name: en.rowInvite_remove }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.rowInvite_remove }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(client.getQueryState(key)?.isInvalidated).toBe(true)
})


it.each(['detail', 'edit'] as const)('91 %s pending card keeps two primary actions and two overflow items with keyboard focus return', async surface => {
  const { user } = await mount(surface, { state: 'invited' })
  await screen.findByText('invited@example.test')
  expect(screen.getByRole('button', { name: 'Resend' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Cancel invitation' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Change invitation email' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Link account' })).toBeNull()
  const menu = screen.getByRole('button', { name: 'Invitation actions' })
  menu.focus(); await user.keyboard('{ArrowDown}')
  const items = await screen.findAllByRole('menuitem')
  expect(items.map(item => item.textContent)).toEqual(['Cancel invitation', 'Change invitation email'])
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(menu))
  await user.keyboard('{ArrowDown}')
  await screen.findAllByRole('menuitem')
  await user.keyboard('{ArrowDown}{Enter}')
  await screen.findByRole('dialog', { name: 'Change invitation email' })
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(menu))
})
it.each(['Workspace', 'member@example.test', 'Workspace member member@example.test'])('91 searches %s and requires a concrete choice and explicit confirmation', async query => {
  const { user, write } = await mount('detail', { state: 'invited' })
  await user.click(await screen.findByRole('button', { name: 'Find member or invite' }))
  const input = screen.getByRole('combobox', { name: 'Name or email' })
  await user.type(input, query)
  await screen.findByRole('option', { name: 'Workspace member · member@example.test' })
  expect(write).toHaveBeenCalledWith(`/orgs/org/members?eligible=link_account&target_entity=entries&target_row=one&q=${encodeURIComponent(query)}`, 'GET')
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  expect(screen.getByText('invited@example.test')).toBeTruthy()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(screen.getByText('Linking this member will cancel the pending invitation to invited@example.test. Its old link will stop working.')).toBeTruthy()
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Link account' }))
  await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/link_account', 'POST', { user_id: 'account' }))
})
it.each(['Nobody', 'bad@invalid', 'a..b@example.test', 'new@example.test'])('91 no match for %s invites only a valid email', async query => {
  const { user, write } = await mount('detail', { noMembers: true })
  await user.click(await screen.findByRole('button', { name: 'Find member or invite' }))
  await user.type(screen.getByRole('combobox', { name: 'Name or email' }), query)
  await screen.findByText('No members available to link.')
  const invite = screen.queryByRole('button', { name: 'Send invitation' })
  if (query === 'new@example.test') { expect(invite).toBeTruthy(); await user.click(invite!); await waitFor(() => expect(write).toHaveBeenCalledWith('/api/entries/one/actions/invite', 'POST', { email: query })) }
  else { expect(invite).toBeNull(); expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true) }
})
it.each([{ admin: false }, { membersRead: false }, { grants: ['access_invite'] }])('91 invite-only roles make no member request: %j', async options => {
  const { user, write } = await mount('detail', options)
  await screen.findByText('No access')
  expect(screen.queryByRole('button', { name: 'Find member or invite' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Invite to application' }))
  await user.type(screen.getByLabelText('Email'), 'new@example.test')
  expect(screen.queryByRole('option')).toBeNull()
  expect(screen.queryByText(/Workspace member/)).toBeNull()
  expect(write.mock.calls.some(([path]) => path.includes('/members'))).toBe(false)
})


it.each(['en', 'cs'].flatMap(language => [[], ['access_invite'], ['access_cancel_invite'], ['access_invite', 'access_cancel_invite']].map(grants => ({ language: language as 'en' | 'cs', grants }))))
('91 $language pending actions retain individual grants: $grants', async ({ language, grants }) => {
  const labels = language === 'cs' ? cs : en
  const { user, write } = await mount('detail', { language, state: 'invited', grants })
  await screen.findByText('invited@example.test')
  const invite = grants.includes('access_invite'), cancel = grants.includes('access_cancel_invite')
  expect(!!screen.queryByRole('button', { name: labels.rowInvite_resend })).toBe(invite)
  expect(!!screen.queryByRole('button', { name: labels.rowInvite_copy })).toBe(invite)
  expect(!!screen.queryByRole('button', { name: labels.rowInvitationActions })).toBe(cancel)
  if (cancel) {
    await user.click(screen.getByRole('button', { name: labels.rowInvitationActions }))
    expect(screen.getByRole('menuitem', { name: labels.rowInvite_cancel })).toBeTruthy()
    expect(!!screen.queryByRole('menuitem', { name: labels.rowInvite_change })).toBe(invite)
    expect(screen.getAllByRole('menuitem')).toHaveLength(invite ? 2 : 1)
  }
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  expect(write.mock.calls.some(([path]) => path.includes('/members'))).toBe(false)
})

it('91 edit search popup handles Escape before either enclosing dialog', async () => {
  const { user } = await mount('edit', { state: 'invited' })
  await user.click(await screen.findByRole('button', { name: 'Find member or invite' }))
  const input = screen.getByRole('combobox', { name: 'Name or email' })
  await user.clear(input)
  await user.type(input, 'Workspace')
  await screen.findByRole('option', { name: 'Workspace member · member@example.test' })
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('option')).toBeNull()
  expect(screen.getAllByRole('dialog')).toHaveLength(2)
  expect(document.activeElement).toBe(input)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Find member or invite' }))
})
