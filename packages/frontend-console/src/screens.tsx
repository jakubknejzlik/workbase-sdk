import { Skeleton } from '@workbasehq/ui/components/ui/skeleton'
import { useCapabilities } from './api/queries'
import { Label } from '@workbasehq/ui/components/ui/label'
import { Input } from '@workbasehq/ui/components/ui/input'
import { Card, CardContent } from '@workbasehq/ui/components/ui/card'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ResourcePage, MutationSubmitButton, useMutationSubmit } from '@workbasehq/ui'
import { useInvitationDestination } from './api/invitation-destination'
import { api, ApiError, safeReturnTo } from './api/client'
import { useMe, useOrganization, useOrganizations } from './api/queries'
import { OrganizationSetup } from './organization-setup'
import { CreateOrganizationDialog } from './create-organization-dialog'
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  useEffect(() => { document.querySelector<HTMLElement>('h1')?.focus() }, [title])
  return <ResourcePage title={title} actions={actions}>{children}</ResourcePage>
}
export function Failure({ kind }: { kind: 'forbidden' | 'notFound' | 'invalidLink' | 'requestFailed' }) {
  const { t } = useTranslation()
  return <Page title={t(kind)}><p>{t(`${kind}Description`)}</p><Link to={kind === 'invalidLink' ? '/sign-in' : '/organizations'}>{t(kind === 'invalidLink' ? 'newLink' : 'organizations')}</Link></Page>
}
export function Loading() { const { t } = useTranslation(); return <p role="status">{t('loading')}</p> }
export function QueryError({ error }: { error: Error }) { return <Failure kind={error instanceof ApiError && error.status === 403 ? 'forbidden' : 'requestFailed'} /> }
export function SignIn() {
  const submit = useMutationSubmit()
  const { t } = useTranslation(); const [email, setEmail] = useState('')
  const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get('returnTo'))
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ providers: { id: string }[] }>('/auth/providers', { redirect401: false }) })
  const magic = useMutation({ mutationFn: () => api('/auth/sign-in/magic-link', { method: 'POST', body: { email, callbackURL: returnTo, errorCallbackURL: '/verify?failed=1' }, redirect401: false }), onSuccess: () => sessionStorage.setItem('console-returnTo', returnTo) })
  const oidc = useMutation({ mutationFn: () => api<{ url: string }>('/auth/sign-in/social', { method: 'POST', body: { provider: 'oidc', callbackURL: '/auth/complete' }, redirect401: false }), onSuccess: data => { sessionStorage.setItem('console-returnTo', returnTo); window.location.assign(data.url) } })
  if (magic.isSuccess) return <Page title={t('inbox')}><p>{t('inboxDescription')}</p><Link to="/sign-in" onClick={() => magic.reset()}>{t('newLink')}</Link></Page>
  return <Page title={t('signIn')}><div className="c1-card"><p>{t('signInDescription')}</p><form onSubmit={event => { event.preventDefault(); void submit(() => magic.mutateAsync()) }}>
    <Label htmlFor="email">{t('email')}</Label><Input id="email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
    <MutationSubmitButton type="submit" pending={magic.isPending} disabled={!email || oidc.isPending}>{t('sendLink')}</MutationSubmitButton>
  </form>{magic.error && <p role="alert">{t('signInFailed')}</p>}
  {providers.data?.providers.some(provider => provider.id === 'oidc') && <MutationSubmitButton variant="outline" pending={oidc.isPending} disabled={magic.isPending} onClick={() => void submit(() => oidc.mutateAsync())}>{t('oidc')}</MutationSubmitButton>}
  {(oidc.error || providers.error) && <p role="alert">{t('signInFailed')}</p>}</div></Page>
}
export function Verify() {
  const token = new URLSearchParams(window.location.search).get('token')
  const verify = useQuery({ queryKey: ['verify', token], retry: false, staleTime: Infinity, queryFn: async () => {
    if (!token) throw new Error('invalid_link')
    // Better Auth consumes the one-use token and sets its own cookie; it redirects to this
    // same-origin SPA callback, where /me (not the redirect alone) proves authentication.
    const response = await fetch('/auth/magic-link/verify?' + new URLSearchParams({ token, callbackURL: '/auth/complete', errorCallbackURL: '/verify?failed=1' }), { credentials: 'same-origin' })
    if (!response.ok || new URL(response.url).searchParams.has('error') || new URL(response.url).searchParams.has('failed')) throw new Error('invalid_link')
    await api('/me', { redirect401: false }); window.location.replace('/auth/complete'); return true
  } })
  return verify.error ? <Failure kind="invalidLink" /> : <Loading />
}
export function Complete() {
  const me = useMe()
  const destination = useInvitationDestination(sessionStorage.getItem('console-returnTo'), me.data?.memberships)
  useEffect(() => {
    if (!destination.target) return
    sessionStorage.removeItem('console-returnTo')
    window.location.replace(destination.target)
  }, [destination.target])
  return me.error || destination.error ? <QueryError error={(me.error ?? destination.error)!} /> : <Loading />
}
export function Organizations() {
  const { t } = useTranslation(); const organizations = useOrganizations(); const me = useMe()
  if (organizations.isPending) return <Loading />
  if (organizations.error) return <QueryError error={organizations.error} />
  if (!organizations.data.length) return <OrganizationSetup />
  const actions = me.data?.organizationCreationAllowed === false ? undefined : <CreateOrganizationDialog trigger={t('createOrganization')} />
  return <Page title={t('organizations')} actions={actions}><Card><CardContent>{organizations.data.length ? <ul className="c1-orgs">{organizations.data.map(org => <li key={org.organization_id}><Link to="/o/$orgId" params={{ orgId: org.organization_id }}>{org.name}</Link><span>{t(`role_${org.role}`)}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">{t('noOrganizations')}</p>}</CardContent></Card></Page>
}
const membersDestination = { to: '/o/$orgId/settings/workspace-members' } as const
export function OrganizationHome({ orgId }: { orgId: string }) {
  const { t } = useTranslation(); const org = useOrganization(orgId); const caps = useCapabilities(orgId)
  if (org.isPending) return <div role="status" aria-label={t('loading')} className="space-y-4"><Skeleton className="h-9 w-64" /><Skeleton className="h-24 w-full" /></div>
  if (org.error) return <QueryError error={org.error} />
  const membership = org.data.memberships.find(item => item.organization_id === orgId)
  if (!membership) return <Failure kind="forbidden" />
  return <Page title={membership.name}><div className="space-y-4"><h2 className="text-xl font-semibold">{t('p2Overview')}</h2><p className="text-muted-foreground">{t('p2OverviewDescription')}</p><div className="flex flex-wrap gap-4 text-sm underline"><Link to="/o/$orgId/settings/profile" params={{ orgId }}>{t('profileSettings')}</Link>{caps.data?.resources?.['members.read'] && <Link to={membersDestination.to} params={{ orgId }}>{t('members')}</Link>}</div></div></Page>
}

export { AcceptInvitation } from './accept-invitation'
