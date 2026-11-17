import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
/** Local synthetic fixture only: preserve nested D1 causes that HTTP errors omit. */
export function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []; const seen = new Set<unknown>()
  while (error != null && !seen.has(error)) {
    seen.add(error)
    if (!(error instanceof Error)) { chain.push(String(error)); break }
    chain.push({ name: error.name, message: error.message, stack: error.stack })
    error = error.cause
  }
  return chain
}
export function operationFor(method: string, path: string) {
  if (path === '/__test/c5') return 'fixture-mutation/barrier'
  if (method === 'GET' && path.startsWith('/workflows')) return 'browser-workflow-GET'
  if (path.includes('/workflows') && method === 'POST') return 'workflow-execution'
  return 'fixture-http'
}

// Observe at the D1 boundary before the product HTTP handler sanitizes errors.
// This adapter changes no retry/transaction behavior and preserves batch identity.
export function diagnosticDatabase(db: D1Database, report: (error: unknown) => void): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>()
  const call = async <T>(run: () => Promise<T>) => {
    try { return await run() } catch (error) { report(error); throw error }
  }
  const statement = (raw: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(raw, { get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => statement(target.bind(...values))
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? (...args: unknown[]) => call(() => value.apply(target, args)) : value
    } })
    originals.set(wrapped, raw)
    return wrapped
  }
  return new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => statement(target.prepare(sql))
    if (property === 'batch') return (items: D1PreparedStatement[]) => call(() => target.batch(items.map(item => originals.get(item) ?? item)))
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? (...args: unknown[]) => call(() => value.apply(target, args)) : value
  } })
}
