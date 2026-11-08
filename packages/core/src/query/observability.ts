import { ApiError } from '../errors'
import type { Scope } from '../types'
import { inputHash } from './cursor'
import type { QueryCost } from './limits'
import { databaseIdentity } from '../request-timing'

export interface QueryLog {
  queryHash: string
  shape: { entity: string | null; depth: number; relationCount: number; selectCount: number; includeCount: number }
  actorKind: Scope['actor']['type']; tokenId: string | null; organizationId: string
  estimatedCost: QueryCost | null
  bindingCount: number; bindingHighWaterMark: number; statementCount: number
  durationMs: number; resultRows: number; rowsRead: number | null; errorCode: string | null
}
export const QUERY_DURATION_SAMPLES = 256
interface Metrics { queries: number; errors: Record<string, number>; durations: number[]; next: number }
// Per database handle in this Worker isolate; bounded and deliberately non-durable.
const metrics = new WeakMap<D1Database, Metrics>()
export function queryMetrics(db: D1Database) {
  db = databaseIdentity(db)
  const state = metrics.get(db)
  const durations = [...state?.durations ?? []].sort((a, b) => a - b)
  const percentile = (p: number) => durations.length ? durations[Math.ceil(p * durations.length) - 1] : null
  return { queries: state?.queries ?? 0, errors: { ...state?.errors }, durationMs: { samples: durations.length, capacity: QUERY_DURATION_SAMPLES, p50: percentile(.5), p95: percentile(.95) } }
}
export function recordQuery(db: D1Database, log: QueryLog) {
  db = databaseIdentity(db)
  let state = metrics.get(db)
  if (!state) { state = { queries: 0, errors: {}, durations: [], next: 0 }; metrics.set(db, state) }
  state.queries++
  if (log.errorCode) state.errors[log.errorCode] = (state.errors[log.errorCode] ?? 0) + 1
  state.durations[state.next] = log.durationMs
  state.next = (state.next + 1) % QUERY_DURATION_SAMPLES
  console.log(JSON.stringify({ event: 'query', ...log }))
}
export function emptyQueryLog(scope: Scope, queryHash: string): QueryLog {
  return { queryHash, shape: { entity: null, depth: 0, relationCount: 0, selectCount: 0, includeCount: 0 },
    actorKind: scope.actor.type, tokenId: scope.actor.tokenId ?? null, organizationId: scope.organizationId,
    estimatedCost: null, bindingCount: 0, bindingHighWaterMark: 0, statementCount: 0,
    durationMs: 0, resultRows: 0, rowsRead: null, errorCode: null }
}
/** One surface log, including parse/translation errors and REST detail 404s. */
export async function observeQuery<T>(db: D1Database, scope: Scope, run: (capture: (log: QueryLog) => void, rejectedInput: (input: unknown) => Promise<void>) => Promise<T>): Promise<T> {
  const started = performance.now()
  let log = emptyQueryLog(scope, await inputHash(undefined))
  try { return await run(value => { log = value }, async input => { log.queryHash = await inputHash(input) }) }
  catch (error) { log.errorCode = error instanceof ApiError ? error.code : 'query_invalid'; log.resultRows = 0; throw error }
  finally { log.durationMs = performance.now() - started; recordQuery(db, log) }
}
