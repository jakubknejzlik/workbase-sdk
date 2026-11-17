import { expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../../frontend-console/src/locales/en.json'
import cs from '../../frontend-console/src/locales/cs.json'
import { GeneratedRowInvitation } from '../../console-generated/src/write-screens'
import type { Model, Capabilities } from '../../console-generated/src/read'

const model = { entities: { people: { rowInvitations: true } } } as unknown as Model
const caps = { resources: { 'invitations.read': true }, revision: 1, commands: ['people/remove_access'], entities: {} } as Capabilities
async function mount(state: string, canInvite = true, language: 'en' | 'cs' = 'cs', read = true, identity = false, commands = caps.commands, canCancel = canInvite) {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } } })
  let current = state
  const write = vi.fn(async (path: string, method: string, _body?: unknown) => {
    if (method === 'GET') return { state: current, can_invite: canInvite, can_cancel: canCancel, linked_accounts: identity && current === 'signed_in' ? [{ id: 'account', label: 'Jana Example' }] : [],
      ...(['invited', 'expired'].includes(current) ? { invitation: { id: 'pending', email: 'one@example.test' } } : {}) }
    current = method === 'DELETE' || path.includes('remove_access') ? 'no_account' : 'invited'
    return { accept_url: 'credential-must-not-be-cached' }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedRowInvitation model={model} caps={{ ...caps, commands, resources: { ...caps.resources, 'invitations.read': read } }} orgId="org" entity="people" row={{ id: 'person' }} request={vi.fn()} write={write} /></QueryClientProvider></I18nextProvider>)
  return { write, client, user: userEvent.setup() }
}
it('176 rendered row state invites an email without submitting the protected link or caching a credential', async () => {
  const { write, client, user } = await mount('no_account')
  await screen.findByRole('button', { name: new RegExp(cs.rowAccess_no_account) })
  await user.click(screen.getByRole('button', { name: new RegExp(cs.rowAccessActions) })); await user.click(screen.getByRole('menuitem', { name: cs.rowFindMember }))
  await user.type(screen.getByRole('combobox'), 'one@example.test')
  await waitFor(() => expect(screen.getByRole('button', { name: cs.rowFindSend })).toHaveProperty('disabled', false)); await user.click(screen.getByRole('button', { name: cs.rowFindSend }))
  await screen.findByRole('button', { name: new RegExp(cs.rowAccess_invited) })
  expect(write).toHaveBeenCalledWith('/orgs/org/invitations', 'POST', { email: 'one@example.test', target: { entity: 'people', row: 'person' } })
  expect(JSON.stringify(client.getMutationCache().getAll().map(entry => entry.state.data))).not.toContain('credential')
})
it.each(['no_account', 'invited', 'expired', 'signed_in'])('176 renders Czech state %s and hides invitation actions without live authority', async state => {
  await mount(state, false)
  const trigger = await screen.findByRole('button', { name: new RegExp(cs[`rowAccess_${state}` as keyof typeof cs]) })
  await userEvent.setup().click(trigger)
  expect(screen.queryAllByRole('menuitem').map(item => item.textContent)).toEqual(state === 'invited' ? [] : [cs.rowInvite_remove])
  expect(screen.queryByRole('button', { name: 'Pozvat do aplikace' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Znovu odeslat' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Kopírovat odkaz' })).toBeNull()
})
it('176 cancellation refreshes the row so another email can be invited', async () => {
  const { write, user } = await mount('invited')
  await screen.findByRole('button', { name: new RegExp(cs.rowAccess_invited) })
  await user.click(screen.getByRole('button', { name: new RegExp(cs.rowAccessActions) }))
  await user.click(screen.getByRole('menuitem', { name: 'Zrušit pozvánku' }))
  await user.click(screen.getAllByRole('button', { name: 'Zrušit pozvánku' }).at(-1)!)
  await waitFor(() => expect(write).toHaveBeenCalledWith('/orgs/org/invitations/pending', 'DELETE'))
  await screen.findByRole('button', { name: new RegExp(cs.rowAccess_no_account) })
  expect(screen.getByRole('button', { name: new RegExp(cs.rowAccessActions) })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: new RegExp(cs.rowAccessActions) })); await user.click(screen.getByRole('menuitem', { name: cs.rowFindMember }))
  await user.type(screen.getByRole('combobox'), 'two@example.test')
  await waitFor(() => expect(screen.getByRole('button', { name: cs.rowFindSend })).toHaveProperty('disabled', false)); await user.click(screen.getByRole('button', { name: cs.rowFindSend }))
  await screen.findByRole('button', { name: new RegExp(cs.rowAccess_invited) })
  expect(write).toHaveBeenCalledWith('/orgs/org/invitations', 'POST', { email: 'two@example.test', target: { entity: 'people', row: 'person' } })
})

it('176b expired row offers resend and hides copy-link', async () => {
  await mount('expired')
  await screen.findByRole('button', { name: new RegExp(cs.rowAccess_expired) })
  await userEvent.setup().click(screen.getByRole('button', { name: new RegExp(cs.rowAccessActions) })); expect(screen.getByRole('menuitem', { name: 'Znovu odeslat' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Kopírovat odkaz' })).toBeNull()
})
it('176b pending row copies a link only on demand without caching the credential', async () => {
  const { write, client, user } = await mount('invited')
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  await user.click(await screen.findByRole('button', { name: new RegExp(cs.rowAccessActions) })); await user.click(screen.getByRole('menuitem', { name: 'Kopírovat odkaz' }))
  await user.click(screen.getAllByRole('button', { name: 'Kopírovat odkaz' }).at(-1)!)
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith('credential-must-not-be-cached'))
  expect(write).toHaveBeenCalledWith('/orgs/org/invitations/pending/copy-link', 'POST', {})
  expect(JSON.stringify(client.getMutationCache().getAll().map(entry => entry.state.data))).not.toContain('credential')
})

it.each(['no_account', 'invited', 'expired', 'signed_in'])('176b access filter %s round-trips URL state into the server query', async rowAccess => {
  const { validateListSearch, stateFromSearch, searchFromState, toQueryDocument } = await import('../../console-generated/src/list-model')
  const listModel = { instance: 'test', limits: { root: 100 }, entities: { people: { rowInvitations: true, fields: { id: { type: 'string' } }, columns: ['id'], relations: {} } } } as unknown as Model
  const listCaps = { resources: { 'invitations.read': true }, revision: 1, entities: { people: { readable: ['id'], writable: [], operations: ['read'] } } } as Capabilities
  const { state, dropped } = stateFromSearch(validateListSearch({ rowAccess }), listModel, 'people', listCaps)
  expect(dropped).toBe(false)
  expect(searchFromState(state).rowAccess).toBe(rowAccess)
  expect(toQueryDocument(state, listModel, 'people', listCaps)).toMatchObject({ rowAccess })
  listCaps.resources!['invitations.read'] = false
  const unreadable = stateFromSearch(validateListSearch({ rowAccess }), listModel, 'people', listCaps)
  expect(unreadable.dropped).toBe(true)
  expect(toQueryDocument({ ...state, rowAccess: rowAccess as any }, listModel, 'people', listCaps).rowAccess).toBeUndefined()
  listCaps.resources!['invitations.read'] = true
  listModel.entities.people.rowInvitations = false
  const denied = stateFromSearch(validateListSearch({ rowAccess }), listModel, 'people', listCaps)
  expect(denied.dropped).toBe(true)
  expect(toQueryDocument(denied.state, listModel, 'people', listCaps).rowAccess).toBeUndefined()
})
it('176b rejects malformed access filter URL values', async () => {
  const { validateListSearch } = await import('../../console-generated/src/list-model')
  for (const value of ['unknown', ['expired'], { state: 'expired' }]) expect(validateListSearch({ rowAccess: value })).toEqual({ invalidSettings: true })
})

for (const language of ['en', 'cs'] as const) it.each(['no_account', 'invited', 'expired', 'signed_in'] as const)(`209 ${language} exposes %s by name, header and focus/hover tooltip`, async state => {
  const t = language === 'cs' ? cs : en
  const { user } = await mount(state, true, language, true, true)
  const stateLabel = t[`rowAccess_${state}`]
  const button = await screen.findByRole('button', { name: new RegExp(`${stateLabel}, ${t.rowAccessActions}`) })
  expect(button.textContent).toBe(state === 'no_account' ? '–' : state === 'signed_in' ? 'Jana Example' : 'one@example.test')
  expect(button.parentElement!.textContent).not.toContain(stateLabel)
  expect(button.classList.contains('h-6')).toBe(true)
  expect(button.classList.contains('h-8')).toBe(false)
  expect(button.className).not.toMatch(/(?:^| )(?:(?:pointer-coarse:)?min-[hw]-11)(?: |$)/)
  expect(button.querySelector('[aria-hidden="true"]')).toBeTruthy()
  await user.tab()
  expect(document.activeElement).toBe(button)
  expect((await screen.findByRole('tooltip')).textContent).toBe(stateLabel)
  await user.keyboard('{Escape}')
  await user.tab()
  await user.hover(button)
  expect((await screen.findByRole('tooltip')).textContent).toBe(stateLabel)
  await user.click(button)
  expect(screen.getByRole('menu').textContent).toContain(stateLabel)
  const header = screen.getByRole('menu').querySelector('[data-slot="dropdown-menu-label"]')!
  expect(header.textContent).toBe(stateLabel)
  expect(header.querySelector('[aria-hidden="true"].rounded-full')).toBeTruthy()
  expect(header.getAttribute('role')).toBeNull()
  expect(header.hasAttribute('tabindex')).toBe(false)
  expect(header.nextElementSibling?.getAttribute('role')).toBe('separator')
  const expected = state === 'no_account' ? [t.rowInvite_remove, t.rowFindMember] : state === 'signed_in' ? [t.rowInvite_remove] : state === 'invited' ? [t.rowInvite_resend, t.rowInvite_copy, t.rowChangeMemberOrEmail, t.rowInvite_cancel] : [t.rowInvite_resend, t.rowInvite_cancel, t.rowInvite_remove, t.rowFindMember]
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(expected)
})
it('209 never requests or renders access without invitation-read authority', async () => {
  const { write } = await mount('invited', true, 'en', false)
  expect(screen.queryByRole('button')).toBeNull()
  expect(write).not.toHaveBeenCalled()
})

it('209 status-only rows can inspect the header without receiving any actions', async () => {
  const { user } = await mount('signed_in', false, 'en', true, false, [])
  const button = await screen.findByRole('button', { name: /Signed in, Application access actions/ })
  expect(button.textContent).toBe('–')
  await user.click(button)
  expect(screen.getByRole('menu').textContent).toContain(en.rowAccess_signed_in)
  expect(screen.queryByRole('menuitem')).toBeNull()
})

it.each([[true, true], [true, false], [false, true], [false, false]])('209 pending menu filters live invite=%s cancel=%s authority', async (invite, cancel) => {
  const { user, write } = await mount('invited', invite, 'en', true, false, [], cancel)
  await user.click(await screen.findByRole('button', { name: /Invited, Application access actions/ }))
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  const expected = [...(invite ? [en.rowInvite_resend, en.rowInvite_copy] : []), ...(invite && cancel ? [en.rowChangeMemberOrEmail] : []), ...(cancel ? [en.rowInvite_cancel] : [])]
  expect(screen.queryAllByRole('menuitem').map(item => item.textContent)).toEqual(expected)
  if (cancel) {
    const item = screen.getByRole('menuitem', { name: en.rowInvite_cancel })
    expect(item.getAttribute('data-variant')).toBe('destructive')
    if (invite) expect(item.parentElement?.previousElementSibling?.querySelector('[role="menuitem"]')?.textContent).toBe(en.rowChangeMemberOrEmail)
    if (invite) expect(item.previousElementSibling?.getAttribute('role')).toBe('separator')
  }
  if (invite && cancel) {
    await user.click(screen.getByRole('menuitem', { name: en.rowChangeMemberOrEmail }))
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'one@example.test')
    expect(screen.getByRole('dialog')).toBeTruthy()
  }
})
