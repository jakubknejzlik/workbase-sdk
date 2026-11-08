import { baseFields, type InstanceConfig } from '../config'
import { quote } from '../migrations/schema'

/** Check the effective model plus columns referenced by fixed plugin SQL/routes. */
export async function checkInstanceSchema(db: D1Database, config: Pick<InstanceConfig, 'entities'>, dependencies: Record<string, readonly string[]>) {
  const tables = new Set([...Object.keys(config.entities), ...Object.keys(dependencies)])
  for (const table of tables) {
    const fields = new Set([...baseFields, ...Object.entries(config.entities[table]?.fields ?? {}).filter(([, field]) => !field.computed).map(([name]) => name), ...(dependencies[table] ?? [])])
    // Qualify identifiers so SQLite cannot treat an absent quoted column as a string.
    const columns = [...fields].map(field => `${quote(table)}.${quote(field)}`).join(',')
    await db.prepare(`SELECT ${columns} FROM ${quote(table)} LIMIT 0`).all()
  }
}
