import { Link, useLocation, useMatches } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { LayoutBreadcrumbs } from '@workbasehq/ui'
import { Skeleton } from '@workbasehq/ui/components/ui/skeleton'
import { useRecordBreadcrumbs, type RecordBreadcrumbState } from '../../console-generated/src/breadcrumbs'
import { entityNavigationLabel } from './navigation'
import type { NavigationConfig } from './api/identity'

function RecordLabel({ state }: { state?: RecordBreadcrumbState }) {
  const { t } = useTranslation()
  if (!state || state.status === 'pending') return <Skeleton role="status" aria-label={t('loading')} className="h-4 w-32 max-w-full" />
  return <span title={state.status === 'ready' ? state.label : undefined}>{state.status === 'ready' && state.label ? state.label : t('unavailableRecord')}</span>
}

/** Declared by the detail route; consumes the page's result, never starts a query. */
export function RecordBreadcrumb({ orgId, entity, id }: { orgId: string; entity: string; id: string }) {
  const { detail, edit } = useRecordBreadcrumbs()
  const scoped = (state?: RecordBreadcrumbState) => state?.orgId === orgId && state.entity === entity && state.id === id ? state : undefined
  const current = scoped(detail)
  return <RecordLabel state={current?.status === 'ready' ? scoped(edit) ?? current : current} />
}

/** Tiketo's route/staticData composition, with translated generated ancestors. */
export function Breadcrumbs({ navigation, membershipName, canReadWorkflows = false }: { navigation?: NavigationConfig; membershipName?: string; canReadWorkflows?: boolean }) {
  const { t } = useTranslation()
  const matches = useMatches()
  const location = useLocation()
  const { edit } = useRecordBreadcrumbs()
  const params = matches.at(-1)?.params as { orgId?: string; entity?: string; id?: string } | undefined
  const editing = edit && edit.orgId === params?.orgId && edit.entity === params.entity && (!params.id || edit.id === params.id) ? edit : undefined
  const currentView = (location.search as { view?: string }).view
  const crumbMatches = matches.filter(match => match.staticData.crumb != null).filter((match, index, all) => index === 0 || match.pathname !== all[index - 1].pathname)
  const items = crumbMatches.flatMap(match => {
    const entity = (match.params as { entity?: string }).entity
    const data = match.staticData
    const menuItem = data.crumb === 'entities' ? navigation?.items.find(item => item.entity === entity && (item.view ? item.view === currentView : !currentView || currentView === 'all')) : undefined
    const group = menuItem && navigation?.groups.find(group => group.id === menuItem.group)
    const label = typeof data.crumb === 'function' ? data.crumb(match)
      : data.crumb === 'entities' && entity ? t(entityNavigationLabel(navigation, entity, currentView))
      : data.crumb === 'organizations' && membershipName ? membershipName
      : typeof data.crumb === 'string' ? t(data.crumb) : data.crumb
    return [
      ...(group ? [{ key: `group-${group.id}`, label: t(group.label, { defaultValue: group.label }), clickable: false }] : []),
      ...(data.parentCrumbs ?? []).map(parent => ({ key: parent.href, label: t(parent.label), href: parent.href, clickable: true })),
      { key: match.id, label, href: match.pathname, clickable: data.crumb === 'workflowRuns' && !canReadWorkflows ? false : data.hasClickableBreadcrumb },
    ]
  })
  if (editing) {
    // Row-menu edits already have the list row; detail edits retain their route crumb.
    if (!params?.id) items.push({ key: 'editing-record', label: <RecordLabel state={editing} />, href: `/o/${encodeURIComponent(editing.orgId)}/e/${encodeURIComponent(editing.entity)}/${encodeURIComponent(editing.id)}`, clickable: true })
    items.push({ key: 'edit', label: t('edit'), clickable: false })
  }
  if (crumbMatches.at(-1)?.staticData.rootBreadcrumbClickable === false && items.length) items[0].clickable = false
  return <LayoutBreadcrumbs items={items.map((item, index) => ({
    key: item.key,
    content: item.href && (item.clickable ?? index < items.length - 1)
      ? <Link to={item.href} className="breadcrumb-link">{item.label}</Link>
      : <span className="breadcrumb-link" aria-current={index === items.length - 1 ? 'page' : undefined}>{item.label}</span>,
  }))} />
}
