import { AsyncLocalStorage } from 'node:async_hooks'

interface Trace { started: number; spans: Map<string, number>; roundTrips: number }
const traces = new AsyncLocalStorage<Trace>()

export function timedSync<T>(name: string, run: () => T): T {
  const trace = traces.getStore()
  const start = performance.now()
  try { return run() }
  finally { if (trace) trace.spans.set(name, (trace.spans.get(name) ?? 0) + performance.now() - start) }
}

/** Request-local only. Names are fixed by code; never record SQL, URLs or credentials. */
export async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const trace = traces.getStore()
  if (!trace) return run()
  const start = performance.now()
  try { return await run() }
  finally { trace.spans.set(name, (trace.spans.get(name) ?? 0) + performance.now() - start) }
}

export async function timeRequest(run: () => Promise<Response>): Promise<Response> {
  if (traces.getStore()) return run()
  const trace: Trace = { started: performance.now(), spans: new Map(), roundTrips: 0 }
  return traces.run(trace, async () => {
    const response = await run()
    const total = performance.now() - trace.started
    const spans = ['bootstrap', 'schema', 'auth', 'scope', 'handler', 'd1'].map(name => `${name};dur=${(trace.spans.get(name) ?? 0).toFixed(2)}`)
    spans.push(`d1_roundtrips;desc="${trace.roundTrips}"`, `total;dur=${total.toFixed(2)}`)
    const headers = new Headers(response.headers)
    headers.set('Server-Timing', spans.join(', '))
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  })
}

const databases = new WeakMap<D1Database, D1Database>()
const databaseBindings = new WeakMap<D1Database, D1Database>()
/** Preserve database identity for metrics/provenance shared with non-HTTP callers. */
export const databaseIdentity = (db: D1Database): D1Database => databaseBindings.get(db) ?? db
/** Stable adapter identity preserves isolate caches; ALS attributes concurrent I/O to its request. */
export function timedDatabase(db: D1Database): D1Database {
  const existing = databases.get(db)
  if (existing) return existing
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>()
  const call = <T>(run: () => Promise<T>) => {
    const trace = traces.getStore()
    if (trace) trace.roundTrips++
    return timed('d1', run)
  }
  const statement = (raw: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(raw, { get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => statement(target.bind(...values))
      const value = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => call(() => value.apply(target, args))
    } })
    originals.set(wrapped, raw)
    return wrapped
  }
  const wrapped = new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => statement(target.prepare(sql))
    if (property === 'batch') return (statements: D1PreparedStatement[]) => call(() => target.batch(statements.map(item => originals.get(item) ?? item)))
    const value = Reflect.get(target, property)
    if (typeof value !== 'function') return value
    return (...args: unknown[]) => call(() => value.apply(target, args))
  } })
  databases.set(db, wrapped)
  databases.set(wrapped, wrapped)
  databaseBindings.set(wrapped, db)
  return wrapped
}
