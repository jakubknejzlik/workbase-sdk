import { hashKey } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { FilterDescriptor } from './filter-kinds'
import type { ListFilter } from './list-model'
import type { Capabilities, Model, ReadQuery, Result } from './read'
import { referenceScope, useReferenceAuthority } from './reference-authority'

/** Fresh ID-only reads, independent of label/option caches. Both URL and saved views enter here. */
export function useReconciledFilters(model: Model, caps: Capabilities, orgId: string, entity: string, filters: ListFilter[], descriptors: FilterDescriptor[], request: (query: ReadQuery) => Promise<Result>, enabled: boolean, attempt: number) {
  const authority = useReferenceAuthority()
  const plansFor = (filters: ListFilter[]) => filters.flatMap(filter => {
    const descriptor = descriptors.find(item => item.field === filter.field)
    const target = model.entities[entity].fields[filter.field]?.entity
    return descriptor?.kind === 'relation' && target && Array.isArray(filter.predicate.in) ? [{ filter, target, ids: filter.predicate.in as string[] }] : []
  })
  const keyFor = (filters: ListFilter[]) => hashKey([attempt, filters, plansFor(filters).map(plan => [plan.filter, referenceScope(model, caps, orgId, plan.target, authority)])])
  const plans = plansFor(filters), key = keyFor(filters)
  const [resolved, setResolved] = useState<{ key: string; version: number; outputKey?: string; filters: ListFilter[]; error?: Error }>()
  const transition = useRef({ key, version: 0 })
  if (transition.current.key !== key) {
    const canonical = resolved?.version === transition.current.version && resolved?.key === transition.current.key && resolved.outputKey === key
    transition.current = { key, version: transition.current.version + (canonical ? 0 : 1) }
  }
  const { version } = transition.current
  const latest = useRef({ plans, request, filters, model, keyFor }); latest.current = { plans, request, filters, model, keyFor }
  const matches = resolved?.version === version && (resolved?.key === key || resolved?.outputKey === key)
  const ready = !plans.length || matches && !resolved?.error
  useEffect(() => {
    if (!enabled || !latest.current.plans.length || ready) return
    let active = true
    const { plans, request, filters, model, keyFor } = latest.current
    void (async () => {
      const replacements = new Map<string, ListFilter | undefined>()
      for (const { filter, target, ids } of plans) {
        const readable = new Set<string>()
        const size = Math.min(40, model.limits.root)
        for (let offset = 0; offset < ids.length; offset += size) {
          const chunk = ids.slice(offset, offset + size)
          const result = await request({ entity: target, select: ['id'], where: { id: { in: chunk } }, orderBy: [{ field: 'id', dir: 'asc' }], limit: size })
          if (!active) return
          for (const row of result.data) if (chunk.includes(row.id)) readable.add(row.id)
        }
        const kept = ids.filter(id => readable.has(id))
        replacements.set(filter.field, kept.length ? { ...filter, predicate: { in: kept } } : undefined)
      }
      const reconciled = filters.flatMap(filter => replacements.has(filter.field) ? replacements.get(filter.field) ? [replacements.get(filter.field)!] : [] : [filter])
      if (active) setResolved({ key, version, outputKey: keyFor(reconciled), filters: reconciled })
    })().catch(error => { if (active) setResolved({ key, version, filters: [], error }) })
    return () => { active = false }
  }, [key, version, enabled])
  // Never expose restored relation IDs to chip hydration while their authority is unverified.
  const reconciled = ready ? plans.length ? resolved!.filters : filters : filters.filter(filter => !plans.some(plan => plan.filter.field === filter.field))
  // Immediate picker selections already came from authorized options. Saved/URL restores
  // never call this path, and an authority change changes every proof key.
  const accept = (next: ListFilter[]) => {
    const nextKey = keyFor(next)
    if (ready) setResolved({ key: nextKey, version: version + (nextKey === key ? 0 : 1), filters: next })
  }
  return { accept, filters: reconciled, ready, error: matches ? resolved?.error : undefined,
    dropped: ready && JSON.stringify(filters) !== JSON.stringify(reconciled) }
}
