import { useAuthorityAction } from './api/authority'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { WorkspaceSwitch } from '@workbasehq/ui'
import { useNavigate } from '@tanstack/react-router'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@workbasehq/ui/components/ui/dropdown-menu'
import { Mail } from 'lucide-react'
import type { Membership } from './api/queries'
import { invitationInboxOptions, invitationTarget } from './api/invitation-inbox'
import { CreateOrganizationDialog } from './create-organization-dialog'

export function OrganizationSwitcher({ memberships, activeId, onSwitch, allowCreate = true }: { allowCreate?: boolean; memberships: Membership[]; activeId?: string; onSwitch: (id: string) => void | Promise<void> }) {
  const { t } = useTranslation(); const [createOpen, setCreateOpen] = useState(false); const navigate = useNavigate()
  const authorize = useAuthorityAction(activeId)
  const inbox = useQuery(invitationInboxOptions); const [switching, setSwitching] = useState(false); const [failed, setFailed] = useState(false)
  const invitations = inbox.data?.data.filter(row => invitationTarget(row.navigation_target)) ?? []
  return <>
    <WorkspaceSwitch activeId={activeId} workspaces={memberships.map(org => ({ id: org.organization_id, name: org.name }))} label={t('workspaceLabel')} selectLabel={t('organizations')} placeholderLabel={t('selectOrganization')} searchLabel={t('searchOrganizations')} currentLabel={t('currentOrganization')} emptyLabel={t('noOrganizations')} noMatchLabel={t('p2NoMatchingOrganizations')} addLabel={t('addOrganization')} onSwitch={id => { if (switching) return; void authorize(async ctx => { ctx.run(() => { setSwitching(true); setFailed(false) }); try { await ctx.run(() => onSwitch(id)) } catch { ctx.run(() => setFailed(true)) } finally { ctx.run(() => setSwitching(false)) } }).catch(() => {}) }} onAdd={allowCreate ? () => setCreateOpen(true) : undefined}
      extraItems={<>
        {invitations.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>{t('p2PendingInvitations')}</DropdownMenuLabel>{invitations.map(row => <DropdownMenuItem key={row.id} onSelect={() => void navigate({ to: row.navigation_target })} className="gap-2 p-2"><Mail className="size-4 shrink-0" /><span className="min-w-0 whitespace-normal break-words">{row.organization.name ?? t('organization')}</span></DropdownMenuItem>)}</>}
        {inbox.error && <DropdownMenuItem onSelect={event => { event.preventDefault(); void authorize(async ctx => { await ctx.run(() => inbox.refetch()) }).catch(() => {}) }}>{t('p2RetryInvitations')}</DropdownMenuItem>}
      </>} />
    {switching && <p role="status" className="px-2 text-sm">{t('loading')}</p>}
    {failed && <p role="alert" className="px-2 text-sm text-destructive">{t('requestFailed')}</p>}
    <CreateOrganizationDialog retainActive={!!activeId} open={createOpen} onOpenChange={setCreateOpen} onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>('[data-slot="sidebar-header"] button')?.focus() }} />
  </>
}
