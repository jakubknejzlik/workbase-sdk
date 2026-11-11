import { expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import cs from '../../frontend-console/src/locales/cs.json'
import { GeneratedRowInvitation } from '../../console-generated/src/write-screens'
import type { Model, Capabilities } from '../../console-generated/src/read'

const model = { entities: { people: { rowInvitations: true } } } as unknown as Model
const caps = { revision: 1, commands: ['people/remove_access'], entities: {} } as Capabilities
async function mount(state: string, canInvite = true) {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'cs', resources: { cs: { translation: cs } } })
  let current = state
  const write = vi.fn(async (path: string, method: string, _body?: unknown) => {
    if (method === 'GET') return { state: current, can_invite: canInvite, can_cancel: canInvite,
      ...(['invited', 'expired'].includes(current) ? { invitation: { id: 'pending', email: 'one@example.test' } } : {}) }
    current = method === 'DELETE' || path.includes('remove_access') ? 'no_account' : 'invited'
    return { accept_url: 'credential-must-not-be-cached' }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedRowInvitation model={model} caps={caps} orgId="org" entity="people" row={{ id: 'person' }} request={vi.fn()} write={write} /></QueryClientProvider></I18nextProvider>)
  return { write, client, user: userEvent.setup() }
}
it('176 rendered row state invites an email without submitting the protected link or caching a credential', async () => {
  const { write, client, user } = await mount('no_account')
  await screen.findByText('Bez účtu')
  await user.click(screen.getByRole('button', { name: 'Pozvat do aplikace' }))
  await user.type(screen.getByLabelText('E-mail'), 'one@example.test')
  await user.click(screen.getAllByRole('button', { name: 'Pozvat do aplikace' }).at(-1)!)
  await screen.findByText('Pozváno')
  expect(write).toHaveBeenCalledWith('/orgs/org/invitations', 'POST', { email: 'one@example.test', target: { entity: 'people', row: 'person' } })
  expect(JSON.stringify(client.getMutationCache().getAll().map(entry => entry.state.data))).not.toContain('credential')
})
it.each(['no_account', 'invited', 'signed_in'])('176 renders Czech state %s and hides invitation actions without live authority', async state => {
  await mount(state, false)
  await screen.findByText({ no_account: 'Bez účtu', invited: 'Pozváno', signed_in: 'Přihlášen' }[state]!)
  expect(screen.queryByRole('button', { name: 'Pozvat do aplikace' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Znovu odeslat' })).toBeNull()
})
it('176 cancellation refreshes the row so another email can be invited', async () => {
  const { write, user } = await mount('invited')
  await screen.findByText('Pozváno')
  await user.click(screen.getByRole('button', { name: 'Zrušit pozvánku' }))
  await user.click(screen.getAllByRole('button', { name: 'Zrušit pozvánku' }).at(-1)!)
  await waitFor(() => expect(write).toHaveBeenCalledWith('/orgs/org/invitations/pending', 'DELETE'))
  await screen.findByText('Bez účtu')
  expect(screen.getByRole('button', { name: 'Pozvat do aplikace' })).toBeTruthy()
})

it('176b expired row offers resend and hides copy-link', async () => {
  await mount('expired')
  await screen.findByText('Vypršela')
  expect(screen.getByRole('button', { name: 'Znovu odeslat' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Kopírovat odkaz' })).toBeNull()
})
it('176b pending row copies a link only on demand without caching the credential', async () => {
  const { write, client, user } = await mount('invited')
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  await user.click(await screen.findByRole('button', { name: 'Kopírovat odkaz' }))
  await user.click(screen.getAllByRole('button', { name: 'Kopírovat odkaz' }).at(-1)!)
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith('credential-must-not-be-cached'))
  expect(write).toHaveBeenCalledWith('/orgs/org/invitations/pending/copy-link', 'POST', {})
  expect(JSON.stringify(client.getMutationCache().getAll().map(entry => entry.state.data))).not.toContain('credential')
})

it.each(['no_account', 'invited', 'expired', 'signed_in'])('176b access filter %s round-trips URL state into the server query', async rowAccess => {
  const { validateListSearch, stateFromSearch, searchFromState, toQueryDocument } = await import('../../console-generated/src/list-model')
  const listModel = { instance: 'test', limits: { root: 100 }, entities: { people: { rowInvitations: true, fields: { id: { type: 'string' } }, columns: ['id'], relations: {} } } } as unknown as Model
  const listCaps = { revision: 1, entities: { people: { readable: ['id'], writable: [], operations: ['read'] } } } as Capabilities
  const { state, dropped } = stateFromSearch(validateListSearch({ rowAccess }), listModel, 'people', listCaps)
  expect(dropped).toBe(false)
  expect(searchFromState(state).rowAccess).toBe(rowAccess)
  expect(toQueryDocument(state, listModel, 'people', listCaps)).toMatchObject({ rowAccess })
  listModel.entities.people.rowInvitations = false
  const denied = stateFromSearch(validateListSearch({ rowAccess }), listModel, 'people', listCaps)
  expect(denied.dropped).toBe(true)
  expect(toQueryDocument(denied.state, listModel, 'people', listCaps).rowAccess).toBeUndefined()
})
it('176b rejects malformed access filter URL values', async () => {
  const { validateListSearch } = await import('../../console-generated/src/list-model')
  for (const value of ['unknown', ['expired'], { state: 'expired' }]) expect(validateListSearch({ rowAccess: value })).toEqual({ invalidSettings: true })
})
