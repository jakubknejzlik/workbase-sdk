import type { ReactNode } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useConsoleRegistry } from './api/console'
import { AuditScreen } from './audit'
import { WorkflowList } from './workflows'
import { OrganizationSettings } from './settings'
import { MembersScreen } from './members'
import { TokensSettings } from './tokens'
import { Failure, Loading, QueryError, OrganizationHome } from './screens'
import { ChangesPage } from './changes'
import { VersionsPage } from './versions'
import { WidgetPage } from './dashboard'

export function ConsolePageGate({ orgId, id, children }: { orgId: string; id: string; children: ReactNode }) {
  const registry = useConsoleRegistry(orgId)
  if (registry.error) return <QueryError error={registry.error} />
  if (!registry.data) return <Loading />
  return registry.data.pages.some(page => page.id === id) ? children : <Failure kind="notFound" />
}
/** A small renderer-ID escape hatch; placement and installation come only from the registry. */
export function PluginPage({ orgId, id }: { orgId: string; id?: string }) {
  const registry = useConsoleRegistry(orgId); const location = useLocation()
  if (registry.error) return <QueryError error={registry.error} />
  if (!registry.data) return <Loading />
  const page = registry.data.pages.find(page => id ? page.id === id : `/o/${orgId}${page.path}`.replace(/\/$/, '') === location.pathname.replace(/\/$/, ''))
  if (!page) return <Failure kind="notFound" />
  if (page.widgets) return <WidgetPage orgId={orgId} page={page} />
  switch (page.renderer) {
    case 'console.changes': return <ChangesPage key={orgId} orgId={orgId} />
    case 'console.versions': return <VersionsPage orgId={orgId} />
    case 'core.overview': return <OrganizationHome orgId={orgId} />
    case 'audit.activity': return <AuditScreen orgId={orgId} />
    case 'core.workflows': return <WorkflowList orgId={orgId} filter="needs_attention" />
    case 'organizations.settings': return <OrganizationSettings orgId={orgId} />
    case 'members.list': return <MembersScreen orgId={orgId} />
    case 'machine-credentials.tokens': return <TokensSettings orgId={orgId} />
    default: return <Failure kind="notFound" />
  }
}
