import type { Capabilities, Model } from '@workbasehq/console-generated/read'
import { readableWhere } from '@workbasehq/console-generated/list-model'
import type { NavigationConfig } from './api/identity'

export interface NavigationItem { id: string; entity: string; label?: string; icon?: string; order?: number; group?: string; view?: string }
export interface NavigationEntry extends NavigationItem { children?: NavigationItem[] }
const byOrder = (a: { order?: number }, b: { order?: number }) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
/** Navigation is a presentation projection, never an authorization grant. */
export function entityNavigation(model: Model, caps: Capabilities, config?: NavigationConfig): NavigationEntry[] {
  const visible = (entity: string) => !!model.entities[entity] && caps.entities[entity]?.operations.includes('read') && caps.entities[entity].readable.includes('id')
  const configured = new Set(config?.items.map(item => item.entity))
  const items: NavigationItem[] = (config?.items ?? []).filter(item => {
    if (item.hidden || !visible(item.entity) || item.roles && (!caps.organization || !item.roles.includes(caps.organization.role))) return false
    const view = model.entities[item.entity].list?.views?.find(view => view.id === item.view)
    return !item.view || !!view && readableWhere(view.where, model, item.entity, caps)
  })
  items.push(...Object.keys(model.entities).filter(entity => !configured.has(entity) && visible(entity)).map(entity => ({ id: entity, entity })))
  const groups: NavigationEntry[] = (config?.groups ?? []).map(group => ({ ...group, entity: '', children: items.filter(item => item.group === group.id).sort(byOrder) })).filter(group => group.children.length)
  return [...items.filter(item => !item.group), ...groups].sort(byOrder)
}

/** List filters select a separate menu entry only when explicitly configured as one. */
export function activeNavigationItem(item: NavigationItem, pathname: string, orgId: string, currentView?: string, config?: NavigationConfig): boolean {
  const target = `/o/${orgId}/e/${item.entity}`
  if (pathname !== target && !pathname.startsWith(`${target}/`)) return false
  return item.view ? currentView === item.view : !config?.items.some(candidate => candidate.entity === item.entity && candidate.view && candidate.view === currentView)
}

/** Collection headings and breadcrumbs resolve the same configured label as navigation. */
export function entityNavigationLabel(navigation: NavigationConfig | undefined, entity: string, view?: string): string {
  return navigation?.items.find(item => item.entity === entity && (item.view ? item.view === view : !view || view === 'all'))?.label ?? `entity_${entity}`
}
