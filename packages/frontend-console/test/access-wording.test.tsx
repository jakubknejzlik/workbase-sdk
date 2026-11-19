import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
import { GeneratedRowInvitation } from '../../console-generated/src/write-screens'
import type { Model, Capabilities } from '../../console-generated/src/read'

// Wording of the approved access-menu reference (state header + menu actions), not the transport value names.
const reference = {
  cs: { signed_in: 'Propojený účet', invited: 'Pozvánka odeslána', no_account: 'Bez přístupu', expired: 'Pozvánka vypršela', menu: ['Znovu odeslat', 'Kopírovat odkaz', 'Změnit člena nebo e-mail', 'Zrušit pozvánku'] },
  en: { signed_in: 'Linked account', invited: 'Invitation sent', no_account: 'No access', expired: 'Invitation expired', menu: ['Resend', 'Copy link', 'Change member or e-mail', 'Cancel invitation'] },
} as const
const model = { entities: { people: { rowInvitations: true } } } as unknown as Model
const caps = { resources: { 'invitations.read': true }, revision: 1, commands: [], entities: {} } as Capabilities
async function mount(language: 'en' | 'cs', state: keyof typeof reference.en) {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } } })
  const write = vi.fn(async () => ({ state, can_invite: true, can_cancel: true, linked_accounts: state === 'signed_in' ? [{ id: 'a', label: 'Jana Example' }] : [], ...(['invited', 'expired'].includes(state) ? { invitation: { id: 'pending', email: 'one@example.test' } } : {}) }))
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GeneratedRowInvitation model={model} caps={caps} orgId="org" entity="people" row={{ id: 'person' }} write={write as any} request={vi.fn() as any} /></QueryClientProvider></I18nextProvider>)
}
it.each(['en', 'cs'] as const)('%s labels every state as the reference does and never calls a linked account a live session', async language => {
  for (const state of ['signed_in', 'invited', 'no_account', 'expired'] as const) {
    expect(({ en, cs } as const)[language][`rowAccess_${state}`]).toBe(reference[language][state])
  }
  expect(JSON.stringify(Object.entries(({ en, cs } as const)[language]).filter(([key]) => key.startsWith('rowAccess_')))).not.toMatch(/signed in|přihlášen/i)
})
it.each(['en', 'cs'] as const)('%s access menu header, accessible name and invited actions match the reference', async language => {
  await mount(language, 'invited'); const user = userEvent.setup()
  const trigger = await screen.findByRole('button', { name: new RegExp(`one@example.test – ${reference[language].invited}, `) })
  await user.click(trigger)
  expect(screen.getByRole('menu').textContent?.startsWith(reference[language].invited)).toBe(true)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(reference[language].menu)
})
it.each(['en', 'cs'] as const)('%s linked-account state reads as a linked account in the menu header', async language => {
  await mount(language, 'signed_in'); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: new RegExp(`Jana Example – ${reference[language].signed_in}, `) }))
  expect(screen.getByRole('menu').textContent).toContain(reference[language].signed_in)
})
