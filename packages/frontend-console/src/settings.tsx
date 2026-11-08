import { useConsoleRegistry } from './api/console'
import { NavigationIconView } from './navigation-icons'
import { Link, Outlet, useMatches } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { SettingsLayout, WorkspaceSettings, Form, FormFieldInput, MutationSubmitButton, MutationErrorAlert, useMutationForm, useMutationSubmit, useMutationSession } from '@workbasehq/ui'
import { useCapabilities, useOrganization } from './api/queries'
import { profileClient, validProfileName, settingsError } from './api/profile'
import { SettingsMutation } from './profile'
import { Loading, QueryError } from './screens'

export function WorkspaceSettingsLayout({ orgId }: { orgId?: string }) {
  const { t } = useTranslation(); const caps = useCapabilities(orgId)
  const registry = useConsoleRegistry(orgId)
  const activeItem = useMatches().findLast(match => match.staticData.settingsActiveItem)?.staticData.settingsActiveItem
  const workflowDenied = useQuery({ queryKey: ['workflow-denied', orgId ?? ''], queryFn: () => false, initialData: false, enabled: false }).data
  const items = registry.error || caps.error ? [] : (registry.data?.navigation ?? []).filter(item => item.placement === 'settings' && !(item.page === 'core.workflows' && workflowDenied))
  const groups = [...new Map(items.filter(item => item.group).map(item => [item.group!.id, item.group!])).values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const linkClass = 'w-full text-left px-3 py-1 text-sm rounded-md transition-colors'
  return <SettingsLayout title={t('settings')} navigation={<>
    {!orgId && <>
      <Link to="/settings/profile" activeProps={{ className: 'bg-primary text-primary-foreground' }} className={linkClass} activeOptions={{ exact: true }}>{t('profileSettings')}</Link>
      <Link to="/organizations" className={linkClass}>{t('organizations')}</Link>
    </>}
    {orgId && <>
      <Link to="/o/$orgId/settings/profile" params={{ orgId }} activeProps={{ className: 'bg-primary text-primary-foreground' }} className={linkClass} activeOptions={{ exact: true }}>{t('profileSettings')}</Link>
      {[undefined, ...groups].map(group => {
        const groupItems = items.filter(item => item.group?.id === group?.id)
        return groupItems.length > 0 && <div key={group?.id ?? 'general'} className="flex flex-col space-y-1">
          {group && <h3 className="px-3 pt-4 pb-1 text-sm font-medium text-muted-foreground">{t(group.label, { defaultValue: group.label })}</h3>}
          {groupItems.map(item => {
            const page = registry.data?.pages.find(page => page.id === item.page)
            const path = page?.path ?? `/e/${item.entity}`
            const target = '/o/' + orgId + path
            return <Link key={item.id} to={target} search={item.view ? { view: item.view } : {}} activeProps={{ className: 'bg-primary text-primary-foreground' }} className={`${linkClass} flex items-center gap-2 ${activeItem === item.label ? 'bg-primary text-primary-foreground' : ''}`} aria-current={activeItem === item.label ? 'page' : undefined} activeOptions={{ exact: true }}>{item.icon && <span className="[&>svg]:size-4"><NavigationIconView name={item.icon} /></span>}{t(item.label, { defaultValue: item.label })}</Link>
          })}
        </div>
      })}
    </>}
  </>}><Outlet /></SettingsLayout>
}

export function OrganizationSettings({ orgId }: { orgId: string }) {
  const { t } = useTranslation(); const org = useOrganization(orgId); const caps = useCapabilities(orgId)
  if (org.isPending || caps.isPending) return <Loading />
  if (org.error || caps.error) return <QueryError error={(org.error ?? caps.error)!} />
  const membership = org.data.memberships.find(item => item.organization_id === orgId)
  if (!membership) return <QueryError error={new Error('organization_required')} />
  return <SettingsMutation key={orgId}><OrganizationForm orgId={orgId} name={membership.name} canRename={caps.data.resources?.['organizations.update'] === true} /></SettingsMutation>
}
function OrganizationForm({ orgId, name, canRename }: { orgId: string; name: string; canRename: boolean }) {
  const { t } = useTranslation(); const client = useQueryClient(); const session = useMutationSession()!; const submit = useMutationSubmit()
  const form = useMutationForm({ defaultValues: { name } })
  const save = useMutation({ mutationFn: async (nextName: string) => {
    // The endpoint checks live membership/grants again at mutation time.
    const result = await profileClient.rename(orgId, nextName)
    form.reset({ name: result.name })
    if (result.invalidates.some(key => ['me', 'memberships', 'selectedOrganization'].includes(key))) await Promise.all([
      client.invalidateQueries({ queryKey: ['me'] }),
      client.invalidateQueries({ queryKey: ['organization', orgId] }),
      // Bootstrap seeds Me when revisiting a scope. Remove its old label snapshot.
      client.removeQueries({ queryKey: ['bootstrap'] }),
    ])
  }, onError: () => { void client.invalidateQueries({ queryKey: ['capabilities', orgId] }) } })
  const busy = save.isPending || session.pending
  return <Form form={form} pending={busy} onSubmit={data => canRename && !busy ? submit(() => save.mutateAsync(data.name.trim())) : Promise.resolve()}>
    <WorkspaceSettings title={t('organizationSettings')} description={t(canRename ? 'organizationSettingsDescription' : 'organizationSettingsReadOnly')}
      name={<FormFieldInput name="name" label={t('organizationName')} required disabled={!canRename || busy} rules={{ validate: value => validProfileName(String(value)) || t('invalidName') }} />}
      error={<MutationErrorAlert isError={save.isError} error={save.error} fallbackMessage={t(settingsError(save.error))} />}
      footer={canRename && <MutationSubmitButton footer={false} type="submit" pending={busy} disabled={!form.formState.isDirty}>{t('saveChanges')}</MutationSubmitButton>} />
  </Form>
}
