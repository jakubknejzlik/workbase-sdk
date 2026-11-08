export function instrument(db: D1Database) {
  const statements: string[] = []
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { statements.push(sql); return target.prepare(sql) }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { db: wrapped, statements }
}
