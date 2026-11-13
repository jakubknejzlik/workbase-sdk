import type { Schema } from './index'
export type RecordData = { id: string } & Record<string, unknown>
export interface DataStore {
  list(entity: string): RecordData[]
  get(entity: string, id: string): RecordData | undefined
  save(entity: string, id: string | undefined, values: Record<string, unknown>): RecordData
  related(entity: string, id: string, relation: string): RecordData[]
}
export function createMemoryStore(schema: Schema, seed: Record<string, readonly RecordData[]>): DataStore {
  const rows = structuredClone(seed) as Record<string, RecordData[]>
  const list = (entity: string) => rows[entity] ?? (rows[entity] = [])
  const get = (entity: string, id: string) => list(entity).find(row => row.id === id)
  return {
    list, get,
    save(entity, id, values) {
      if (!schema[entity]) throw new Error(`Unknown entity ${entity}`)
      let row = id ? get(entity, id) : undefined
      if (id && !row) throw new Error('Record not found')
      const next: Record<string, unknown> = {}
      for (const [name, field] of Object.entries(schema[entity].fields)) {
        const value = field.readOnly ? row?.[name] ?? field.default : values[name] ?? row?.[name] ?? field.default
        if (field.required && (value === undefined || value === '')) throw new Error(`Required field ${name}`)
        if (value !== undefined && value !== '') {
          if (field.type === 'enum' && !field.values?.includes(String(value))) throw new Error(`Invalid enum ${name}`)
          if (field.type === 'ref' && field.entity && !get(field.entity, String(value))) throw new Error(`Unknown reference ${name}`)
          if (['int', 'number'].includes(field.type) && (typeof value !== 'number' || !Number.isFinite(value) || field.type === 'int' && !Number.isInteger(value))) throw new Error(`Invalid number ${name}`)
          next[name] = value
        }
      }
      if (!row) {
        let counter = list(entity).length + 1
        while (get(entity, `record-${counter}`)) counter++
        row = { id: `record-${counter}` }
        list(entity).push(row)
      }
      Object.assign(row, next)
      return row
    },
    related(entity, id, relation) {
      const spec = schema[entity]?.relations[relation]
      if (!spec) throw new Error(`Unknown relation ${relation}`)
      if (spec.many) return list(spec.entity).filter(row => row[spec.field] === id)
      const row = get(spec.entity, String(get(entity, id)?.[spec.field] ?? ''))
      return row ? [row] : []
    },
  }
}
