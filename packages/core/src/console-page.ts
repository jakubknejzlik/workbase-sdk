import type { ConsoleGrant, ConsoleModelCapabilities } from './console-contract'

/** Existing capability projection only; dependencies restrict an explicit grant. */
export type PageCapabilities = {
  entities: Record<string, { operations?: readonly string[]; readable?: readonly string[] }>
  resources?: Record<string, boolean>
}
export type PageRule = {
  grant?: ConsoleGrant
  entity?: string
  mode?: 'list' | 'detail' | 'create' | 'edit'
  data?: Record<string, { entity: string; kind: 'one' | 'list' }>
  uses?: readonly string[]
}
const own = <T>(source: Record<string, T> | undefined, key: string) => source && Object.hasOwn(source, key) ? source[key] : undefined
export function consoleGrant(caps: PageCapabilities | undefined, grant?: ConsoleGrant): boolean {
  if (!grant) return false
  if (typeof grant === 'string') return own(caps?.resources, grant) === true
  const entity = own(caps?.entities, grant.entity)
  return entity?.operations?.includes(grant.operation ?? 'read') === true
}
/** Route entry and navigation targets use precisely this decision. */
export function consolePage(caps: PageCapabilities | undefined, page: PageRule, dependencies = true): boolean {
  const field = (entity: string, name: string) => own(caps?.entities, entity)?.readable?.includes(name) === true
  const operation = (entity: string, mode?: PageRule['mode']) => {
    const ops = own(caps?.entities, entity)?.operations ?? []
    return mode === 'create' ? ops.includes('create') : ops.includes('read') && field(entity, 'id') && (mode !== 'edit' || ops.includes('update'))
  }
  return consoleGrant(caps, page.grant) && dependencies
    && (!page.entity || operation(page.entity, page.mode))
    && Object.values(page.data ?? {}).every(binding => operation(binding.entity, binding.kind === 'list' ? 'list' : 'detail'))
    && (page.uses ?? []).every(use => {
      const parts = use.split('.')
      return parts.length === 2 && operation(parts[0], 'detail') && field(parts[0], parts[1])
    })
}

/** Reject corrupt boot documents; absent individual grants still mean deny. */
export function parseCapabilities(value: unknown): ConsoleModelCapabilities {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const strings = (item: unknown) => Array.isArray(item) && item.every(v => typeof v === 'string')
  if (!object(value) || !Number.isSafeInteger(value.revision) || !object(value.entities) || !object(value.resources) || !object(value.organization) || typeof value.organization.role !== 'string' || !strings(value.commands) || !object(value.workflows)
    || !Object.values(value.resources).every(v => typeof v === 'boolean') || !Object.values(value.workflows).every(strings)
    || !Object.values(value.entities).every(v => object(v) && ['readable', 'writable', 'operations'].every(k => strings(v[k])))) throw new Error('Invalid capabilities')
  return value as unknown as ConsoleModelCapabilities
}
