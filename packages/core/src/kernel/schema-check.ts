import { uniqueIndexName } from '../entity-constraints'
import { baseFields, type InstanceConfig } from '../config'
import { quote, physicalTable, physicalTables, constraintTriggers, renderUniqueConstraint } from '../migrations/schema'

/** Check the effective model plus columns referenced by fixed plugin SQL/routes. */
export async function checkInstanceSchema(db: D1Database, config: Pick<InstanceConfig, 'entities'>, dependencies: Record<string, readonly string[]>) {
  const tables = new Set([...Object.keys(config.entities), ...Object.keys(dependencies)])
  for (const table of tables) {
    const fields = new Set([...baseFields, ...Object.entries(config.entities[table]?.fields ?? {}).filter(([, field]) => !field.computed).map(([name]) => name), ...(dependencies[table] ?? [])])
    // Qualify identifiers so SQLite cannot treat an absent quoted column as a string.
    const columns = [...fields].map(field => `${quote(table)}.${quote(field)}`).join(',')
    await db.prepare(`SELECT ${columns} FROM ${quote(table)} LIMIT 0`).all()
  }
  await checkEntityConstraints(db, config)
}

/** Used by health and deployment verification, independently of plugin checks. */
export async function checkEntityConstraints(db: D1Database, config: Pick<InstanceConfig, 'entities'>) {
  for (const [table, entity] of Object.entries(config.entities)) {
    for (const constraint of entity.constraints ?? []) {
      if (constraint.kind !== 'unique') {
        const definition = constraintTriggers(physicalTable(table, entity), constraint, physicalTables(config))
        for (const object of definition.setup ?? []) {
          const stored = await db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').bind('table', object.name).first<{ sql: string }>()
          if (stored?.sql !== object.sql.replace(/;$/, '')) throw new Error(`Schema drift: missing or changed ref immutable constraint ${table}.${constraint.name}`)
        }
        for (const trigger of definition.triggers) {
          const definition = await db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').bind('trigger', trigger.name).first<{ sql: string }>()
          if (definition?.sql !== trigger.sql.replace(/;$/, '')) throw new Error(`Schema drift: missing or changed ${constraint.kind.replace('_', ' ')} constraint ${table}.${constraint.name}`)
        }
        continue
      }
      const index = uniqueIndexName(table, constraint.name)
      const meta = await db.prepare('SELECT * FROM pragma_index_list(?) WHERE name=?').bind(table, index).first<{ unique: number; partial: number; origin: string }>()
      const columns = await db.prepare('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno').bind(index).all<{ name: string; coll: string; desc: number; key: number }>()
      const keys = columns.results.filter(column => column.key === 1)
      const expected = ['organization_id', ...constraint.fields]
      const definition = constraint.where ? await db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').bind('index', index).first<{ sql: string }>() : undefined
      if (meta?.unique !== 1 || meta.partial !== Number(!!constraint.where) || meta.origin !== 'c' || keys.length !== expected.length
        || (constraint.where && definition?.sql !== renderUniqueConstraint(table, constraint).replace(/;$/, ''))
        || keys.some((key, i) => key.name !== expected[i] || key.coll !== 'BINARY' || key.desc !== 0)) {
        throw new Error(`Schema drift: missing or changed unique constraint ${table}.${constraint.name}`)
      }
    }
  }
}
