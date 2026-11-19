import type { KernelRegistry } from '../kernel/registry'
import type { Scope } from '../types'
import { capabilities } from '../capabilities'
import { consoleAuthorization } from '../console-authorization'
import { normalizeListConfig } from '../list-config'
import type { ListConfig } from '../list-contract'
import type { QueryInput } from './input-schema'

/** Match console registry precedence, including normalized plugin contributions. */
export function configuredList(kernel: KernelRegistry, entity: string): ListConfig | undefined {
  let list = kernel.config.ui?.entities?.[entity]?.list
  for (const plugin of kernel.config.plugins ?? []) {
    const contributed = plugin.contributes?.console?.entities?.[entity]?.list
    if (contributed) list = normalizeListConfig(kernel.config, entity, contributed)
  }
  return list
}
export function configuredViews(kernel: KernelRegistry, entity: string) {
  const views = configuredList(kernel, entity)?.views ?? []
  return views.length && !views.some(view => view.id === 'all') ? [{ id: 'all', label: 'All', where: {} }, ...views] : views
}
/** Reuse presentation authority: a forbidden operand removes the whole view. */
export function readableListViews(kernel: KernelRegistry, scope: Scope, entity: string) {
  const authority = consoleAuthorization(kernel, scope, capabilities(kernel, scope))
  return configuredViews(kernel, entity).filter(view => authority.predicate(entity, view.where)
    && (!view.rowAccess || authority.listRowAccess(entity)))
}
/** Keep the confirmed user predicate separate so selecting another tab replaces only the view. */
export function listPredicate(kernel: KernelRegistry, query: QueryInput): QueryInput {
  const view = query.view && configuredViews(kernel, query.entity).find(view => view.id === query.view)
  return view ? { ...query, where: query.where ? { and: [query.where, view.where] } : view.where } : query
}
