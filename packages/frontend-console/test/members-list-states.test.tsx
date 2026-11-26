import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { createInstance } from 'i18next'
import type { ReactNode } from 'react'
import { MembersScreen } from '../src/members'
import { identityClient, identityKey, type MembersView, type Invitation } from '../src/api/identity'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const member = { user_id: 'person', display_name: 'Ada Example', email: 'ada@example.test', role: 'staff', actions: ['update-role', 'remove'] }
const pending: Invitation = { id: 'person', email: 'ada@example.test', role: 'staff', expires_at: '2099-01-01T00:00:00Z', accepted_at: null, revoked_at: null, actions: ['copy-link', 'revoke'] }
const past: Invitation = { ...pending, id: 'past', email: 'past@example.test', revoked_at: '2026-01-01T00:00:00Z' }
const allGrants = { 'members.read': true, 'members.update': true, 'members.remove': true, 'invitations.read': true, 'invitations.create': true, 'invitations.revoke': true }
async function mount(options: { history?: boolean; language?: 'en' | 'cs'; grants?: Record<string, boolean>; rows?: MembersView['data']; historyRows?: Invitation[]; roles?: MembersView['role_options']; defaultRole?: string; deferred?: boolean; seedOtherFailure?: boolean } = {}) {
  const language = options.language ?? 'en', t = language === 'cs' ? cs : en
  const world = { grants: options.grants ?? { ...allGrants }, membersStatus: 200, historyStatus: 200 }
  let release: (() => void) | undefined
  const gate = options.deferred ? new Promise<void>(resolve => { release = resolve }) : undefined
  const caps = () => ({ revision: 1, organization: { role: 'admin' }, entities: {}, resources: world.grants })
  const requests: { path: string; method: string; org: string | undefined }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push({ path, method: init?.method ?? 'GET', org: (init?.headers as Record<string, string>)?.['X-Organization-Id'] })
    if (path === '/me?scope=organization') return Response.json({ user: { id: 'admin' }, role: 'admin', memberships: [{ organization_id: 'org', name: 'Synthetic' }] })
    if (path === '/o/org/capabilities') return Response.json(caps())
    if (path === '/o/org/console-model') return Response.json({ contractVersion: 2, console: null, model: { instance: 'test', revision: 1, locale: language, timeZone: 'UTC', limits: {}, entities: {}, commands: [], workflows: [] }, capabilities: caps() })
    if (path === '/orgs/org/members?include=pending') {
      await gate
      return world.membersStatus === 200 ? Response.json({ data: options.rows ?? [member, pending], role_options: options.roles ?? [{ id: 'staff', administrator: false }, { id: 'admin', administrator: true }], default_role: options.defaultRole ?? 'staff' }) : Response.json({ error: 'SECRET_SERVER_DETAILS' }, { status: world.membersStatus })
    }
    if (path === '/orgs/org/invitations') {
      await gate
      return world.historyStatus === 200 ? Response.json({ data: options.historyRows ?? [pending, past] }) : Response.json({ error: 'SECRET_HISTORY_DETAILS' }, { status: world.historyStatus })
    }
    throw new Error(`Unexpected HTTP request: ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  if (options.seedOtherFailure) {
    if (options.history) world.membersStatus = 500; else world.historyStatus = 500
    await client.fetchQuery({ queryKey: [...identityKey('org', 'admin'), options.history ? 'combined' : 'invitations'], queryFn: async (): Promise<MembersView | { data: Invitation[] }> => options.history ? identityClient.combined('org') : identityClient.list('org', 'invitations') }).catch(() => {})
  }
  const i18n = createInstance(); await i18n.init({ lng: language, resources: { [language]: { translation: t } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><MembersScreen orgId="org" history={options.history} /></QueryClientProvider></I18nextProvider>)
  return { world, requests, client, t, user: userEvent.setup(), release: async () => { await act(async () => release?.()) }, refetch: async () => { await act(async () => { await client.refetchQueries({ queryKey: [...identityKey('org', 'admin'), options.history ? 'invitations' : 'combined'] }) }) } }
}

it.each(['en', 'cs'] as const)('%s history-only read uses only its endpoint and keeps pending invitations out', async language => {
  const test = await mount({ history: true, language, grants: { 'invitations.read': true } })
  await screen.findByText(past.email)
  expect(screen.queryByText(pending.email)).toBeNull()
  expect(screen.queryByRole('button', { name: test.t.inviteUser })).toBeNull()
  expect(test.requests.filter(request => request.path.startsWith('/orgs/'))).toEqual([{ path: '/orgs/org/invitations', method: 'GET', org: 'org' }])
})
it.each([true, false])('history=%s ignores an independently failed other collection', async history => {
  const test = await mount({ history, seedOtherFailure: true })
  await screen.findByText(history ? past.email : member.display_name)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(test.requests.filter(request => request.path.startsWith('/orgs/'))).toHaveLength(2)
})
it.each([true, false])('history=%s initial deferred HTTP never flashes empty or zero', async history => {
  const test = await mount({ history, deferred: true })
  await waitFor(() => expect(test.requests.some(request => request.path.startsWith('/orgs/'))).toBe(true))
  expect(screen.getByRole('status').textContent).toBe(test.t.loading)
  expect(screen.queryByText(test.t.memberEmpty)).toBeNull()
  expect(screen.queryByText(test.t.inviteHistoryEmpty)).toBeNull()
  expect(screen.queryByRole('button', { name: test.t.inviteUser })).toBeNull()
  expect(document.querySelector('[data-list-range]')).toBeNull()
  await test.release()
  await screen.findByText(history ? past.email : member.display_name)
})
it.each([
  [true, [{ id: 'staff', administrator: false }], 'staff', 2],
  [false, [{ id: 'staff', administrator: false }], 'staff', 0],
  [true, [], 'staff', 0], [true, [{ id: 'staff', administrator: false }], '', 0],
  [true, [{ id: 'staff', administrator: false }], 'missing', 0],
] as const)('empty invite grant=%s roles=%j default=%s has %s real invite actions', async (grant, roles, defaultRole, count) => {
  const test = await mount({ rows: [], grants: { 'members.read': true, 'invitations.create': grant }, roles: [...roles], defaultRole })
  await screen.findByText(test.t.memberEmpty)
  const actions = screen.queryAllByRole('button', { name: test.t.inviteUser })
  expect(actions).toHaveLength(count)
  if (count) {
    await test.user.click(actions[1])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('combobox', { name: test.t.role }).textContent).toContain('staff')
    await test.user.click(within(dialog).getByRole('button', { name: test.t.cancel }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(actions[1])
  }
})
it.each(['en', 'cs'] as const)('%s searches rendered name/email locally; no matches clears back to both identities', async language => {
  const test = await mount({ language })
  await screen.findByText(member.display_name)
  const input = screen.getByRole('searchbox', { name: test.t.search })
  fireEvent.change(input, { target: { value: 'ADA example' } })
  await waitFor(() => expect(screen.queryByRole('button', { name: test.t.clearSearch })).toBeTruthy())
  await waitFor(() => expect(screen.getAllByRole('row').filter(row => row.textContent?.includes(member.email))).toHaveLength(2))
  fireEvent.change(input, { target: { value: 'never-matches' } })
  await screen.findByText(test.t.membersS4NoMatches)
  expect(screen.queryByText(member.display_name)).toBeNull()
  const clear = screen.getAllByRole('button', { name: test.t.clearSearch })
  await test.user.click(clear.at(-1)!)
  await screen.findByText(member.display_name)
  expect((input as HTMLInputElement).value).toBe('')
  expect(test.requests.filter(request => request.path.startsWith('/orgs/'))).toHaveLength(1)
})
it.each([true, false])('history=%s failure retries precisely the displayed endpoint and retains search', async history => {
  const test = await mount({ history })
  await screen.findByText(history ? past.email : member.display_name)
  const input = screen.getByRole('searchbox', { name: test.t.search })
  fireEvent.change(input, { target: { value: history ? 'past' : 'ada' } })
  await waitFor(() => expect(screen.queryByText(history ? test.t.inviteState_revoked : test.t.memberInvited)).toBeTruthy())
  if (history) test.world.historyStatus = 500; else test.world.membersStatus = 500
  await test.refetch()
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(document.body.textContent).not.toContain('SECRET_')
  expect(screen.queryByText(history ? past.email : member.display_name)).toBeNull()
  expect(screen.queryByText(test.t.membersS4NoMatches)).toBeNull()
  if (history) test.world.historyStatus = 200; else test.world.membersStatus = 200
  await test.user.click(screen.getByRole('button', { name: test.t.memberRetry }))
  await screen.findByText(history ? past.email : member.display_name)
  expect((input as HTMLInputElement).value).toBe(history ? 'past' : 'ada')
  const identityRequests = test.requests.filter(request => request.path.startsWith('/orgs/'))
  expect(identityRequests).toHaveLength(3)
  expect(identityRequests.every(request => request.path === (history ? '/orgs/org/invitations' : '/orgs/org/members?include=pending') && request.org === 'org' && request.method === 'GET')).toBe(true)
})
it.each([true, false])('history=%s live read revocation removes cached identities and an open action', async history => {
  const test = await mount({ history })
  await screen.findByText(history ? past.email : member.display_name)
  if (!history) { await test.user.click(screen.getByRole('button', { name: test.t.inviteUser })); await screen.findByRole('dialog') }
  test.world.grants = {}
  await act(async () => { await test.client.invalidateQueries({ queryKey: ['capabilities', 'org'] }) })
  await screen.findByText(test.t.forbidden)
  expect(screen.queryByText(history ? past.email : member.display_name)).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: test.t.inviteUser })).toBeNull()
})
it.each([true, false])('history=%s collection 403 hides stale identities and management immediately', async history => {
  const test = await mount({ history })
  await screen.findByText(history ? past.email : member.display_name)
  if (history) test.world.historyStatus = 403; else test.world.membersStatus = 403
  await test.refetch()
  await screen.findByText(test.t.forbidden)
  expect(screen.queryByText(history ? past.email : member.display_name)).toBeNull()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: test.t.memberRetry })).toBeNull()
})

it.each(['en', 'cs'] as const)('%s empty history explains its scope with a back link and no create action', async language => {
  const test = await mount({ history: true, historyRows: [], language, grants: { 'invitations.read': true } })
  await screen.findByText(test.t.inviteHistoryEmpty)
  expect(screen.getByText(test.t.membersS4HistoryHelp)).toBeTruthy()
  expect(screen.getAllByRole('link', { name: test.t.memberBack }).length).toBeGreaterThan(0)
  expect(screen.queryByRole('button', { name: test.t.inviteUser })).toBeNull()
})
it('keeps last-administrator protection and separate member/invitation row IDs', async () => {
  const test = await mount({ rows: [{ ...member, user_id: 'admin', last_administrator: true }, pending] })
  await screen.findByText(member.display_name)
  expect(document.querySelectorAll('[data-row-id]')).toHaveLength(2)
  await test.user.click(screen.getByRole('button', { name: test.t.memberActions.replace('{{name}}', member.display_name) }))
  const leave = await screen.findByRole('menuitem', { name: test.t.memberLeave })
  expect(leave.getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByText(test.t.memberLastAdmin)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})
