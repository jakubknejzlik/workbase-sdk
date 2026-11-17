import { useAuthorityAction } from './api/authority'
import { useActionMutation } from './api/action-mutation'
import { Languages } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, UserWorkspaceOnboarding, useMutationSubmit } from '@workbasehq/ui'
import { api } from './api/client'
import { useMe } from './api/queries'
import { invitationInboxOptions, invitationTarget } from './api/invitation-inbox'
import { CreateOrganizationForm } from './create-organization-dialog'
import { SettingsMutation } from './profile'
import { Loading } from './screens'

/** Same entry after signup, leave and confirmed removal; the shell stays unmounted. */
export function OrganizationSetup() {
  const { t } = useTranslation(); const me = useMe(); const inbox = useQuery(invitationInboxOptions); const navigate = useNavigate()
  const authorize = useAuthorityAction()
  const [refreshedEmpty, setRefreshedEmpty] = useState(false)
  const target = invitationTarget(inbox.data?.next)
  useEffect(() => { if (target) void navigate({ to: target, replace: true }) }, [target, navigate])
  if (inbox.isPending || target) return <div className="min-h-screen flex items-center justify-center"><Loading /></div>
  const canCreate = me.data?.organizationsEnabled !== false && me.data?.organizationCreationAllowed !== false
  return <SettingsMutation><UserWorkspaceOnboarding title={t(canCreate ? 'p2OrganizationSetup' : 'p2InstanceAccess')} description={t(inbox.error ? 'p2InboxError' : canCreate ? 'p2OrganizationSetupDescription' : 'p2AccessRequired')}>
    <div className="w-full space-y-4">
      {inbox.error ? <div role="alert"><Button variant="outline" onClick={() => void authorize(async ctx => { await ctx.run(() => inbox.refetch()) }).catch(() => {})}>{t('memberRetry')}</Button><SetupControls /></div> : canCreate ? <CreateOrganizationForm setup>{busy => <SetupControls busy={busy} />}</CreateOrganizationForm> : <>
        <Button variant="outline" className="w-full" disabled={inbox.isFetching} onClick={() => void authorize(async ctx => { ctx.run(() => setRefreshedEmpty(false)); const result = await ctx.run(() => inbox.refetch()); ctx.run(() => setRefreshedEmpty(result.isSuccess && !result.data.data.length && !invitationTarget(result.data.next))) }).catch(() => {})}>{t('p2RefreshInvitations')}</Button>
        {refreshedEmpty && !inbox.isFetching && <p role="status" className="text-center text-sm text-muted-foreground">{t('noInvitations')}</p>}
        <Link to="/settings/profile" className="block text-center text-sm underline">{t('profileSettings')}</Link><SetupControls />
      </>}
    </div>
  </UserWorkspaceOnboarding></SettingsMutation>
}
export function SetupControls({ busy = false }: { busy?: boolean }) {
  const { t, i18n } = useTranslation(); const client = useQueryClient(); const submit = useMutationSubmit()
  const logout = useActionMutation(undefined, { mutationFn: ctx => ctx.run(() => api('/auth/logout', { method: 'POST', signal: ctx.signal })), onSuccess: ctx => ctx.run(() => { client.clear(); window.location.assign('/sign-in') }) })
  return <div className="space-y-2">
    {logout.error && <p role="alert" className="text-sm text-destructive">{t('requestFailed')}</p>}
    <div className="mt-4 flex items-center justify-between gap-2 border-t pt-4">
      <Button type="button" variant="ghost" aria-label={t('switchLanguage')} disabled={busy || logout.isPending} onClick={() => void i18n.changeLanguage(i18n.language === 'cs' ? 'en' : 'cs')}><Languages />{t('languageLabel')}</Button>
      <Button type="button" variant="outline" disabled={busy || logout.isPending} onClick={() => void submit(() => logout.mutateAsync())}>{t('signOut')}</Button>
    </div>
  </div>
}
