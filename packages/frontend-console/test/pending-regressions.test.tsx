import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import { GeneratedRowInvitation } from '../../console-generated/src/write-screens'
import type { Model, Capabilities } from '../../console-generated/src/read'

// Real legacy projection: accountLink + rowInvitations; no access_* commands.
async function mount(commands: string[], canInvite: boolean, canCancel: boolean) {
  const model = { entities: { people: { accountLink: { field: 'user', entity: 'users' }, rowInvitations: true } }, commands: commands.map(name => ({ name })) } as unknown as Model
  // Deliberately omitted search_link_account: the supported older-server contract.
  const caps = { resources: { 'invitations.read': true, 'members.read': true }, revision: 1, commands, entities: {} } as Capabilities
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  const write = vi.fn(async (_path: string, _method: string) => ({ state: 'invited', can_invite: canInvite, can_cancel: canCancel, inconsistency: null, linked_accounts: [], invitation: { id: 'pending', email: 'pending@example.test', expires_at: '2099-11-20T10:00:00.000Z' } }))
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><GeneratedRowInvitation model={model} caps={caps} orgId="org" entity="people" row={{id:'person'}} request={vi.fn()} write={write} /></QueryClientProvider></I18nextProvider>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Invited, Application access actions/ }))
  expect(write.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  return user
}
it('209 regression: invited legacy row retains authorized remove, after known items and before destructive cancel', async () => {
  await mount(['people/remove_access'], true, true)
  expect(screen.queryAllByRole('menuitem').map(item => item.textContent)).toEqual([en.rowInvite_resend, en.rowInvite_copy, en.rowChangeMemberOrEmail, en.rowInvite_remove, en.rowInvite_cancel])
  const cancel = screen.getByRole('menuitem', {name: en.rowInvite_cancel})
  expect(cancel.getAttribute('data-variant')).toBe('destructive')
  expect(cancel.previousElementSibling?.getAttribute('role')).toBe('separator')
})
it('209 regression: invited older-server row retains standalone link when search capability is undefined and change/invite are unavailable', async () => {
  const user = await mount(['people/link_account'], false, false)
  expect(screen.queryAllByRole('menuitem').map(item => item.textContent)).toEqual([en.rowInvite_link])
  await user.click(screen.getByRole('menuitem', { name: en.rowInvite_link }))
  expect(screen.getByRole('dialog')).toBeTruthy()
})
