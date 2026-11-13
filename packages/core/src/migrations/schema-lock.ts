import type { InstanceConfig } from '../config'
import { physicalTables, renderTable, renderColumn, quote, type TableSpec } from './schema'
import type { SourceMap } from '../schema/load'

export interface SchemaLock { lockVersion: 1; revision: number; parent: null; tables: TableSpec[] }
export const lockBytes = (lock: SchemaLock) => JSON.stringify(lock, null, 2) + '\n'
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export class SpecError extends Error {
  constructor(readonly table: string, readonly column: string | undefined, message: string) {
    super(`${table}${column ? `.${column}` : ''}: ${message}`)
  }
}
/** Pure SQL-level diff: never reads config, files, source locations or SDK versions. */
export function diffSpecs(baseTables: readonly TableSpec[], tables: readonly TableSpec[]): string {
  const sql: string[] = []
  const reject = (table: string, column: string | undefined, reason: string): never => { throw new SpecError(table, column, reason) }
  for (const base of baseTables) {
    const table = tables.find(t => t.name === base.name)
    if (!table) reject(base.name, undefined, 'dropping or renaming a table is unsupported')
    for (const old of base.columns) {
      const column = table!.columns.find(c => c.name === old.name)
      if (!column) reject(base.name, old.name, 'dropping or renaming a column is unsupported')
      if (!equal(old, column)) reject(base.name, old.name, 'changing type/default/check/constraints is unsupported')
    }
    for (const column of table!.columns.filter(c => !base.columns.some(old => old.name === c.name))) {
      if (column.references || table!.foreignKeys.some(f => f.columns.includes(column.name))) reject(base.name, column.name, 'adding a reference to an existing table is unsupported')
      if (column.notNull && (column.defaultSql === null || column.defaultSql === 'NULL')) reject(base.name, column.name, 'NOT NULL additions require a non-null default')
      sql.push(`ALTER TABLE ${quote(base.name)} ADD COLUMN ${renderColumn(column)};`)
    }
    for (const key of ['unique', 'checks', 'foreignKeys', 'indexes'] as const) {
      if (!equal(base[key], table![key])) {
        const changed = [...base.foreignKeys, ...table!.foreignKeys].find(f => !base.foreignKeys.some(b => equal(b, f)) || !table!.foreignKeys.some(b => equal(b, f)))
        reject(base.name, key === 'foreignKeys' ? changed?.columns.at(-1) : undefined, `changing table ${key} is unsupported`)
      }
    }
  }
  for (const table of tables) if (!baseTables.some(t => t.name === table.name)) sql.push(renderTable(table))
  return sql.length ? sql.join('\n') + '\n' : ''
}
function located(error: unknown, sources: SourceMap): never {
  if (!(error instanceof SpecError)) throw error
  const path = `entities.${error.table}${error.column ? `.fields.${error.column}` : ''}`
  const source = sources[path] ?? sources[`entities.${error.table}`] ?? sources['']
  throw new Error(`${source ? `${source.file}:${source.line}` : 'config.ts:1'}: ${error.message}`)
}
export function schemaLock(config: InstanceConfig, base?: SchemaLock, sources: SourceMap = {}): SchemaLock {
  try {
    for (const [name, entity] of Object.entries(config.entities)) for (const [key, field] of Object.entries(entity.fields)) {
      if (field.renameFrom || field.backfillFrom) throw new SpecError(name, key, 'renameFrom/backfillFrom is unsupported')
    }
    const tables = physicalTables(config, base?.tables)
    const sql = diffSpecs(base?.tables ?? [], tables)
    return { lockVersion: 1, revision: base ? base.revision + Number(!!sql) : 1, parent: null, tables }
  } catch (error) { return located(error, sources) }
}
export function parseLock(bytes: string): SchemaLock {
  const value = JSON.parse(bytes) as SchemaLock
  if (value.lockVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.parent !== null || !Array.isArray(value.tables)) throw new Error('Invalid schema.lock.json: expected lockVersion=1, positive revision, parent=null and tables')
  return value
}
export function checkSchema(config: InstanceConfig, lock: SchemaLock, sources: SourceMap = {}) {
  const current = schemaLock(config, lock, sources)
  // Compare by column name while retaining the lock's order; diffSpecs names unsupported drift.
  const sql = diffSpecs(lock.tables, current.tables)
  if (sql) {
    const table = current.tables.find(t => !lock.tables.some(b => b.name === t.name) || !equal(t, lock.tables.find(b => b.name === t.name)))!
    const column = table.columns.find(c => !lock.tables.find(b => b.name === table.name)?.columns.some(b => equal(b, c)))
    located(new SpecError(table.name, column?.name, 'schema differs from schema.lock.json; regenerate the schema lock'), sources)
  }
  for (const [i, table] of physicalTables(config).entries()) {
    const previous = lock.tables.find(t => t.name === table.name)!
    const column = table.columns.find((column, i) => column.implicit && column.name !== previous.columns[i]?.name)
    if (lock.tables[i]?.name !== table.name || column) {
      located(new SpecError(table.name, column?.name, 'table/column order differs from the canonical physical schema'), sources)
    }
  }
}
/** SDK dependencies are derived, never versioned lock metadata. */
export function sdkDependencies(tables: readonly TableSpec[]) {
  return [...new Set(tables.flatMap(t => [...t.foreignKeys.map(f => f.table), ...t.columns.flatMap(c => c.references ? [c.references.table] : [])]))].filter(name => !tables.some(t => t.name === name)).sort()
}
