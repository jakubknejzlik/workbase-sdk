import { authDestination } from './api/auth-destination'
import { meOptions } from './api/queries'
import { useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Mail, Shield, UserPlus, UserCheck, Clock, MoreHorizontal, Copy, Send, Trash2, LogOut, Pencil, RefreshCw } from 'lucide-react'
import { WorkspaceMembers, WorkspaceMembersTable, InviteUserModal, FormDialog, ConfirmDialog, MutationSession, Form, FormFieldInput, FormFieldWrapper, MutationErrorAlert, Button, useMutationForm, useMutationLabels, useMutationSession, useMutationSubmit } from '@workbasehq/ui'
import { Badge } from '@workbasehq/ui/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workbasehq/ui/components/ui/table'
import { Input } from '@workbasehq/ui/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@workbasehq/ui/components/ui/select'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@workbasehq/ui/components/ui/dropdown-menu'
import { identityClient, identityKey, useIdentityAction, type Member, type Invitation, type RoleOption } from './api/identity'
import { useCapabilities, useOrganization } from './api/queries'
import { ApiError } from './api/client'
import { Failure, QueryError } from './screens'

const membersRoute = { to: '/o/$orgId/settings/workspace-members' as const }
type Row = Member | Invitation
type Action = { kind: 'invite' } | { kind: 'role' | 'remove' | 'leave'; row: Member } | { kind: 'copy' | 'resend' | 'cancel' | 'delivery'; row: Invitation }
export const invitationState = (row: Invitation) => row.accepted_at ? 'accepted' : row.revoked_at ? 'revoked' : row.declined_at ? 'declined' : row.expired_at || Date.parse(row.expires_at) <= Date.now() ? 'expired' : 'pending'
const memberRow = (row: Row): row is Member => 'user_id' in row
const rowName = (row: Row) => memberRow(row) ? row.display_name || row.email : row.email
export function memberError(error: Error | null) {
  if (error instanceof ApiError) {
    if (error.code === 'invitation_pending') return 'inviteDuplicate'
    if (error.code === 'already_member') return 'inviteAlreadyMember'
    if (error.code === 'last_owner') return 'memberLastAdmin'
    if (error.status === 409) return 'memberConflict'
    if (error.status === 403) return 'memberDenied'
    if (error.status === 400 || error.status === 422) return 'inviteInvalid'
  }
  return 'memberFailed'
}
function useMemberRefresh(orgId: string) {
  const client = useQueryClient()
  return async () => {
    client.removeQueries({ queryKey: ['bootstrap'], type: 'inactive' })
    void client.invalidateQueries({ queryKey: ['bootstrap'], refetchType: 'none' })
    await Promise.all([client.invalidateQueries({ queryKey: identityKey(orgId) }), client.invalidateQueries({ queryKey: ['me'] }), client.invalidateQueries({ queryKey: ['organization', orgId] }), client.invalidateQueries({ queryKey: ['capabilities', orgId] })])
  }
}
export function MembersScreen({ orgId, history = false }: { orgId: string; history?: boolean }) {
  const { t, i18n } = useTranslation(); const scope = useOrganization(orgId); const caps = useCapabilities(orgId)
  const grants = caps.error ? {} : caps.data?.resources ?? {}
  const enabled = !!scope.data && !scope.error && !!grants['members.read']
  const members = useQuery({ queryKey: [...identityKey(orgId, scope.data?.role), 'combined'], queryFn: () => identityClient.combined(orgId), enabled, staleTime: 0 })
  const invitations = useQuery({ queryKey: [...identityKey(orgId, scope.data?.role), 'invitations'], queryFn: () => identityClient.list(orgId, 'invitations'), enabled: !!scope.data && !scope.error && history && !!grants['invitations.read'], staleTime: 0 })
  const [action, setAction] = useState<Action>(); const trigger = useRef<HTMLButtonElement | null>(null)
  if (scope.error || caps.error) return <QueryError error={(scope.error ?? caps.error)!} />
  if (!caps.isPending && !grants[history ? 'invitations.read' : 'members.read']) return <Failure kind="forbidden" />
  const loading = scope.isPending || caps.isPending || (enabled && members.isPending) || (history && !!grants['invitations.read'] && invitations.isPending)
  const failed = members.error || (history && invitations.error)
  const roleOptions = members.data?.role_options ?? []
  const organization = scope.data?.memberships.find(item => item.organization_id === orgId)?.name ?? t('organization')
  const rows = history ? (invitations.data?.data ?? []).filter(row => invitationState(row) !== 'pending') : (members.data?.data ?? []).filter(row => memberRow(row) || invitationState(row) === 'pending')
  const roleLabel = (role: string) => t(`role_${role}`, { defaultValue: role })
  const open = (next: Action) => setAction(next)
  const menu = (row: Row) => {
    const self = memberRow(row) && row.user_id === scope.data?.user?.id
    const actions = row.actions ?? []
    const canRole = !!grants['members.update'] && actions.includes('update-role')
    const canRemove = !!grants['members.remove'] && actions.includes('remove')
    const canCopy = !!grants['invitations.create'] && actions.includes('copy-link')
    const canCancel = !!grants['invitations.revoke'] && actions.includes('revoke')
    const canLeave = self
    if (history || (self ? !canLeave : memberRow(row) ? !canRole && !canRemove : !canCopy && !canCancel)) return null
    const locked = memberRow(row) && row.last_administrator
    return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t('memberActions', { name: rowName(row) })} onPointerDown={event => { trigger.current = event.currentTarget }} onKeyDown={event => { trigger.current = event.currentTarget }}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
      {self ? <><DropdownMenuItem variant="destructive" disabled={!!locked} aria-describedby={locked ? 'member-last-admin' : undefined} onSelect={() => open({ kind: 'leave', row: row as Member })}><LogOut />{t('memberLeave')}</DropdownMenuItem>{locked && <p id="member-last-admin" className="max-w-64 px-2 py-1 text-sm text-muted-foreground">{t('memberLastAdmin')}</p>}</> : memberRow(row) ? <>
        {canRole && <DropdownMenuItem disabled={!!locked} onSelect={() => open({ kind: 'role', row })}><Pencil />{t('memberChangeRole')}</DropdownMenuItem>}
        {canRole && canRemove && <DropdownMenuSeparator />}
        {canRemove && <DropdownMenuItem variant="destructive" disabled={!!locked} onSelect={() => open({ kind: 'remove', row })}><Trash2 />{t('memberRemove')}</DropdownMenuItem>}
        {locked && <p className="max-w-64 px-2 py-1 text-sm text-muted-foreground">{t('memberLastAdmin')}</p>}
      </> : <>
        {canCopy && <><DropdownMenuItem onSelect={() => open({ kind: 'copy', row })}><Copy />{t('inviteCopy')}</DropdownMenuItem><DropdownMenuItem onSelect={() => open({ kind: 'resend', row })}><Send />{t('inviteResend')}</DropdownMenuItem><DropdownMenuItem onSelect={() => open({ kind: 'delivery', row })}><Mail />{t('inviteDelivery')}</DropdownMenuItem></>}
        {canCancel && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => open({ kind: 'cancel', row })}><Trash2 />{t('inviteCancel')}</DropdownMenuItem></>}
      </>}
    </DropdownMenuContent></DropdownMenu>
  }
  const details = (row: Row) => {
    if (memberRow(row)) return row.user_id === scope.data?.user?.id ? <span className="text-muted-foreground">{t('memberYou')}</span> : null
    const hours = Math.max(1, Math.round((Date.parse(row.expires_at) - Date.now()) / 3600000))
    const relative = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'always' }).format(hours < 24 ? hours : Math.round(hours / 24), hours < 24 ? 'hour' : 'day')
    return <div className="space-y-1 whitespace-normal text-sm text-muted-foreground">{row.inviter && <p>{t('inviteInviter', { name: row.inviter.display_name === 'Unavailable' ? t('unavailable') : row.inviter.display_name })}</p>}<p className={`flex items-center gap-1 ${hours < 24 ? 'text-destructive' : ''}`}><Clock className="h-3 w-3 shrink-0" aria-hidden="true" />{history ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(row.expires_at)) : t('inviteExpires', { time: relative })}</p></div>
  }
  return <WorkspaceMembers title={t(history ? 'inviteHistory' : 'instanceMembersTitle', { defaultValue: t('members') })} description={t(history ? 'inviteHistoryDescription' : 'memberDescription')} actions={!history && grants['invitations.create'] ? <Button disabled={members.isPending || !!members.error || !roleOptions.length || !members.data?.default_role} onClick={event => { trigger.current = event.currentTarget; open({ kind: 'invite' }) }}><UserPlus className="mr-2 h-4 w-4" />{t('inviteUser')}</Button> : undefined}>
    <WorkspaceMembersTable title={t(history ? 'inviteHistory' : 'members')} description={t(history ? 'inviteHistoryDescription' : 'memberTableDescription')} loading={loading && !failed} loadingLabel={t('loading')}>
      {failed ? <div role="alert" className="space-y-3"><p>{t(!history || members.error && invitations.error ? 'memberFailed' : 'memberPartialError')}</p><Button variant="outline" onClick={() => { if (enabled) void members.refetch(); if (history && grants['invitations.read']) void invitations.refetch() }}>{t('memberRetry')}</Button></div> : rows.length ? <div className="min-w-0 rounded-md border"><Table aria-label={t(history ? 'inviteHistory' : 'members')} className="max-md:block">
        <TableHeader className="max-md:sr-only"><TableRow>{['memberUser', 'status', 'role', 'memberDetails', 'actions'].map(key => <TableHead key={key} className={key === 'actions' ? 'w-12' : undefined}>{key === 'actions' ? <span className="sr-only">{t(key)}</span> : t(key)}</TableHead>)}</TableRow></TableHeader>
        <TableBody className="max-md:block">{rows.map(row => <TableRow key={memberRow(row) ? row.user_id : row.id} className="max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-3 max-md:p-3">
          <TableCell className="whitespace-normal [overflow-wrap:anywhere] max-md:col-span-2 max-md:row-start-1 max-md:min-w-0 max-md:p-0"><div className="font-medium">{rowName(row)}</div>{memberRow(row) && row.display_name && row.display_name !== row.email && <div className="text-sm text-muted-foreground">{row.email}</div>}</TableCell>
          <TableCell className="max-md:col-start-1 max-md:row-start-2 max-md:overflow-visible max-md:p-0"><Badge variant={memberRow(row) ? 'default' : 'secondary'} className="gap-1">{memberRow(row) ? <UserCheck className="h-3 w-3" aria-hidden="true" /> : <UserPlus className="h-3 w-3" aria-hidden="true" />}{t(memberRow(row) ? 'memberActive' : history ? `inviteState_${invitationState(row)}` : 'memberInvited')}</Badge></TableCell>
          <TableCell className="max-md:col-span-2 max-md:col-start-2 max-md:row-start-2 max-md:min-w-0 max-md:overflow-visible max-md:p-0"><Badge variant={roleOptions.find(role => role.id === row.role)?.administrator ? 'default' : 'outline'} className="max-w-full whitespace-normal">{roleLabel(row.role)}</Badge></TableCell>
          <TableCell className="max-md:col-span-3 max-md:row-start-3 max-md:min-w-0 max-md:whitespace-normal max-md:p-0">{details(row)}</TableCell>
          <TableCell className="text-right max-md:col-start-3 max-md:row-start-1 max-md:p-0">{menu(row)}</TableCell>
        </TableRow>)}</TableBody>
      </Table></div> : <p className="py-8 text-center text-muted-foreground">{t(history ? 'inviteHistoryEmpty' : 'memberEmpty')}</p>}
    </WorkspaceMembersTable>
    <div className="text-sm text-muted-foreground underline">{history ? <Link to={membersRoute.to} params={{ orgId }}>{t('memberBack')}</Link> : grants['invitations.read'] && <Link to="/o/$orgId/settings/invitations" params={{ orgId }}>{t('inviteHistory')}</Link>}</div>
    {action && <MutationSession key={JSON.stringify(action)} close={() => setAction(undefined)} cancelLabel={t('cancel')} confirming={!['invite', 'role', 'delivery'].includes(action.kind)}>{session => <MemberAction orgId={orgId} action={action} roles={roleOptions} defaultRole={members.data?.default_role ?? ''} organization={organization} dismiss={() => setAction(undefined)} restoreFocus={event => { event.preventDefault(); if (trigger.current?.isConnected) trigger.current.focus(); else document.querySelector<HTMLElement>('h1')?.focus() }} complete={session.complete} controls={session} />}</MutationSession>}
  </WorkspaceMembers>
}
function MemberAction({ orgId, action, roles, defaultRole, organization, dismiss, restoreFocus, complete, controls }: { orgId: string; action: Action; roles: RoleOption[]; defaultRole: string; organization: string; dismiss: () => void; restoreFocus: (event: Event) => void; complete: () => void; controls: { reset: () => void; closeRequest: number; continueEditing: () => void } }) {
  const { t } = useTranslation(); const session = useMutationSession()!; const labels = useMutationLabels(); const submit = useMutationSubmit(); const client = useQueryClient(); const refresh = useMemberRefresh(orgId); const authorize = useIdentityAction(orgId); const navigate = useNavigate()
  const [link, setLink] = useState<string>(); const [copied, setCopied] = useState(false); const [copyDenied, setCopyDenied] = useState(false)
  const initialRole = action.kind === 'role' ? action.row.role : defaultRole
  const form = useMutationForm({ defaultValues: { email: '', role: initialRole } })
  const delivery = useQuery({ queryKey: [...identityKey(orgId), 'delivery', 'row' in action && 'id' in action.row ? action.row.id : ''], queryFn: () => identityClient.delivery(orgId, (action as { row: Invitation }).row.id), enabled: action.kind === 'delivery', staleTime: 0 })
  const mutation = useMutation({ gcTime: 0, mutationFn: async (data: { email: string; role: string }) => {
    await authorize(async () => {
      if (action.kind === 'invite') {
        const result = await identityClient.invite(orgId, { email: data.email.trim(), role: data.role })
        if ('message' in result && result.message === 'already_member') throw new ApiError(409, 'already_member')
      } else if (action.kind === 'role') await identityClient.changeRole(orgId, action.row.user_id, data.role)
      else if (action.kind === 'remove') await identityClient.removeMember(orgId, action.row.user_id)
      else if (action.kind === 'leave') await identityClient.leave(orgId)
      else if (action.kind === 'cancel') await identityClient.revoke(orgId, 'invitations', action.row.id)
      else if (action.kind === 'resend') {
        const result = await identityClient.resend(orgId, action.row.id)
        if ('message' in result) throw new ApiError(409, 'already_member')
      } else if (action.kind === 'delivery') {
        await identityClient.retryDelivery(orgId, action.row.id); await delivery.refetch()
      } else if (action.kind === 'copy') {
        // Never return a URL from mutationFn: query/mutation caches contain no credential.
        const url = link ?? (await identityClient.copyLink(orgId, action.row.id)).accept_url
        try { await navigator.clipboard.writeText(url); setCopied(true); setCopyDenied(false); setLink(undefined) }
        catch { setLink(url); setCopyDenied(true); throw new ApiError(0, 'clipboard_denied') }
      }
    }, action.kind === 'invite' || action.kind === 'copy' || action.kind === 'resend' || action.kind === 'delivery' ? 'invitations.create' : action.kind === 'cancel' ? 'invitations.revoke' : action.kind === 'role' ? 'members.update' : action.kind === 'remove' ? 'members.remove' : 'members.read')
  }, onSuccess: async () => {
    if (action.kind === 'leave') {
      form.reset(); controls.reset(); complete(); await refresh(); const me = await client.fetchQuery({ ...meOptions, staleTime: 0 }); await navigate({ to: authDestination(null, me.memberships) }); return
    }
    await refresh()
    if (!['copy', 'delivery'].includes(action.kind)) { form.reset(); complete() }
  } })
  const busy = session.pending || mutation.isPending
  const title = t(action.kind === 'invite' ? 'inviteUser' : action.kind === 'role' ? 'memberChangeRole' : action.kind === 'remove' ? 'memberRemove' : action.kind === 'leave' ? 'memberLeave' : action.kind === 'copy' ? 'inviteCopy' : action.kind === 'resend' ? 'inviteResend' : action.kind === 'delivery' ? 'inviteDelivery' : 'inviteCancel')
  const name = 'row' in action ? rowName(action.row) : ''
  const description = t(action.kind === 'invite' ? 'inviteDescription' : action.kind === 'leave' ? 'memberLeaveConfirm' : action.kind === 'copy' ? 'inviteCopyConfirm' : action.kind === 'resend' ? 'inviteResendConfirm' : action.kind === 'cancel' ? 'inviteCancelConfirm' : action.kind === 'remove' ? 'memberRemoveConfirm' : action.kind === 'role' ? 'memberRoleConfirm' : 'inviteDeliveryDescription', { name, organization })
  const error = <MutationErrorAlert isError={mutation.isError && !(mutation.error instanceof ApiError && mutation.error.code === 'clipboard_denied')} error={mutation.error} fallbackMessage={t(memberError(mutation.error))} />
  const roleField = <div className="relative [&_label]:pl-6"><Shield className="absolute top-0 h-4 w-4" aria-hidden="true" /><FormFieldWrapper name="role" label={t('role')} rules={{ required: t('chooseRole') }} description={t(roles.find(role => role.id === form.watch('role'))?.administrator ? 'inviteAdminDescription' : 'inviteRoleDescription')} disabled={busy}>{field => <Select value={field.value} onValueChange={field.onChange} disabled={busy}><SelectTrigger className="w-full" aria-label={t('role')} ref={field.ref} onBlur={field.onBlur}><SelectValue placeholder={t('chooseRole')}>{form.watch('role') ? t(`role_${form.watch('role')}`, { defaultValue: form.watch('role') }) : undefined}</SelectValue></SelectTrigger><SelectContent>{roles.map(role => <SelectItem key={role.id} value={role.id}><span className="flex flex-col items-start"><span>{t(`role_${role.id}`, { defaultValue: role.id })}</span><span className="text-xs text-muted-foreground">{t(role.administrator ? 'inviteAdminDescription' : 'inviteRoleDescription')}</span></span></SelectItem>)}</SelectContent></Select>}</FormFieldWrapper></div>
  const guarded = { open: true, showCloseButton: !busy, title, description, closeLabel: t('close'), formState: { isDirty: session.dirty, isSubmitting: busy }, onReset: controls.reset, closeRequest: controls.closeRequest, onContinueEditing: controls.continueEditing, onOpenChange: (open: boolean) => { if (!open && !busy) dismiss() }, onCloseAutoFocus: restoreFocus, discardPrompt: { title: labels.discardTitle, message: labels.discardMessage, discardLabel: labels.discard, continueLabel: labels.continueEditing } }
  if (action.kind === 'invite' || action.kind === 'role') {
    const body = <Form form={form} pending={busy} className="space-y-4" onSubmit={data => submit(() => mutation.mutateAsync(data))}>
      {action.kind === 'invite' && <div className="relative [&_label]:pl-6"><Mail className="absolute top-0 h-4 w-4" aria-hidden="true" /><FormFieldInput name="email" label={t('email')} placeholder={t('inviteEmailPlaceholder')} type="email" autoComplete="email" required disabled={busy} rules={{ required: t('inviteEmailError'), validate: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()) || t('inviteEmailError') }} /></div>}
      {roleField}{error}<div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={session.cancel}>{t('cancel')}</Button><Button type="submit" aria-busy={busy} disabled={busy || (action.kind === 'role' && !form.formState.isDirty)}>{t(busy ? action.kind === 'invite' ? 'inviteSending' : 'saving' : action.kind === 'invite' ? 'inviteSend' : 'saveChanges')}</Button></div>
    </Form>
    return action.kind === 'invite' ? <InviteUserModal {...guarded}>{body}</InviteUserModal> : <FormDialog {...guarded}>{body}</FormDialog>
  }
  if (action.kind === 'delivery') return <FormDialog {...guarded}>{delivery.isPending ? <p role="status">{t('loading')}</p> : delivery.error ? <p role="alert">{t('memberFailed')}</p> : <div className="space-y-4"><p role="status">{t(`inviteDelivery_${delivery.data.delivery.status}`)}</p><p>{t('inviteDeliveryAttempts', { count: delivery.data.delivery.attempts })}</p>{error}<div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={dismiss}>{t('close')}</Button>{delivery.data.delivery.status === 'failed' && <Button disabled={busy} onClick={() => void submit(() => mutation.mutateAsync(form.getValues()))}><RefreshCw className="mr-2 h-4 w-4" />{t(busy ? 'inviteSending' : 'inviteRetryDelivery')}</Button>}</div></div>}</FormDialog>
  return <ConfirmDialog open title={title} description={description} confirmText={copied ? t('close') : copyDenied ? t('inviteCopyRetry') : title} cancelText={t('cancel')} pendingText={t(action.kind === 'resend' ? 'inviteSending' : 'saving')} confirmVariant={['remove', 'leave', 'cancel'].includes(action.kind) ? 'destructive' : 'default'} isConfirming={busy} onOpenChange={open => { if (!open && !busy) dismiss() }} onCloseAutoFocus={restoreFocus} onConfirm={() => copied ? dismiss() : submit(() => mutation.mutateAsync(form.getValues()))}>
    {error}{copied && <p role="status">{t('inviteCopied')}</p>}{copyDenied && <div className="space-y-2"><p role="alert">{t('inviteCopyDenied')}</p><Input aria-label={t('inviteLink')} readOnly value={link} onFocus={event => event.currentTarget.select()} /></div>}
  </ConfirmDialog>
}
