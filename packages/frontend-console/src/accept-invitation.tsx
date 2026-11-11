import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle, Clock, Users, XCircle } from 'lucide-react'
import { Button } from '@workbasehq/ui'
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@workbasehq/ui/components/ui/card'
import { Skeleton } from '@workbasehq/ui/components/ui/skeleton'
import { api, ApiError, safeReturnTo, signInLocation } from './api/client'
import { invitationClient, type AcceptedInvitation, type InvitationSelector, type InvitationSummary } from './api/invitations'
import { profileOptions, type SelfProfile } from './api/profile'
import { ProfileEditor } from './profile'

const terminalErrors: Record<string, string> = {
  invitation_expired: 'invitationExpired', invitation_revoked: 'invitationRevoked', invitation_used: 'invitationUsed',
  invitation_declined: 'p10DeclinedDescription', invitation_not_found: 'invitationInvalid', invalid_request: 'invitationInvalid',
  already_member: 'alreadyMember', account_already_assigned: 'accountAlreadyAssigned', invalid_invitation_role: 'invitationInvalid',
}

/** Source AcceptInvitationPage Card composition; P8 owns eligibility and every mutation. */
export function AcceptInvitation() {
  const { t } = useTranslation(); const client = useQueryClient()
  const [selector, setSelector] = useState<InvitationSelector | null>(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token'); const id = params.get('id')
    return token && /^[a-f0-9]{64}(?:\.[a-f0-9]{64})?$/.test(token) ? { token } : id ? { id } : null
  })
  const [summary, setSummary] = useState<InvitationSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  const [accepted, setAccepted] = useState<AcceptedInvitation | null>(null)
  const [declined, setDeclined] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const latch = useRef(false)
  const profile = useQuery({ ...profileOptions, queryFn: () => api<SelfProfile>('/me/profile', { redirect401: false }), enabled: !accepted && !declined })
  // Credentials stay only in this mounted component, never in a query/mutation key or storage.
  useEffect(() => { window.history.replaceState(null, '', '/invitation') }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setLoadError(null)
    if (!selector) { setLoading(false); return }
    invitationClient.preview(selector).then(value => { if (active) setSummary(value) }, error => { if (active) setLoadError(error) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selector, reload])
  const action = useMutation({ gcTime: 0, retry: false, mutationFn: async (kind: 'accept' | 'decline') => {
    if (!selector) throw new ApiError(404, 'invitation_not_found')
    if (kind === 'decline' && summary?.account_match === null) await invitationClient.resolve(selector)
    return kind === 'accept' ? invitationClient.accept(selector) : invitationClient.decline(selector)
  }, onSuccess: async result => {
    if ('organization_id' in result) {
      setAccepted(result); setSelector(null); client.clear()
    } else if (result.state === 'declined') {
      setDeclined(true); setSelector(null); await client.invalidateQueries({ queryKey: ['me'] })
    } else if ('organization' in result) {
      setSummary(result); setConfirmed(true)
      await client.invalidateQueries({ queryKey: profileOptions.queryKey })
    }
  } })
  const run = async (kind: 'accept' | 'decline') => {
    if (latch.current) return
    latch.current = true
    try { await action.mutateAsync(kind) } catch (error) {
      if (error instanceof ApiError && error.status === 401 && summary) window.location.assign(signInLocation(`/invitation?id=${summary.id}`))
      // Other failures use the inline recovery below.
    }
    finally { latch.current = false }
  }
  useEffect(() => {
    // Resume only the explicitly confirmed anonymous acceptance, after the profile gate.
    if (confirmed && !action.isPending && !profile.isFetching && profile.data?.completeness.complete) {
      setConfirmed(false); void run('accept')
    }
  }, [confirmed, action.isPending, profile.isFetching, profile.data])
  const logout = useMutation({ gcTime: 0, mutationFn: () => api('/auth/logout', { method: 'POST', redirect401: false }), onSuccess: async () => {
    client.clear(); action.reset(); setSummary(null); setConfirmed(false); setReload(value => value + 1)
    await client.invalidateQueries({ queryKey: profileOptions.queryKey })
  } })
  const busy = action.isPending || logout.isPending
  const error = action.error ?? loadError
  const code = error instanceof ApiError ? error.code : null
  const terminal = code && terminalErrors[code] || error instanceof ApiError && [400, 404, 410].includes(error.status) && 'invitationInvalid'
  const wrongAccount = summary?.account_match === false || code === 'invitation_not_for_this_account'
  const recover = <Button className="w-full" variant="outline" onClick={() => window.location.replace('/organizations')}>{t('p10GoHome')}</Button>
  const shell = (title: string, icon: ReactNode, content: ReactNode, footer: ReactNode) => <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
    <Card className="w-full max-w-md">
      <CardHeader className="text-center"><div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10" aria-hidden="true">{icon}</div><h1 tabIndex={-1} className="text-2xl font-semibold">{title}</h1></CardHeader>
      <CardContent className="space-y-4">{content}</CardContent>{footer && <CardFooter className="flex gap-2">{footer}</CardFooter>}
    </Card>
  </div>
  const organization = summary?.organization.name ?? t('p10OrganizationUnavailable')
  const alreadyMember = code === 'already_member'
  const memberOrganization = error instanceof ApiError ? (error.details as { detail?: { organization_id?: string } } | undefined)?.detail?.organization_id : undefined
  const entryOrganization = summary?.organization.id ?? memberOrganization
  const entryTarget = accepted?.entry_target ?? (entryOrganization ? `/o/${encodeURIComponent(entryOrganization)}` : null)
  const usedByAccount = summary?.account_match === true && (summary.state === 'accepted' || code === 'invitation_used')
  if (accepted || alreadyMember || usedByAccount) return shell(t(alreadyMember ? 'p10AlreadyMemberTitle' : 'p10JoinedTitle'), <CheckCircle className="h-6 w-6 text-green-600" />, <>{summary && <p className="font-medium break-words">{organization}</p>}<p className="text-sm text-muted-foreground">{t(alreadyMember ? 'p10AlreadyMemberDescription' : 'p10JoinedDescription')}</p></>, entryTarget ? <Button className="w-full" onClick={() => window.location.replace(safeReturnTo(entryTarget))}>{t('p10GoToOrganization')}</Button> : recover)
  if (declined || summary?.state === 'declined') return shell(t('p10DeclinedTitle'), <XCircle className="h-6 w-6" />, <p className="text-sm text-muted-foreground">{t('p10DeclinedDescription')}</p>, recover)
  if (loading || profile.isPending) return <div role="status" aria-label={t('p10LoadingInvitation')} className="min-h-screen flex items-center justify-center p-4"><Card className="w-full max-w-md"><CardHeader><Skeleton className="mx-auto h-8 w-3/4" /><Skeleton className="h-4 w-full" /></CardHeader><CardContent><Skeleton className="h-20 w-full" /></CardContent></Card></div>
  const stateError = summary && summary.state !== 'pending' ? ({ expired: 'invitationExpired', revoked: 'invitationRevoked', accepted: 'invitationUsed' } as Record<string, string>)[summary.state] : null
  if (!selector || terminal || stateError) return shell(t('p10UnavailableTitle'), summary?.state === 'expired' ? <Clock className="h-6 w-6" /> : <XCircle className="h-6 w-6 text-destructive" />, <p role="alert" className="text-sm text-muted-foreground">{t(terminal || stateError || 'invitationInvalid')}</p>, recover)
  if (!summary || (profile.error && !(profile.error instanceof ApiError && profile.error.status === 401))) return shell(t('p10UnavailableTitle'), <AlertTriangle className="h-6 w-6" />, <p role="alert">{t('requestFailed')}</p>, <Button className="w-full" onClick={() => { void profile.refetch(); setReload(value => value + 1) }}>{t('p10Retry')}</Button>)
  if (!wrongAccount && profile.data && !profile.data.completeness.complete) return <ProfileEditor profile={profile.data} setup />
  return shell(t('acceptInvitation'), <Users className="h-6 w-6 text-foreground" />, <>
    <CardDescription className="text-center">{t('p10PreviewDescription')}</CardDescription>
    {wrongAccount && <div role="alert" className="space-y-2 rounded-lg border border-destructive p-4 text-sm text-destructive"><p className="font-medium">{t('p10WrongAccountTitle')}</p><p>{t('p10WrongAccountDescription')}</p>{profile.data && <p className="break-all">{profile.data.email}</p>}<Button variant="outline" disabled={busy} onClick={() => logout.mutate()}>{t('p10SwitchAccount')}</Button></div>}
    <dl className="space-y-2 rounded-lg border p-4 text-sm">{[[t('p10Organization'), organization], [t('p10InvitedBy'), summary.inviter.display_name ?? t('p10InviterUnavailable')], [t('role'), t(`role_${summary.role}`, { defaultValue: summary.role })]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right font-medium">{value}</dd></div>)}</dl>
    {summary.target && <p>{t('rowInvitationTarget', { entity: t(`entitySingular_${summary.target.entity}`, { defaultValue: summary.target.entity }), row: summary.target.row })}</p>}
    {summary.account_match === null && <p className="text-sm text-muted-foreground">{t('p10AnonymousDescription')}</p>}
    {(action.error || logout.error) && !wrongAccount && <p role="alert" className="text-sm text-destructive">{t('p10ActionFailed')}</p>}
    {logout.error && wrongAccount && <p role="alert">{t('requestFailed')}</p>}
  </>, wrongAccount ? null : <><Button className="flex-1" variant="outline" disabled={busy} onClick={() => void run('decline')}>{t(action.isPending && action.variables === 'decline' ? 'p10Declining' : 'p10Decline')}</Button><Button className="flex-1" disabled={busy || confirmed} onClick={() => void run('accept')}>{t(action.isPending && action.variables === 'accept' || confirmed ? 'p10Accepting' : 'acceptInvitation')}</Button></>)
}
