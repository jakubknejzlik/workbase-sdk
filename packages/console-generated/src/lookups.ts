import { useQuery } from '@tanstack/react-query'
import { projection, visibleEntities, type Capabilities, type Model, type ReadQuery, type Result } from './read'

/** Explicitly configured small catalogs only; never infer size from the visible page. */
export function isLookup(model: Model, entity: string) { return model.entities[entity]?.lookup === true }
export function lookupOptions(model: Model, caps: Capabilities, orgId: string, entity: string, request: (query: ReadQuery) => Promise<Result>) {
  return {
    queryKey: ['lookup', model.instance, model.revision, orgId, caps, entity],
    staleTime: Infinity, gcTime: Infinity, retry: false,
    enabled: isLookup(model, entity) && visibleEntities(model, caps).includes(entity),
    queryFn: async (): Promise<Result> => {
      // Follow the existing policy-filtered cursor API so catalogs are never silently truncated.
      const data: Result['data'] = []; let cursor: string | undefined
      do {
        const page = await request({ entity, select: projection(model, entity, caps), limit: model.limits.root, orderBy: [{ field: 'id', dir: 'asc' }], ...(cursor ? { cursor } : {}) })
        data.push(...page.data); cursor = page.next_cursor ?? undefined
      } while (cursor)
      return { data, next_cursor: null }
    },
  }
}
export function useLookup(model: Model, caps: Capabilities, orgId: string, entity: string, request: (query: ReadQuery) => Promise<Result>) {
  return useQuery(lookupOptions(model, caps, orgId, entity, request))
}
