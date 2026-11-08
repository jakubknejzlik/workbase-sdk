import { hashKey, useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { pickerQuery } from './write'
import { visibleEntities, type Capabilities, type Model, type ReadQuery, type Result } from './read'

type Row = Record<string, any>
type Pending = { id: string; resolve: (row: Row | null) => void; reject: (error: unknown) => void }
const batches = new WeakMap<QueryClient, Map<string, Pending[]>>()
const key = (model: Model, caps: Capabilities, orgId: string, target: string) => ['picker', model.instance, model.revision, orgId, caps, target, 'selected']

/** Coalesce sibling controls in this render into bounded, capability-scoped target queries. */
function enqueue(client: QueryClient, model: Model, caps: Capabilities, orgId: string, target: string, id: string, request: (query: ReadQuery) => Promise<Result>) {
  let scopes = batches.get(client)
  if (!scopes) { scopes = new Map(); batches.set(client, scopes) }
  const scope = hashKey(key(model, caps, orgId, target))
  return new Promise<Row | null>((resolve, reject) => {
    const pending = scopes.get(scope)
    if (pending) { pending.push({ id, resolve, reject }); return }
    const queue = [{ id, resolve, reject }]; scopes.set(scope, queue)
    setTimeout(() => {
      scopes.delete(scope)
      const size = Math.min(40, model.limits.root)
      for (let offset = 0; offset < queue.length; offset += size) {
        const batch = queue.slice(offset, offset + size)
        void request({ ...pickerQuery(model, target, caps, { ids: batch.map(item => item.id) }), limit: size }).then(result => {
          for (const item of batch) item.resolve(result.data.find(row => row.id === item.id) ?? null)
        }).catch(error => { for (const item of batch) item.reject(error) })
      }
    }, 0)
  })
}

/** Seed from authorized options/includes and fetch only IDs not already known in this scope. */
export function selectedReferenceOptions(client: QueryClient, model: Model, caps: Capabilities, orgId: string, target: string, id: string, known: Row[], request: (query: ReadQuery) => Promise<Result>) {
  return {
    queryKey: [...key(model, caps, orgId, target), id],
    queryFn: () => enqueue(client, model, caps, orgId, target, id, request),
    initialData: known.find(row => row.id === id), enabled: visibleEntities(model, caps).includes(target), staleTime: Infinity, retry: false,
  }
}

export function useSelectedReferences(model: Model, caps: Capabilities, orgId: string, target: string, ids: string[], known: Row[], request: (query: ReadQuery) => Promise<Result>) {
  const client = useQueryClient(), allowed = visibleEntities(model, caps).includes(target)
  const unique = [...new Set(ids)].filter(Boolean)
  const results = useQueries({ queries: unique.map(id => selectedReferenceOptions(client, model, caps, orgId, target, id, known, request)) })
  const knownKey = hashKey([key(model, caps, orgId, target), known])
  useEffect(() => {
    if (!allowed) return
    for (const row of known) {
      const queryKey = [...key(model, caps, orgId, target), row.id]
      if (client.getQueryState(queryKey)?.status !== 'error' && hashKey([client.getQueryData(queryKey)]) !== hashKey([row])) client.setQueryData(queryKey, row)
    }
  }, [client, knownKey, allowed])
  return { rows: allowed ? results.flatMap((result, index) => { const row = !result.error && (known.find(row => row.id === unique[index]) ?? result.data); return row ? [row] : [] }) : [], error: results.find(result => result.error)?.error,
    seed: (row?: Row) => { if (allowed && row) client.setQueryData([...key(model, caps, orgId, target), row.id], row) } }
}

/** List label projections and n:1 detail includes already carry authorized target rows. */
export function selectedReferenceRow(model: Model, entity: string, field: string, row?: Row): Row | undefined {
  if (!row || !row[field]) return undefined
  const target = model.entities[entity].fields[field]?.entity
  const label = row.__labels?.[field]
  if (label?.entity === target && label.row?.id === row[field]) return label.row
  const relation = Object.entries(model.entities[entity].relations).find(([, relation]) => relation.cardinality === 'n:1' && relation.field === field && relation.entity === target)
  const included = relation && row[relation[0]]
  return included?.id === row[field] ? included : undefined
}
