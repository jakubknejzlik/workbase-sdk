// Local D1 uses a separate workerd from wrangler dev, with no SQLite busy handler.
// Keep this workaround in the harness: real SQL/constraint errors must still fail tests.
function isBusy(error: unknown): boolean {
  const seen = new Set<unknown>()
  const messages: string[] = []
  while (error != null && !seen.has(error)) {
    seen.add(error)
    messages.push(String(error))
    error = error instanceof Error ? error.cause : undefined
  }
  return /SQLITE_BUSY|database is locked|D1_ERROR[\s\S]*internal error/i.test(messages.join('\n'))
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10000
  let delay = 25
  let original: unknown
  for (;;) {
    try { return await operation() } catch (error) {
      if (!isBusy(error)) throw error
      original ??= error
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw original
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)))
      delay *= 2
    }
  }
}

export function withD1Retry(database: D1Database): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>()
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
        const value = Reflect.get(target, property, target)
        if (['run', 'all', 'first', 'raw'].includes(String(property))) {
          return (...args: unknown[]) => retry(() => Promise.resolve(Reflect.apply(value, target, args)))
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    originals.set(wrapped, statement)
    return wrapped
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      // Miniflare's RPC must receive its own statement objects, not our proxies.
      if (property === 'batch') return (statements: D1PreparedStatement[]) =>
        retry(() => target.batch(statements.map(statement => originals.get(statement) ?? statement)))
      if (property === 'exec') return (sql: string) => retry(() => target.exec(sql))
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
