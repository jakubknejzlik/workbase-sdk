import type { InstanceConfig } from '../config'
import { physicalTables, renderTable, renderColumn, renderUniqueConstraint, constraintTriggers, dropConstraint, quote, type TableSpec } from './schema'
import type { SourceMap } from '../schema/source-location'
import { initialEntityId, initialFieldId, transitionId, validateLock, type EntityLineage, type RenameTransition, type SchemaLock } from '../schema/lock-format'
export type { SchemaLock, EntityLineage, FieldLineage, RenameTransition } from '../schema/lock-format'

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
    for (const old of base.constraints ?? []) {
      const current = table!.constraints?.find(c => c.name === old.name)
      if (current && (old.kind !== current.kind || (old.kind === 'unique' && current.kind === 'unique' ? !equal(old.fields, current.fields) : !equal(old, current)))) reject(base.name, undefined, `changing constraint ${old.name} is unsupported; use a new name`)
      if (!current || !equal(old, current)) sql.push(dropConstraint(base, old))
    }
    for (const constraint of table!.constraints ?? []) if (constraint.kind === 'unique' && !base.constraints?.some(c => equal(c, constraint))) sql.push(renderUniqueConstraint(table!.name, constraint))
    for (const key of ['unique', 'checks', 'foreignKeys', 'indexes'] as const) {
      if (!equal(base[key], table![key])) {
        const changed = [...base.foreignKeys, ...table!.foreignKeys].find(f => !base.foreignKeys.some(b => equal(b, f)) || !table!.foreignKeys.some(b => equal(b, f)))
        reject(base.name, key === 'foreignKeys' ? changed?.columns.at(-1) : undefined, `changing table ${key} is unsupported`)
      }
    }
  }
  for (const table of tables) if (!baseTables.some(t => t.name === table.name)) sql.push(renderTable(table))
  for (const table of tables) for (const constraint of table.constraints ?? []) {
    if (constraint.kind !== 'ref_equality' || !baseTables.find(t => t.name === table.name)?.constraints?.some(c => equal(c, constraint))) continue
    const before = constraintTriggers(table, constraint, baseTables).triggers
    for (const trigger of constraintTriggers(table, constraint, tables).triggers) {
      if (before.find(t => t.name === trigger.name)?.sql !== trigger.sql) sql.push(`DROP TRIGGER ${quote(trigger.name)};`, trigger.sql)
    }
  }
  for (const table of tables) for (const constraint of table.constraints ?? []) {
    if (constraint.kind === 'unique' || baseTables.find(t => t.name === table.name)?.constraints?.some(c => equal(c, constraint))) continue
    const definition = constraintTriggers(table, constraint, tables)
    sql.push(...(definition.setup?.map(t => t.sql) ?? []), ...(definition.preflight ? [definition.preflight] : []), ...definition.triggers.map(t => t.sql))
  }
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
    const previous = base && validateLock(base)
    if (previous && (previous.tables.some(t => t.constraints?.some(c => c.kind !== 'unique')) || Object.values(config.entities).some(e => e.constraints?.some(c => c.kind !== 'unique')))
      && Object.values(config.entities).some(e => e.renameFrom || Object.values(e.fields).some(f => f.renameFrom))) throw new SpecError('', undefined, 'Renaming a trigger-constrained graph (ref equality / ref immutability) requires a manually reviewed migration')
    const transitions = previous ? structuredClone(previous.transitions) : []
    const entities: EntityLineage[] = []
    const normalized = { account: config.account, entities: {} as InstanceConfig['entities'] }
    const entityNames = new Map<string, string>()
    const intents: { name: string; field?: string; transition: RenameTransition }[] = []
    const usedEntities = new Set<string>()
    const record = (name: string, field: string | undefined, entity: EntityLineage, from: { logical: string; physical: string }, to: string, fieldId?: string) => {
      const existing = transitions.find(t => t.entityId === entity.id && t.phase !== 'contracted')
      if (existing) {
        if (existing.bridge === (fieldId ? 'field' : 'entity') && existing.fieldIds?.[0] === fieldId && equal(existing.from, from) && existing.to.logical === to) {
          intents.push({ name, field, transition: existing }); return
        }
        throw new SpecError(name, field, `second open transition for ${entity.id}; finish transition ${existing.id} first`)
      }
      // History is append-only. Include its generation and skip any ID already
      // present, including IDs assigned by an earlier writer.
      let generation = transitions.length + 1
      let id = transitionId(entity.id, fieldId, from.logical, to, generation)
      while (transitions.some(t => t.id === id)) id = transitionId(entity.id, fieldId, from.logical, to, ++generation)
      const transition: RenameTransition = { id, entityId: entity.id, ...(fieldId ? { fieldIds: [fieldId] } : {}), from, to: { logical: to, physical: to }, bridge: fieldId ? 'field' : 'entity', phase: 'expanded' }
      transitions.push(transition); intents.push({ name, field, transition })
    }
    // Authoring uses renameFrom at both levels. Expanded locks keep the source
    // mapping; the target is intent data until the separate switch slice.
    for (const [name, input] of Object.entries(config.entities).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (name === config.account?.entity) {
        if (input.renameFrom || Object.values(input.fields).some(f => f.renameFrom || f.backfillFrom)) throw new SpecError(name, undefined, 'SDK account migration intents are unsupported')
        normalized.entities[name] = { ...input, fields: { ...input.fields } }
        continue
      }
      const source = input.renameFrom ?? name
      const old = previous?.entities.find(e => e.logicalName === source)
      if (input.renameFrom && (!old || source === name || Object.hasOwn(config.entities, source) || previous?.entities.some(e => e.logicalName === name || e.physicalName === name))) throw new SpecError(name, undefined, 'ambiguous/missing source or collision for entity renameFrom')
      if (old && usedEntities.has(old.id)) throw new SpecError(name, undefined, 'ambiguous entity renameFrom: source reused')
      if (old) usedEntities.add(old.id)
      const entity: EntityLineage = old ? structuredClone(old) : { id: initialEntityId(name), logicalName: name, physicalName: name, fields: [] }
      if (input.renameFrom) record(name, undefined, entity, { logical: source, physical: entity.physicalName }, name)
      entityNames.set(name, entity.physicalName)
      const fields: typeof input.fields = {}
      const fieldNames = new Map<string, string>()
      const usedFields = new Set<string>()
      for (const [key, field] of Object.entries(input.fields)) {
        if (field.backfillFrom) throw new SpecError(name, key, 'backfillFrom is unsupported')
        if (field.computed) {
          if (field.renameFrom) throw new SpecError(name, key, 'computed renameFrom is unsupported')
          fields[key] = field; continue
        }
        const source = field.renameFrom ?? key
        const oldField = old?.fields.find(f => f.logicalName === source)
        const oldColumn = previous?.tables.find(t => t.name === old?.physicalName)?.columns.find(c => c.name === oldField?.physicalName)
        if (field.renameFrom && (!oldField || oldColumn?.implicit || source === key || Object.hasOwn(input.fields, source) || old?.fields.some(f => f.logicalName === key || f.physicalName === key))) throw new SpecError(name, key, 'ambiguous/missing source or collision for field renameFrom')
        if (oldField && usedFields.has(oldField.id)) throw new SpecError(name, key, 'ambiguous field renameFrom: source reused')
        if (oldField) usedFields.add(oldField.id)
        const physical = oldField?.physicalName ?? key
        if (field.renameFrom) record(name, key, entity, { logical: source, physical }, key, oldField!.id)
        fieldNames.set(key, physical)
        fields[physical] = { ...field, renameFrom: undefined }
      }
      normalized.entities[entity.physicalName] = { ...input, renameFrom: undefined, fields,
        ...(input.constraints?.length ? { constraints: input.constraints.map(c => c.kind !== 'unique' ? c : ({ ...c, fields: c.fields.map(key => fieldNames.get(key) ?? key), ...(c.where ? { where: { ...c.where, field: fieldNames.get(c.where.field) ?? c.where.field } } : {}) })) } : {}),
        checks: input.checks.map(c => ({ ...c, left: fieldNames.get(c.left) ?? c.left, right: fieldNames.get(c.right) ?? c.right })),
      }
      entities.push(entity)
    }
    for (const entity of Object.values(normalized.entities)) entity.fields = Object.fromEntries(Object.entries(entity.fields).map(([key, field]) => [key,
      field.type === 'ref' && field.entity && entityNames.has(field.entity) ? { ...field, entity: entityNames.get(field.entity)! } : field,
    ]))
    const tables = physicalTables(normalized, previous?.tables)
    // Every rename must be definition-preserving and isolated from other schema
    // edits. Diffing the source projection checks defaults, checks, FK and indexes.
    const sql = diffSpecs(previous?.tables ?? [], tables)
    const open = transitions.find(t => t.phase !== 'contracted')
    if (open && sql) throw new SpecError(intents[0]?.name ?? entities.find(e => e.id === open.entityId)!.logicalName, intents[0]?.field, 'rename + definition change or unrelated schema edit is unsupported')
    for (const entity of entities) {
      const table = tables.find(t => t.name === entity.physicalName)!
      entity.fields = table.columns.map(c => entity.fields.find(f => f.physicalName === c.name) ?? { id: initialFieldId(entity.id, c.name), logicalName: c.name, physicalName: c.name })
    }
    const changed = !!sql || !equal(transitions, previous?.transitions ?? [])
    return validateLock({ lockVersion: previous?.lockVersion === 3 || tables.some(t => t.constraints?.length) ? 3 : 2, revision: previous ? previous.revision + Number(changed) : 1, parent: previous?.parent ?? null, tables, entities, transitions })
  } catch (error) { return located(error, sources) }
}
export function parseLock(bytes: string): SchemaLock {
  let value: unknown
  try { value = JSON.parse(bytes) } catch { throw new Error('Invalid schema.lock.json: malformed JSON') }
  return validateLock(value)
}
export function checkSchema(config: InstanceConfig, lock: SchemaLock, sources: SourceMap = {}) {
  lock = validateLock(lock)
  const current = schemaLock(config, lock, sources)
  const canonical = physicalTables(config)
  for (const [i, table] of current.tables.entries()) {
    const previous = lock.tables.find(t => t.name === table.name)!
    const entity = current.entities.find(e => e.physicalName === table.name)!
    const intent = current.transitions.find(t => t.entityId === entity.id && t.bridge === 'entity' && t.phase === 'expanded')
    const expected = canonical.find(t => t.name === entity.logicalName || t.name === intent?.to.logical)
    const column = expected?.columns.find((column, i) => column.implicit && column.name !== previous?.columns[i]?.name)
    if (previous && (lock.tables[i]?.name !== table.name || column)) located(new SpecError(entity.logicalName, column?.name, 'table/column order differs from the canonical physical schema'), sources)
  }
  // Compare by column name while retaining the lock's order; diffSpecs names unsupported drift.
  const sql = diffSpecs(lock.tables, current.tables)
  if (sql || !equal(current.entities, lock.entities) || !equal(current.transitions, lock.transitions)) {
    if (!sql) located(new SpecError(current.entities[0]?.logicalName ?? '', undefined, 'lineage differs from schema.lock.json; regenerate the schema lock'), sources)
    const table = current.tables.find(t => !lock.tables.some(b => b.name === t.name) || !equal(t, lock.tables.find(b => b.name === t.name)))!
    const column = table.columns.find(c => !lock.tables.find(b => b.name === table.name)?.columns.some(b => equal(b, c)))
    located(new SpecError(table.name, column?.name, 'schema differs from schema.lock.json; regenerate the schema lock'), sources)
  }
}
/** SDK dependencies are derived, never versioned lock metadata. */
export function sdkDependencies(tables: readonly TableSpec[]) {
  return [...new Set(tables.flatMap(t => [...t.foreignKeys.map(f => f.table), ...t.columns.flatMap(c => c.references ? [c.references.table] : [])]))].filter(name => !tables.some(t => t.name === name)).sort()
}
