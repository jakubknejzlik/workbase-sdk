import { entityConstraintsSchema, validateEntityConstraints, uniqueIndexName } from '../entity-constraints'
import { z } from 'zod'
import type { TableSpec } from '../migrations/schema'

export interface FieldLineage { id: string; logicalName: string; physicalName: string }
export interface EntityLineage extends FieldLineage { fields: FieldLineage[] }
export interface RenameTransition {
  id: string
  entityId: string
  fieldIds?: string[]
  from: { logical: string; physical: string }
  to: { logical: string; physical: string }
  /** field = dual_column; entity = view. No bridge SQL is emitted yet. */
  bridge: 'field' | 'entity'
  phase: 'expanded' | 'switched' | 'contracted'
}
export interface SchemaLock {
  lockVersion: 2 | 3; revision: number; parent: string | null; tables: TableSpec[]
  entities: EntityLineage[]; transitions: RenameTransition[]
}

const name = z.string().regex(/^[a-z][a-z0-9_]*$/)
const entityId = z.string().regex(/^ent_[a-z0-9_]+$/)
const fieldId = z.string().regex(/^fld_[a-z0-9_]+$/)
const column = z.strictObject({
  name, sqlType: z.enum(['TEXT', 'INTEGER', 'REAL']), notNull: z.boolean(), defaultSql: z.string().nullable(), checks: z.array(z.string()),
  implicit: z.boolean().optional(), primaryKey: z.boolean().optional(), references: z.strictObject({ table: name, column: name }).optional(),
})
const table = z.strictObject({
  name, columns: z.array(column), unique: z.array(z.array(name)), checks: z.array(z.string()),
  foreignKeys: z.array(z.strictObject({ columns: z.array(name), table: name, targetColumns: z.array(name) })),
  indexes: z.array(z.strictObject({ name, columns: z.array(name) })),
})
const header = { revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), parent: z.string().regex(/^[a-f0-9]{64}$/).nullable(), tables: z.array(table) }
const field = z.strictObject({ id: fieldId, logicalName: name, physicalName: name })
const names = z.strictObject({ logical: name, physical: name })
const lineage = {
  entities: z.array(z.strictObject({ id: entityId, logicalName: name, physicalName: name, fields: z.array(field) })),
  transitions: z.array(z.strictObject({ id: z.string().regex(/^tr_[a-z0-9_]+$/), entityId, fieldIds: z.array(fieldId).length(1).optional(), from: names, to: names, bridge: z.enum(['field', 'entity']), phase: z.enum(['expanded', 'switched', 'contracted']) })),
}
const format = z.discriminatedUnion('lockVersion', [
  z.strictObject({ lockVersion: z.literal(1), ...header }),
  z.strictObject({ lockVersion: z.literal(2), ...header, ...lineage }),
  z.strictObject({ lockVersion: z.literal(3), ...header, tables: z.array(table.extend({ constraints: entityConstraintsSchema.optional() })), ...lineage }),
])
// Injective encoding, rather than random IDs or a platform-specific hash. The
// initial physical path is an identity seed only; IDs never follow later names.
const seed = (value: string) => Array.from(value, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
export const initialEntityId = (physicalName: string) => `ent_${seed(physicalName)}`
export const initialFieldId = (entityId: string, physicalName: string) => `fld_${entityId.slice(4)}_${seed(physicalName)}`
export const transitionId = (entityId: string, fieldId: string | undefined, from: string, to: string, generation: number) => `tr_${entityId.slice(4)}_${fieldId?.slice(4) ?? 'entity'}_${seed(from)}_${seed(to)}_${generation}`
export function initialLineage(tables: readonly TableSpec[]): EntityLineage[] {
  return tables.map(table => {
    const id = initialEntityId(table.name)
    return { id, logicalName: table.name, physicalName: table.name, fields: table.columns.map(column => ({ id: initialFieldId(id, column.name), logicalName: column.name, physicalName: column.name })) }
  })
}
const invalid = (reason: string): never => { throw new Error(`Invalid schema.lock.json: ${reason}`) }
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) invalid(`duplicate ${label}`)
}
/** Worker-safe validation and deterministic v1 bootstrap; no IO, SQL or crypto. */
export function validateLock(input: unknown): SchemaLock {
  const parsed = format.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0].message)
  const value = parsed.data
  const lock: SchemaLock = value.lockVersion === 1
    ? { ...value, lockVersion: 2, entities: initialLineage(value.tables), transitions: [] }
    : value
  unique(lock.tables.map(t => t.name), 'physical table')
  unique(lock.tables.flatMap(t => [...t.indexes.map(i => i.name), ...(t.constraints ?? []).filter(c => c.kind === 'unique').map(c => uniqueIndexName(t.name, c.name))]), 'index name')
  const entities = Object.fromEntries(lock.tables.map(table => [table.name, { fields: Object.fromEntries(table.columns.map(c => {
    const ref = table.foreignKeys.find(f => f.columns.length === 2 && f.columns[0] === 'organization_id' && f.columns[1] === c.name && f.targetColumns.join(',') === 'organization_id,id')
    return [c.name, { ...c, ...(ref ? { type: 'ref', entity: ref.table } : {}) }]
  })) }]))
  for (const table of lock.tables) validateEntityConstraints(table.constraints ?? [], entities[table.name].fields, (_path, message) => invalid(`${table.name}: ${message}`), entities)
  unique(lock.entities.map(e => e.id), 'entity ID')
  unique(lock.entities.flatMap(e => e.fields.map(f => f.id)), 'field ID')
  unique(lock.entities.map(e => e.logicalName), 'logical entity')
  unique(lock.entities.map(e => e.physicalName), 'physical entity')
  if (lock.entities.length !== lock.tables.length) invalid('lineage must cover every physical table')
  for (const entity of lock.entities) {
    const table = lock.tables.find(t => t.name === entity.physicalName)
    if (!table) invalid(`missing physical table for ${entity.id}`)
    unique(table!.columns.map(c => c.name), 'physical column')
    unique(entity.fields.map(f => f.logicalName), 'logical field')
    unique(entity.fields.map(f => f.physicalName), 'physical field')
    if (entity.fields.length !== table!.columns.length || entity.fields.some(f => !table!.columns.some(c => c.name === f.physicalName))) invalid(`lineage must cover every physical column of ${entity.id}`)
  }
  unique(lock.transitions.map(t => t.id), 'transition ID')
  const open = new Set<string>()
  const history = new Map<string, RenameTransition>()
  const aliases = new Map<string, string>()
  for (const transition of lock.transitions) {
    const entity = lock.entities.find(e => e.id === transition.entityId)
    if (!entity) invalid(`unknown transition entity ${transition.entityId}`)
    if (open.has(transition.entityId)) invalid(`second open transition for ${transition.entityId}`)
    if (transition.phase !== 'contracted') open.add(transition.entityId)
    if (transition.from.logical === transition.to.logical || transition.from.physical === transition.to.physical) invalid(`transition ${transition.id} must rename both logical and physical names`)
    const target = transition.bridge === 'field' ? entity!.fields.find(f => f.id === transition.fieldIds?.[0]) : entity
    if (!target || (transition.bridge === 'entity' && transition.fieldIds !== undefined)) invalid(`invalid fieldIds for transition ${transition.id}`)
    if (transition.bridge === 'field' && lock.tables.find(t => t.name === entity!.physicalName)!.columns.find(c => c.name === target!.physicalName)?.implicit) invalid('implicit fields cannot be renamed')
    const peers = transition.bridge === 'field' ? entity!.fields : lock.entities
    for (const peer of peers) if (peer.id !== target!.id && [transition.from.logical, transition.to.logical].includes(peer.logicalName)) invalid(`logical collision in transition ${transition.id}`)
    for (const peer of peers) if (peer.id !== target!.id && [transition.from.physical, transition.to.physical].includes(peer.physicalName)) invalid(`physical collision in transition ${transition.id}`)
    // Historical aliases belong to the original ID, even after contraction.
    // Reassigning one would make stored names ambiguous for future readers.
    for (const side of [transition.from, transition.to]) for (const kind of ['logical', 'physical'] as const) {
      const alias = `${transition.bridge === 'field' ? entity!.id : 'entities'}:${kind}:${side[kind]}`
      const owner = aliases.get(alias)
      if (owner && owner !== target!.id) invalid(`historical name collision in transition ${transition.id}`)
      aliases.set(alias, target!.id)
    }
    const key = `${transition.bridge}:${target!.id}`
    const previous = history.get(key)
    if (previous && (previous.phase !== 'contracted' || previous.to.logical !== transition.from.logical || previous.to.physical !== transition.from.physical)) invalid(`broken history for transition ${transition.id}`)
    history.set(key, transition)
  }
  for (const transition of history.values()) {
    const entity = lock.entities.find(e => e.id === transition.entityId)!
    const target = transition.bridge === 'field' ? entity.fields.find(f => f.id === transition.fieldIds![0])! : entity
    const expected = transition.phase === 'expanded' ? transition.from : transition.to
    if (target.logicalName !== expected.logical || target.physicalName !== expected.physical) invalid(`mapping disagrees with transition ${transition.id}`)
  }
  return lock
}
