import { expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { createInstance } from 'i18next'
import type { ReactNode } from 'react'
import { MembersScreen } from '../src/members'
import { identityClient } from '../src/api/identity'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
vi.mock('../src/api/queries', () => ({
  useOrganization: () => ({ data: { role: 'admin', user: { id: 'admin' }, memberships: [{ organization_id: 'org', name: 'Synthetic' }] } }),
  useCapabilities: () => ({ data: { resources: { 'members.read': true } } }),
}))
it.each(['en', 'cs'] as const)('178 %s retains Active plus Pending link for the same synthetic email', async language => {
  const t = language === 'cs' ? cs : en
  vi.spyOn(identityClient, 'combined').mockResolvedValue({ role_options: [{ id: 'staff', administrator: false }], default_role: 'staff', data: [
    { user_id: 'free', email: 'free@example.test', role: 'staff' },
    { id: 'pending', email: 'free@example.test', role: 'staff', target_entity: 'worker', target_row: 'two', accepted_at: null, revoked_at: null, expires_at: '2099-01-01T00:00:00Z' },
    { id: 'untargeted', email: 'new@example.test', role: 'staff', accepted_at: null, revoked_at: null, expires_at: '2099-01-01T00:00:00Z' },
  ] })
  const i18n = createInstance(); await i18n.init({ lng: language, resources: { [language]: { translation: t } } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><MembersScreen orgId="org" /></QueryClientProvider></I18nextProvider>)
  await screen.findByText(t.memberPendingLink)
  const rows = screen.getAllByRole('row').filter(row => row.textContent?.includes('free@example.test'))
  expect(rows).toHaveLength(2)
  expect(rows.some(row => within(row).queryByText(t.memberActive))).toBe(true)
  expect(rows.some(row => within(row).queryByText(t.memberPendingLink))).toBe(true)
  expect(screen.getByText(t.memberInvited)).toBeTruthy()
})
