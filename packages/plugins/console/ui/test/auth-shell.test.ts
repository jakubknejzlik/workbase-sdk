declare const history: { state: unknown; pushState(state: unknown, unused: string, url: string): void; replaceState(state: unknown, unused: string, url: string): void }
declare const location: { pathname: string; search: string }
declare const window: { location: typeof location; localStorage: Storage; sessionStorage: Storage; dispatchEvent(event: Event): void }
// @vitest-environment jsdom
import { createElement as h, StrictMode, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { AuthShell, authReturnTo, createAuthI18n, Session, useRuntime } from '../src/react'
import type { Manifest } from '../src/check'
import type { ClientRequestInit } from '../src/client'
import { grants } from './grants'
const manifest = { routes: [{ path: '/workers' }, { path: '/workers/$workerId/edit' }] } as Manifest
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const me = { actor: { id: 'A' }, memberships: [{ organization_id: 'one' }] }
const complete = { completeness: { complete: true }, capabilities: { canEditNames: true } }
const invitation = { id: 'invite-A', state: 'pending', account_match: null }
const navigate = vi.fn(async (path: string) => { history.pushState(null, '', path) })
const originalLocation = window.location
const replace = vi.fn()
function view(fetch: (path: string, init: ClientRequestInit) => Promise<Response>, strict = false, children: ReactNode = h('p', null, 'APP')) {
  const i18n = createAuthI18n({ languages: ['en', 'cs'], catalogs: {} })
  const transport = (path: string, init: ClientRequestInit) => path === '/build.json' ? Promise.resolve(json({ sha: 'unbuilt' })) : fetch(path, init)
  const content = h(AuthShell, { manifest, i18n, fetch: transport, navigate }, children)
  return { i18n, element: strict ? h(StrictMode, null, content) : content }
}
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: (key: string) => { values.delete(key) }, clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } } }
beforeEach(() => { vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage()) })
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); navigate.mockClear(); replace.mockReset() })
test.each(['//evil', '/\\evil', '%2f%2f', '/%2f%2fevil', 'https:', '/workers\n', '/workers?next=//evil', '/invitation?token=secret', '/invitation?id=x&next=x', '/absent', '/workers/%5c/edit'])('open redirect rejected: %s', raw => {
  expect(authReturnTo(raw, manifest.routes)).toBe('/')
})
test.each(['/workers', '/workers/abc-1/edit', '/invitation?id=invite-A'])('built allowlist accepts %s', raw => { expect(authReturnTo(raw, manifest.routes)).toBe(raw) })
test.each([200, 400, 429, 500, 0])('sign-in outcome %s has identical copy and fixed callback', async code => {
  history.replaceState(null, '', '/sign-in')
  const fetch = vi.fn(async () => { if (!code) throw new TypeError('offline'); return json({}, code) })
  render(view(fetch).element)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } }); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(await screen.findByText('Check your mail')).toBeTruthy()
  expect(fetch.mock.calls).toHaveLength(1)
  const [path, init] = (fetch.mock.calls as unknown as [string, ClientRequestInit][])[0]
  expect(path).toBe('/auth/sign-in/magic-link'); expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.test', callbackURL: '/auth/complete' })
})
test.each(['//evil', '/workers', '/invitation?id=invite-A'])('callback consumes and validates returnTo %s', async target => {
  history.replaceState(null, '', '/auth/complete'); sessionStorage.setItem('workbase.returnTo', target)
  const fetch = vi.fn(async () => json(me)); render(view(fetch).element)
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(target === '//evil' ? '/' : target))
  expect(sessionStorage.getItem('workbase.returnTo')).toBeNull()
})
test('callback without memberships uses the invitation inbox', async () => {
  history.replaceState(null, '', '/auth/complete')
  const fetch = vi.fn(async (path: string) => json(path === '/me' ? { ...me, memberships: [] } : { data: [{ navigation_target: '/invitation?id=invite-A' }] }))
  render(view(fetch).element); await waitFor(() => expect(navigate).toHaveBeenCalledWith('/invitation?id=invite-A'))
  expect(fetch.mock.calls.slice(0, 2).map(([path]) => path)).toEqual(['/me', '/me/invitations'])
})
test('token is scrubbed synchronously; only POST bodies carry it; anonymous resolution requires a click', async () => {
  const token = 'sensitive-invitation-token'; history.replaceState({ oldURL: token }, '', '/invitation?token=' + token)
  const consoleError = vi.spyOn(console, 'error'), consoleLog = vi.spyOn(console, 'log')
  const fetch = vi.fn(async (path: string, _init: ClientRequestInit) => json(path === '/invitations/preflight' ? invitation : { error: 'unauthenticated' }, path === '/invitations/preflight' ? 200 : 401))
  render(view(fetch, true).element)
  expect(location.pathname + location.search).toBe('/invitation'); expect(history.state).toBeNull()
  await screen.findByText('Continue'); expect(fetch.mock.calls.every(([path]) => path === '/invitations/preflight')).toBe(true)
  fireEvent.click(screen.getByText('Continue')); await screen.findByLabelText('Email')
  for (const [path, init] of fetch.mock.calls) { expect(path).not.toContain(token); expect(init.method).toBe('POST'); expect((init as ClientRequestInit & { referrerPolicy: string }).referrerPolicy).toBe('no-referrer'); expect(JSON.parse(String(init.body))).toEqual({ token }) }
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(token)
  expect(JSON.stringify([...consoleError.mock.calls, ...consoleLog.mock.calls])).not.toContain(token)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } }); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByText('Check your mail'); expect(sessionStorage.getItem('workbase.returnTo')).toBe('/invitation?id=invite-A')
})
test('mismatch hides email and offers sign-out', async () => {
  history.replaceState(null, '', '/invitation?token=secret')
  render(view(async () => json({ ...invitation, account_match: false, email: 'DO-NOT-SHOW@example.test' })).element)
  await screen.findByText('This invitation belongs to another account'); expect(screen.queryByText(/DO-NOT-SHOW/)).toBeNull(); expect(screen.getAllByRole('button', { name: 'Sign out' }).length).toBeGreaterThan(0)
})
test.each(['expired', 'revoked'])('invitation %s is terminal', async state => {
  history.replaceState(null, '', '/invitation?token=secret')
  const fetch = vi.fn(async () => json({ ...invitation, state })); render(view(fetch).element)
  await screen.findByText(state === 'expired' ? 'Invitation expired' : 'Invitation revoked'); expect(screen.queryByText('Continue')).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1)
})
test('resolved invitation gates profile, accepts once, stores org and ignores legacy entry_target', async () => {
  history.replaceState(null, '', '/invitation?id=invite-A')
  const fetch = vi.fn(async (path: string) => json(path.endsWith('/resolve') ? { ...invitation, account_match: true, next: 'profile' } : path.endsWith('/accept') ? { organization_id: 'one', entry_target: '//evil' } : complete))
  render(view(fetch).element); fireEvent.click(await screen.findByText('Accept invitation'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/')); expect(localStorage.getItem('workbase:org')).toBe('one')
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(1)
})
function appFetch(profile: object | number) { return vi.fn(async (path: string, init: ClientRequestInit) => json(path === '/me' ? me : path.endsWith('/capabilities') ? grants({}) : typeof profile === 'number' ? {} : init.method === 'PATCH' ? complete : profile, path === '/me/profile' && typeof profile === 'number' ? profile : 200)) }
test('one membership selects itself and profile 500 leaves shell usable', async () => {
  const fetch = appFetch(500); render(view(fetch).element); await screen.findByText('APP')
  expect(localStorage.getItem('workbase:org')).toBe('one'); expect(navigate).not.toHaveBeenCalled()
})
test('IdP incomplete profile has zero navigations and no PATCH', async () => {
  localStorage.setItem('workbase:org', 'one')
  const fetch = appFetch({ ...complete, completeness: { complete: false }, capabilities: { canEditNames: false } }); render(view(fetch).element)
  await screen.findByText('Your identity provider must complete your name'); expect(screen.queryByText('APP')).toBeNull(); expect(navigate).not.toHaveBeenCalled(); expect(fetch.mock.calls.some(([, init]) => init.method === 'PATCH')).toBe(false)
})
test('profile submit sends at most one PATCH and mounts children from completeness', async () => {
  localStorage.setItem('workbase:org', 'one')
  const fetch = appFetch({ ...complete, completeness: { complete: false }, firstName: null, lastName: null }); render(view(fetch).element)
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'A' } }); fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'B' } })
  const save = screen.getByRole('button', { name: 'Save' }); fireEvent.click(save); fireEvent.click(save)
  await screen.findByText('APP'); expect(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1); expect(navigate).not.toHaveBeenCalled()
})
test('several memberships offer chooser, none offers inbox', async () => {
  const fetch = vi.fn(async (path: string) => json(path === '/me' ? { ...me, memberships: [{ organization_id: 'one' }, { organization_id: 'two' }] } : complete))
  const mounted = render(view(fetch).element); await screen.findByText('Choose workspace'); expect(screen.queryByText('APP')).toBeNull(); mounted.unmount()
  render(view(async path => json(path === '/me' ? { ...me, memberships: [] } : { data: [] })).element)
  await screen.findByText('No pending invitations')
})
test('language choice persists through a fresh runtime before sign-in', async () => {
  history.replaceState(null, '', '/sign-in')
  const { i18n, element } = view(async () => json({})); render(element)
  await act(async () => i18n.changeLanguage('cs')); expect(localStorage.getItem('workbase:language')).toBe('cs'); expect(createAuthI18n({ languages: ['en', 'cs'], catalogs: {} }).language()).toBe('cs')
})
test.each([204, 401])('sign-out %s is JSON POST, clears org, replaces location', async status => {
  vi.stubGlobal('location', { get pathname() { return originalLocation.pathname }, get search() { return originalLocation.search }, replace })
  history.replaceState(null, '', '/sign-in'); localStorage.setItem('workbase:org', 'one')
  const fetch = vi.fn(async (_path: string, _init: ClientRequestInit) => status === 204 ? new Response(null, { status }) : json({ error: 'unauthenticated' }, status)); render(view(fetch).element)
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'))
  expect(localStorage.getItem('workbase:org')).toBeNull(); const [path, init] = fetch.mock.calls[0]; expect(path).toBe('/auth/logout'); expect(init.method).toBe('POST'); expect(init.body).toBe('{}'); expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
})
test('Session optional onState observes existing states', async () => {
  const onState = vi.fn(); render(h(Session, { orgId: 'one', t: key => key, onState, fetch: async () => json({}, 401) }))
  await waitFor(() => expect(onState).toHaveBeenCalledWith('unauthenticated')); expect(onState).toHaveBeenCalledWith('loading')
})

function transition(type: 'pagehide' | 'pageshow', persisted: boolean) {
  window.dispatchEvent(Object.assign(new Event(type), { persisted }))
}
test.each([false, true])('pagehide synchronously removes the private subtree before history can save it (persisted: %s)', async persisted => {
  localStorage.setItem('workbase:org', 'one')
  render(view(appFetch(complete)).element); await screen.findByText('APP')
  act(() => {
    transition('pagehide', persisted)
    expect(screen.queryByText('APP')).toBeNull()
    expect(screen.getByRole('status')).toBe(screen.getByText('Loading…'))
  })
})
test.each([false, true])('persisted pageshow boots afresh before rendering the current account (signed out: %s)', async signedOut => {
  vi.stubGlobal('location', { get pathname() { return originalLocation.pathname }, get search() { return originalLocation.search }, replace })
  localStorage.setItem('workbase:org', 'one')
  let restored = false, releaseMe!: (response: Response) => void, releaseCaps!: (response: Response) => void
  const nextMe = new Promise<Response>(resolve => { releaseMe = resolve }), nextCaps = new Promise<Response>(resolve => { releaseCaps = resolve })
  const fetch = vi.fn(async (path: string) => {
    if (path === '/me') return restored ? nextMe : json(me)
    if (path.endsWith('/capabilities')) return restored ? nextCaps : json(grants({}))
    return json(complete)
  })
  function Account() { return h('p', null, 'Account ' + useRuntime().identity.actorId) }
  render(view(fetch, false, h(Account)).element); await screen.findByText('Account A')
  restored = true
  // Exercise persisted pageshow directly as well as the pagehide path above.
  act(() => {
    transition('pageshow', true)
    expect(screen.queryByText('Account A')).toBeNull()
    expect(screen.getByRole('status')).toBe(screen.getByText('Loading…'))
  })
  await waitFor(() => expect(fetch.mock.calls.filter(([path]) => path === '/me')).toHaveLength(2))
  await act(async () => { releaseMe(signedOut ? json({}, 401) : json({ ...me, actor: { id: 'B' } })) })
  expect(screen.queryByText('Account A')).toBeNull()
  expect(screen.queryByText('Account B')).toBeNull()
  if (signedOut) await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'))
  else {
    await act(async () => { releaseCaps(json(grants({}))) })
    await screen.findByText('Account B')
    expect(navigate).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  }
})
test.each([204, 401])('sign-out %s removes private DOM before replacing the document', async code => {
  vi.stubGlobal('location', { get pathname() { return originalLocation.pathname }, get search() { return originalLocation.search }, replace })
  localStorage.setItem('workbase:org', 'one')
  const fetch = appFetch(complete)
  render(view(async (path, init) => path === '/auth/logout' ? code === 204 ? new Response(null, { status: code }) : json({}, code) : fetch(path, init)).element)
  await screen.findByText('APP')
  let privateAtNavigation = true
  replace.mockImplementation(() => { privateAtNavigation = !!screen.queryByText('APP') })
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'))
  expect(privateAtNavigation).toBe(false)
  expect(screen.queryByText('APP')).toBeNull()
})
test('ordinary pageshow leaves the current boot intact', async () => {
  localStorage.setItem('workbase:org', 'one')
  const fetch = appFetch(complete)
  render(view(fetch).element); await screen.findByText('APP')
  act(() => transition('pageshow', false))
  expect(screen.getByText('APP')).toBeTruthy()
  expect(fetch.mock.calls.filter(([path]) => path === '/me')).toHaveLength(1)
})
