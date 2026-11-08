import { useQueries } from '@tanstack/react-query'
import { recordLabel, type Capabilities, type Model, type ReadQuery, type Result } from '@workbasehq/console-generated/read'
import type { AuditEvent } from './api/workflows'
import { isCredentialShaped } from './api/redact'

/** One page, shared targets, at most 20 batches of 40 IDs. No event-by-event fetches. */
export function auditLabelQueries(model: Model | undefined, caps: Capabilities | undefined, events: AuditEvent[]) {
  const targets = new Map<string, Set<string>>()
  if (!model || !caps) return []
  for (const event of events) for (const [field, change] of Object.entries(event.changes ?? {})) {
    const target = model.entities[event.entity]?.fields[field]?.entity
    if (!target || !caps.entities[event.entity]?.readable.includes(field)) continue
    const grant = caps.entities[target], display = grant?.displayField ?? model.entities[target]?.displayField
    if (!grant?.operations.includes('read') || !grant.readable.includes('id') || !display || !grant.readable.includes(display) || ['id', 'organization_id'].includes(display)) continue
    const ids = targets.get(target) ?? new Set<string>(); targets.set(target, ids)
    for (const value of [change.before, change.after]) if (typeof value === 'string' && value && !isCredentialShaped(value)) ids.add(value)
  }
  const plans: ReadQuery[] = []
  for (const [target, values] of targets) {
    const display = caps.entities[target].displayField ?? model.entities[target].displayField!
    const ids = [...values], size = Math.min(40, model.limits.root)
    for (let start = 0; start < ids.length && plans.length < 20; start += size) plans.push({ entity: target, select: ['id', display], where: { id: { in: ids.slice(start, start + size) } }, limit: size })
  }
  return plans
}
export function useAuditLabels(model: Model | undefined, caps: Capabilities | undefined, orgId: string, events: AuditEvent[], request: (query: ReadQuery) => Promise<Result>, locale: string, t: (key: string, options?: any) => string) {
  const plans = auditLabelQueries(model, caps, events)
  const results = useQueries({ queries: plans.map(query => ({ queryKey: ['audit-labels', model?.instance, orgId, caps, query], queryFn: () => request(query), retry: false })) })
  return (entity: string, field: string, id: unknown) => {
    const target = model?.entities[entity]?.fields[field]?.entity
    for (let index = 0; index < plans.length; index++) {
      if (plans[index].entity !== target) continue
      const row = results[index].data?.data.find(row => row.id === id)
      if (row) return recordLabel(model!, target!, row, caps!, locale, t)
    }
    return t('unavailableRecord')
  }
}
