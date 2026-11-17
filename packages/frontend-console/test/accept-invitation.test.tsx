import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
import { AcceptInvitation } from '../src/accept-invitation'

const copiedSelector = 'a'.repeat(64)
const deliveredSelector = `${copiedSelector}.${'b'.repeat(64)}`
const targetRow = '00000000-0000-4000-8000-000000000176'
const summary = {
  id: 'synthetic-invitation', organization: { id: 'synthetic-org', name: 'Invitation workspace' },
  inviter: { display_name: 'Synthetic inviter' }, role: 'member', expires_at: '2099-01-01',
  state: 'pending', target: { entity: 'workers', row: targetRow }, account_match: null,
}
const profile = (complete: boolean) => ({
  id: 'recipient', email: 'recipient@example.test', firstName: complete ? 'Synthetic' : null, lastName: complete ? 'Recipient' : null,
  authority: { kind: 'local', provider: null, synchronization: null }, capabilities: { canEditNames: true, canEditEmail: false },
  completeness: { complete, missingFields: complete ? [] : ['firstName', 'lastName'] },
})
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function mount(language: 'en' | 'cs', options: { authenticated?: boolean; complete?: boolean; delivered?: boolean; byId?: boolean; wrongAccount?: boolean; overbroad?: boolean; state?: string } = {}) {
  let authenticated = options.authenticated ?? false
  let complete = options.complete ?? true
  const assign = vi.fn()
  const originalWindow = window
  const selector = options.delivered ? deliveredSelector : copiedSelector
  const search = options.byId ? `?id=${summary.id}` : `?token=${selector}`
  const scrub = vi.spyOn(originalWindow.history, 'replaceState')
  vi.stubGlobal('window', new Proxy(originalWindow, { get: (target, key) => key === 'location'
    ? { origin: 'http://localhost', search, assign, replace: vi.fn() } : Reflect.get(target, key) }))
  const fetch = vi.fn(async (path: string) => {
    if (path === '/console-info') return Response.json({ instance: 'synthetic-instance', displayName: 'Public instance', roles: [] })
    if (path === '/invitations/preflight' || path === `/invitations/${summary.id}/preview`) return Response.json({ ...(authenticated && !options.wrongAccount || options.delivered || options.overbroad ? { ...summary, state: options.state ?? summary.state } : { id: summary.id }), account_match: authenticated ? !options.wrongAccount : null })
    if (path === '/me/profile') return authenticated ? Response.json(profile(complete)) : Response.json({ error: 'unauthenticated' }, { status: 401 })
    if (path.endsWith('/accept')) {
      if (!authenticated) {
        expect(options.delivered).toBe(true)
        authenticated = true
        return Response.json({ ...summary, account_match: true, profile_complete: complete, next: complete ? 'preview' : 'profile', actions: complete ? ['accept', 'decline'] : ['decline'] })
      }
      return Response.json({ id: summary.id, state: 'accepted', organization_id: 'synthetic-org', role: 'member', entry_target: '/o/synthetic-org', replayed: false }, { status: 201 })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><AcceptInvitation /></QueryClientProvider></I18nextProvider>)
  return { ...view, assign, fetch, scrub, client, user: userEvent.setup(), finishProfile: () => { complete = true; client.setQueryData(['profile'], profile(true)) } }
}

const languages = [
  { language: 'en', signIn: 'Sign in to accept', accept: 'Accept invitation', joined: 'You joined the organization', hint: 'Sign in with the invited email address to accept this invitation.' },
  { language: 'cs', signIn: 'Přihlásit se k přijetí', accept: 'Přijmout pozvánku', joined: cs.p10JoinedTitle, hint: 'Pro přijetí této pozvánky se přihlaste pomocí pozvané e-mailové adresy.' },
] as const

it.each(languages)('$language copied link signs in without attempting acceptance, then requires an explicit accept after login', async ({ language, signIn, accept, joined, hint }) => {
  const anonymous = await mount(language)
  const button = await screen.findByRole('button', { name: signIn })
  expect(screen.getByText(hint)).toBeTruthy()
  expect(screen.getByRole('heading', { name: language === 'en' ? 'Invitation to Public instance' : 'Pozvánka do Public instance' })).toBeTruthy()
  expect(screen.queryByText(summary.organization.name)).toBeNull()
  expect(screen.queryByText(summary.inviter.display_name)).toBeNull()
  expect(screen.queryByRole('button', { name: language === 'en' ? en.p10Decline : cs.p10Decline })).toBeNull()
  expect(screen.queryByText('member')).toBeNull()
  expect(document.body.textContent).not.toContain('workers')
  expect(document.body.textContent).not.toContain(targetRow)
  expect(document.body.textContent).not.toContain(summary.id)
  expect(document.body.textContent).not.toContain(summary.organization.id)
  expect(anonymous.scrub).toHaveBeenCalledWith(null, '', '/invitation')
  await anonymous.user.click(button)
  expect(anonymous.assign).toHaveBeenCalledWith('/sign-in?returnTo=%2Finvitation%3Fid%3Dsynthetic-invitation')
  expect(anonymous.fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(0)
  expect(anonymous.fetch.mock.calls.filter(([path]) => path.endsWith('/resolve'))).toHaveLength(0)
  anonymous.unmount(); anonymous.client.clear()

  const loggedIn = await mount(language, { authenticated: true, byId: true, complete: false })
  await screen.findByRole('heading', { name: language === 'en' ? en.profileSetupTitle : cs.profileSetupTitle })
  expect(loggedIn.fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(0)
  loggedIn.finishProfile()
  const confirm = await screen.findByRole('button', { name: accept })
  expect(screen.getByText(summary.organization.name)).toBeTruthy()
  expect(screen.getByText(summary.inviter.display_name)).toBeTruthy()
  expect(screen.getByText('member')).toBeTruthy()
  expect(screen.getByRole('button', { name: language === 'en' ? en.p10Decline : cs.p10Decline })).toBeTruthy()
  expect(document.body.textContent).toContain('workers')
  expect(document.body.textContent).not.toContain(targetRow)
  expect(loggedIn.fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(0)
  await loggedIn.user.click(confirm)
  await screen.findByRole('heading', { name: joined })
  expect(loggedIn.fetch.mock.calls.filter(([path]) => path.endsWith('/accept')).map(([path]) => path)).toEqual([`/invitations/${summary.id}/accept`])
})

it.each(languages)('$language delivered mailbox-proof link keeps session establishment and confirmed acceptance', async ({ language, accept, signIn, joined }) => {
  const view = await mount(language, { delivered: true })
  const button = await screen.findByRole('button', { name: accept })
  expect(screen.queryByRole('button', { name: signIn })).toBeNull()
  expect(screen.getByText(language === 'en' ? en.p10AnonymousDescription : cs.p10AnonymousDescription)).toBeTruthy()
  expect(screen.getByText(summary.organization.name)).toBeTruthy()
  expect(screen.getByText(summary.inviter.display_name)).toBeTruthy()
  expect(screen.getByText('member')).toBeTruthy()
  expect(document.body.textContent).toContain('workers')
  expect(document.body.textContent).not.toContain(targetRow)
  expect(view.fetch.mock.calls.map(([path]) => path)).not.toContain('/invitations/resolve')
  expect(view.fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(0)
  await view.user.click(button)
  await screen.findByRole('heading', { name: joined })
  expect(view.assign).not.toHaveBeenCalled()
  expect(view.fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(2)
})

it('delivered mailbox-proof link preserves confirmation through its profile gate', async () => {
  const view = await mount('en', { delivered: true, complete: false })
  await view.user.click(await screen.findByRole('button', { name: 'Accept invitation' }))
  await screen.findByRole('heading', { name: en.profileSetupTitle })
  expect(view.fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(1)
  view.finishProfile()
  await screen.findByRole('heading', { name: en.p10JoinedTitle })
  await waitFor(() => expect(view.fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(2))
  expect(view.assign).not.toHaveBeenCalled()
})

for (const state of ['expired', 'revoked', 'declined', 'accepted']) it.each(languages)(`$language delivered ${state} preview shows its terminal state without accepting`, async ({ language, accept, joined }) => {
  const view = await mount(language, { delivered: true, state })
  const copy = language === 'en' ? en : cs
  await screen.findByRole('heading', { name: state === 'declined' ? copy.p10DeclinedTitle : copy.p10UnavailableTitle })
  expect(screen.queryByRole('heading', { name: joined })).toBeNull()
  expect(screen.queryByRole('button', { name: accept })).toBeNull()
  expect(view.fetch.mock.calls.filter(([path]) => path.endsWith('/accept') || path.endsWith('/resolve'))).toHaveLength(0)
})

it.each(languages)('$language other account sees recovery without recipient-only data or confirmation', async ({ language, accept, signIn }) => {
  const view = await mount(language, { authenticated: true, wrongAccount: true, complete: false })
  await screen.findByText(language === 'en' ? en.p10WrongAccountTitle : cs.p10WrongAccountTitle)
  expect(screen.getByRole('heading', { name: language === 'en' ? 'Invitation to Public instance' : 'Pozvánka do Public instance' })).toBeTruthy()
  for (const value of [summary.organization.name, summary.inviter.display_name, targetRow, summary.organization.id, 'workers']) expect(document.body.textContent).not.toContain(value)
  expect(screen.queryByText('member')).toBeNull()
  expect(screen.queryByRole('button', { name: accept })).toBeNull()
  expect(screen.queryByRole('button', { name: signIn })).toBeNull()
  expect(screen.queryByRole('button', { name: language === 'en' ? en.p10Decline : cs.p10Decline })).toBeNull()
  expect(view.fetch.mock.calls.filter(([path]) => path.endsWith('/accept') || path.endsWith('/resolve'))).toHaveLength(0)
})

it.each(languages)('$language public UI also withholds an overbroad response from a non-recipient', async ({ language, signIn }) => {
  await mount(language, { overbroad: true })
  await screen.findByRole('button', { name: signIn })
  for (const value of [summary.organization.name, summary.inviter.display_name, targetRow, 'workers']) expect(document.body.textContent).not.toContain(value)
})
