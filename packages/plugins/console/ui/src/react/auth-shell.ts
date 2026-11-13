declare const location: { pathname: string; search: string; replace(path: string): void }
declare const history: { replaceState(state: unknown, unused: string, url: string): void }
declare const window: { addEventListener(event: string, listener: () => void): void; removeEventListener(event: string, listener: () => void): void }
import { createElement as h, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Manifest } from '../check'
import { initI18n, type I18n } from '../i18n'
import { ApiFailure, type ClientRequestInit } from '../client'
import { LanguageSwitcher, useRuntime } from './index'
import { Session, type SessionState } from './session'
import { AuthDirtyContext, useAuthDirty } from './auth-dirty'
import { browserBuild } from '../build-reload'
import { authStorage } from '../auth-storage'
/** Only concrete built routes and the recipient inbox destination are admissible. */
export function authReturnTo(raw: string | null, routes: Manifest['routes']): string {
  if (!raw || !raw.startsWith('/') || /[\\%#\u0000-\u0020\u007f]/.test(raw) || raw.startsWith('//')) return '/'
  if (/^\/invitation\?id=[A-Za-z0-9_-]+$/.test(raw)) return raw
  if (raw.includes('?')) return '/'
  const parts = raw.split('/')
  return routes.some(route => {
    const pattern = route.path.split('/')
    return parts.length === pattern.length && pattern.every((part, i) => part.startsWith('$') ? /^[A-Za-z0-9_-]+$/.test(parts[i]) : part === parts[i])
  }) ? raw : '/'
}
/** Call once in the host entry, before rendering authored translations. */
export function createAuthI18n(options: Omit<Parameters<typeof initI18n>[0], 'profile'>): I18n {
  return initI18n({ ...options, profile: { language: authStorage.language.read() } })
}
type Transport = (url: string, init: ClientRequestInit) => Promise<Response>
type Request = <T>(path: string, body?: object, method?: string) => Promise<T>
function requestWith(transport: Transport): Request {
  return async <T,>(path: string, body?: object, method = 'POST') => {
    const init = { method: body === undefined ? 'GET' : method, credentials: 'same-origin' as const, cache: 'no-store' as const, referrerPolicy: 'no-referrer' as const,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    const response = await transport(path, init)
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: string }
      throw new ApiFailure(response.status, value.error ?? 'auth')
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  }
}
type Entry = { key: string; path: string; token?: string; id?: string }
function entry(): Entry {
  const path = location.pathname, key = crypto.randomUUID()
  if (path !== '/invitation') return { path, key }
  const query = new URLSearchParams(location.search), token = query.get('token') ?? undefined, id = query.get('id') ?? undefined
  // Never retain history.state: routers may have copied the original URL into it.
  history.replaceState(null, '', '/invitation')
  return { path, key, token, id: id && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined }
}
type Membership = { organization_id: string; organization_name?: string }
type Me = { actor: { id: string }; memberships: Membership[] }
type Invitation = { id: string; state: string; account_match: boolean | null; next?: string; navigation_target?: string }
type Profile = { firstName: string | null; lastName: string | null; capabilities: { canEditNames: boolean }; completeness: { complete: boolean } }
type Auth = { request: Request; i18n: I18n; signOut: () => Promise<void> }
function status(i18n: I18n, key: string) { return h('p', { role: 'status' }, i18n.t('sdk:auth.' + key)) }
function SignIn({ auth, returnTo }: { auth: Auth; returnTo: string }) {
  const [email, setEmail] = useState(''), [sent, setSent] = useState(false), pending = useRef(false)
  useAuthDirty(!sent && !!email)
  async function submit() {
    if (pending.current) return
    pending.current = true; authStorage.returnTo.write(returnTo)
    try { await auth.request('/auth/sign-in/magic-link', { email, callbackURL: '/auth/complete' }) } catch { /* Deliberately indistinguishable. */ }
    finally { pending.current = false; setSent(true) }
  }
  return sent ? status(auth.i18n, 'checkMail') : h('form', { onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void submit() } },
    h('label', null, auth.i18n.t('sdk:auth.email'), h('input', { type: 'email', required: true, value: email, onChange: (event: { target: { value: string } }) => setEmail(event.target.value) })),
    h('button', { type: 'submit' }, auth.i18n.t('sdk:auth.signIn')))
}
function Logout({ auth }: { auth: Auth }) { return h('button', { type: 'button', onClick: () => { void auth.signOut() } }, auth.i18n.t('sdk:auth.signOut')) }
/** Completeness belongs exclusively to the profile response. No navigation occurs here. */
function ProfileGate({ auth, required = false, children }: { auth: Auth; required?: boolean; children?: ReactNode }) {
  const [profile, setProfile] = useState<Profile>(), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0)
  const [firstName, setFirst] = useState(''), [lastName, setLast] = useState(''), [saving, setSaving] = useState(false), busy = useRef(false)
  useEffect(() => {
    let active = true
    void auth.request<Profile>('/me/profile').then(value => { if (active) { setProfile(value); setFirst(value.firstName ?? ''); setLast(value.lastName ?? '') } }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [auth.request, attempt])
  useAuthDirty(!!profile && !profile.completeness.complete && profile.capabilities.canEditNames && (firstName !== (profile.firstName ?? '') || lastName !== (profile.lastName ?? '')))
  async function submit() {
    if (busy.current) return
    busy.current = true; setSaving(true); setFailed(false)
    try { setProfile(await auth.request<Profile>('/me/profile', { firstName, lastName }, 'PATCH')) }
    catch { setFailed(true) }
    finally { busy.current = false; setSaving(false) }
  }
  if (profile?.completeness.complete || !profile && failed && !required) return children
  if (!profile) return h('div', null, status(auth.i18n, failed ? 'profileFailed' : 'loading'), failed && h('button', { type: 'button', onClick: () => { setFailed(false); setAttempt(value => value + 1) } }, auth.i18n.t('sdk:retry')))
  if (!profile.capabilities.canEditNames) return h('div', null, status(auth.i18n, 'idpNames'), h(Logout, { auth }))
  return h('form', { onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void submit() } }, status(auth.i18n, 'profileRequired'),
    ...(['firstName', 'lastName'] as const).map(name => h('label', { key: name }, auth.i18n.t('sdk:auth.' + name), h('input', { required: true, value: name === 'firstName' ? firstName : lastName, onChange: (event: { target: { value: string } }) => (name === 'firstName' ? setFirst : setLast)(event.target.value) }))),
    failed && status(auth.i18n, 'profileFailed'), h('button', { type: 'submit', disabled: saving }, auth.i18n.t('sdk:save')), h(Logout, { auth }))
}
function ActorGate({ auth, children }: { auth: Auth; children?: ReactNode }) {
  const { identity } = useRuntime()
  return h(ProfileGate, { key: identity.actorId, auth }, children)
}
function InvitationFlow({ auth, initial, go, select }: { auth: Auth; initial: Entry; go: (path: string) => Promise<void>; select: (org: string) => void }) {
  const [invitation, setInvitation] = useState<Invitation>(), [resolved, setResolved] = useState(false), [login, setLogin] = useState(false), [failure, setFailure] = useState<string>()
  const [pending, setPending] = useState(false), busy = useRef(false)
  const mismatch = invitation?.account_match === false || failure === 'invitation_not_for_this_account'
  const fail = (error: unknown) => setFailure(error instanceof ApiFailure ? error.code : 'failed')
  useEffect(() => {
    let active = true
    const path = initial.token ? '/invitations/preflight' : initial.id ? '/invitations/' + encodeURIComponent(initial.id) + '/resolve' : undefined
    if (!path) { setFailure('invitation_not_found'); return }
    void auth.request<Invitation>(path, initial.token ? { token: initial.token } : {}).then(value => { if (active) { setInvitation(value); setResolved(!initial.token) } }, error => { if (active) { if (error instanceof ApiFailure && error.status === 401) setLogin(true); else fail(error) } })
    return () => { active = false }
  }, [auth.request, initial])
  async function resolve() {
    if (busy.current) return
    busy.current = true; setPending(true)
    try { setInvitation(await auth.request<Invitation>('/invitations/resolve', { token: initial.token })); setResolved(true) }
    catch (error) { if (error instanceof ApiFailure && error.status === 401) setLogin(true); else fail(error) }
    finally { busy.current = false; setPending(false) }
  }
  async function accept() {
    if (busy.current || !invitation) return
    busy.current = true; setPending(true)
    try {
      const result = await auth.request<{ organization_id: string }>('/invitations/' + encodeURIComponent(invitation.id) + '/accept', {})
      select(result.organization_id); await go('/')
    } catch (error) { fail(error) }
    finally { busy.current = false; setPending(false) }
  }
  if (mismatch) return h('div', null, status(auth.i18n, 'mismatch'), h(Logout, { auth }))
  if (login) return h(SignIn, { auth, returnTo: invitation ? '/invitation?id=' + encodeURIComponent(invitation.id) : initial.id ? '/invitation?id=' + initial.id : '/' })
  const terminal = failure || invitation && invitation.state !== 'pending'
  if (terminal) return status(auth.i18n, /expired/.test(String(terminal)) || invitation?.state === 'expired' ? 'expired' : /revoked/.test(String(terminal)) || invitation?.state === 'revoked' ? 'revoked' : 'invitationUnavailable')
  if (!invitation) return status(auth.i18n, 'loading')
  if (!resolved) return h('button', { type: 'button', disabled: pending, onClick: () => { void resolve() } }, auth.i18n.t('sdk:auth.continue'))
  const acceptButton = h('button', { type: 'button', disabled: pending, onClick: () => { void accept() } }, auth.i18n.t('sdk:auth.accept'))
  return h(ProfileGate, { auth, required: true }, acceptButton)
}
export type AuthShellProps = { manifest: Manifest; i18n: I18n; children?: ReactNode; fetch?: Transport; navigate: (path: string) => void | Promise<unknown> }
/** Mount outside RouterProvider so reserved auth paths never mount Instance data. */
export function AuthShell({ manifest, i18n, children, fetch: transport = globalThis.fetch, navigate }: AuthShellProps) {
  const [initial, setEntry] = useState(entry), [org, setOrg] = useState(() => authStorage.org.read()), [memberships, setMemberships] = useState<Membership[]>(), [inbox, setInbox] = useState<Invitation[]>(), [failed, setFailed] = useState(false), [retry, setRetry] = useState(0)
  const logoutBusy = useRef(false), drafts = useRef(new Set<symbol>()), watcher = useRef<ReturnType<typeof browserBuild> | null>(null)
  const reportDirty = useCallback((owner: symbol, dirty: boolean) => { if (dirty) drafts.current.add(owner); else drafts.current.delete(owner); watcher.current?.flush() }, [])
  useEffect(() => { const current = browserBuild(transport, () => drafts.current.size > 0); watcher.current = current; return () => { current.stop(); watcher.current = null } }, [transport])
  const request = useCallback(requestWith(transport), [transport])
  useSyncExternalStore(i18n.subscribe, i18n.language, i18n.language)
  useEffect(() => i18n.subscribe(() => authStorage.language.write(i18n.language())), [i18n])
  useEffect(() => { const change = () => setEntry(entry()); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change) }, [])
  const go = useCallback(async (path: string) => { await navigate(path); setEntry(entry()) }, [navigate])
  const select = (id: string) => { authStorage.org.write(id); setOrg(id) }
  const signOut = async () => {
    if (logoutBusy.current) return
    logoutBusy.current = true
    try { await request('/auth/logout', {}) }
    catch (error) { if (!(error instanceof ApiFailure && error.status === 401)) { setFailed(true); logoutBusy.current = false; return } }
    authStorage.org.write(); authStorage.returnTo.write(); location.replace('/sign-in')
  }
  const auth = { request, i18n, signOut }
  const sessionState = useCallback((kind: SessionState['kind']) => {
    if (kind === 'unauthenticated') { authStorage.returnTo.write(authReturnTo(location.pathname + location.search, manifest.routes)); void go('/sign-in') }
    if (kind === 'removed') { authStorage.org.write(); setOrg(null); setMemberships(undefined); setRetry(value => value + 1) }
  }, [go, manifest.routes])
  useEffect(() => {
    if (initial.path === '/sign-in' || initial.path === '/invitation' || org && initial.path !== '/auth/complete') return
    let active = true
    void (async () => {
      try {
        const me = await request<Me>('/me')
        if (!active) return
        if (initial.path === '/auth/complete') {
          const stored = authStorage.returnTo.read(); authStorage.returnTo.write()
          if (stored !== null) { await go(authReturnTo(stored, manifest.routes)); return }
          if (!me.memberships.length) {
            const invitations = await request<{ data: Invitation[] }>('/me/invitations')
            if (active) await go(authReturnTo(invitations.data[0]?.navigation_target ?? '/', manifest.routes))
          } else await go('/')
          return
        }
        setMemberships(me.memberships)
        if (me.memberships.length === 1) select(me.memberships[0].organization_id)
        else if (!me.memberships.length) { const invitations = await request<{ data: Invitation[] }>('/me/invitations'); if (active) setInbox(invitations.data) }
      } catch (error) { if (active) { if (error instanceof ApiFailure && error.status === 401) sessionState('unauthenticated'); else setFailed(true) } }
    })()
    return () => { active = false }
  }, [request, initial.path, org, retry, go, manifest.routes, sessionState])
  let content: ReactNode
  if (initial.path === '/sign-in') content = h(SignIn, { auth, returnTo: authReturnTo(authStorage.returnTo.read(), manifest.routes) })
  else if (initial.path === '/invitation') content = h(InvitationFlow, { key: initial.key, auth, initial, go, select })
  else if (initial.path === '/auth/complete') content = status(i18n, 'loading')
  else if (org) content = h(Session, { orgId: org, t: i18n.t, i18n, fetch: transport, onState: sessionState }, h(ActorGate, { auth }, children))
  else if (memberships?.length) content = h('div', null, status(i18n, 'chooseOrg'), ...memberships.map(value => h('button', { key: value.organization_id, type: 'button', onClick: () => select(value.organization_id) }, value.organization_name ?? value.organization_id)))
  else if (inbox) content = h('div', null, status(i18n, inbox.length ? 'invitations' : 'noInvitations'), ...inbox.map(value => h('button', { key: value.id, type: 'button', onClick: () => { void go(authReturnTo(value.navigation_target ?? '/', manifest.routes)) } }, i18n.t('sdk:auth.openInvitation'))))
  else content = status(i18n, 'loading')
  return h(AuthDirtyContext.Provider, { value: reportDirty }, h('div', null, h(LanguageSwitcher, { i18n }), h(Logout, { auth }), failed && h('div', null, status(i18n, 'failed'), h('button', { type: 'button', onClick: () => { setFailed(false); setRetry(value => value + 1) } }, i18n.t('sdk:retry'))), content))
}
