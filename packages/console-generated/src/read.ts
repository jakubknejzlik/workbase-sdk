import { availableCalendar } from './calendar-model'
import { detailPlan, detailReadableField } from './detail-plan'
import type { ListHints } from './list-model'
import type { ConsoleEntityDisplay } from '../../plugins/console/src/contract'
export interface Field { type: string; operators?: string[]; values?: string[]; entity?: string; required?: boolean; readOnly?: boolean; sensitive?: boolean; ui?: { hidden?: boolean; format?: 'identifier'; kind?: string; span?: string; section?: string; signedBy?: { field: string; negativeValue: string } } }
export interface Relation { entity: string; field: string; cardinality: string; quantifiers?: string[]; through?: { entity: string; field: string; createCommand: string; deleteCommand: string } }
export type DetailHints = NonNullable<ConsoleEntityDisplay['detail']>
export interface Entity { rowInvitations?: boolean; views?: ConsoleEntityDisplay['views']; labelDependencies?: { entity: string; field: string }[]; form?: ConsoleEntityDisplay['form']; sections?: ConsoleEntityDisplay['sections']; detail?: DetailHints; lookup?: boolean; list?: ListHints; listLimit?: number; writeSchema?: Record<string, any>; updateSchema?: Record<string, any>; fields: Record<string, Field>; columns: string[]; listColumns?: string[]; relations: Record<string, Relation>; displayField?: string; routes: { list: string; detail: string } }
export interface Model { instance: string; revision: number; limits: { root: number; children: number; relations: number; exists: number; [key: string]: number }; entities: Record<string, Entity>; commands?: Command[]; pickerHints?: Record<string, Record<string, { wizard?: boolean; labelTemplate?: string }>> }
export interface Command { name: string; ui?: { placement?: { entity: string; action: 'create' }; labelKey?: string; label?: string | { en: string; cs: string }; replacesCrud?: string }; permission: { entity: string; operation: string }; additionalPermissions?: { entity: string; operation: string }[]; inputSchema: Record<string, any> }
export interface Capabilities { commands?: string[]; revision: number; organization?: { role: string }; entities: Record<string, { readable: string[]; writable: string[]; operations: string[]; displayField?: string }> }
export interface Selection { labels?: string[]; select: string[]; limit?: number; include?: Record<string, Selection> }
export interface ReadQuery extends Selection { contextList?: { entity: string; list: string; id: string }; search?: { text: string; fields: string[]; locale?: 'en' | 'cs' }; labelWhere?: Record<string, { contains: string; locale?: 'en' | 'cs' }>; entity: string; limit: number; where?: Record<string, unknown>; orderBy?: { field: string; dir: 'asc' | 'desc'; label?: boolean }[]; cursor?: string }
export interface ReadOptions { id?: string; purpose?: 'edit'; search?: string; filters?: Record<string, string>; sort?: string; descending?: boolean; cursor?: string }
export interface Result { data: Record<string, any>[]; next_cursor: string | null }
export function visibleEntities(model: Model, caps: Capabilities) { return Object.keys(model.entities).filter(name => caps.entities[name]?.operations.includes('read') && caps.entities[name].readable.includes('id')) }
export function projection(model: Model, entity: string, caps: Capabilities) { return Object.keys(model.entities[entity]?.fields ?? {}).filter(field => caps.entities[entity]?.readable.includes(field)) }
/** Search covers rendered columns and calendar operands; hints only add fields. */
export function listSearchableFields(model: Model, entity: string, caps: Capabilities, presentation?: 'table' | 'calendar') {
  const definition = model.entities[entity]; const readable = projection(model, entity, caps)
  const display = caps.entities[entity]?.displayField ?? definition.displayField
  const columns = definition.list?.columns ?? definition.listColumns ?? [...(display ? [display] : []), ...definition.columns]
  const calendar = presentation === 'calendar' ? availableCalendar(model, entity, caps) : undefined
  const calendarFields = calendar ? [calendar.startField, calendar.endField, calendar.titleField, ...(calendar.titleFields ?? []), calendar.secondaryField, caps.entities[entity]?.displayField ?? definition.displayField].filter((field): field is string => !!field) : []
  return [...new Set([...columns, ...(definition.list?.search ?? []), ...calendarFields])].filter(key => {
    const related = definition.list?.relatedColumns?.[key]
    return related ? readable.includes(related.via) : readable.includes(key) && definition.fields[key]?.type !== 'json'
  })
}
export function searchableFields(model: Model, entity: string, caps: Capabilities) {
  const definition = model.entities[entity]; const select = projection(model, entity, caps)
  const display = caps.entities[entity]?.displayField ?? definition.displayField
  const strings = select.filter(field => (definition.list?.search ? definition.list.search.includes(field) : field === display || definition.columns.includes(field)) && ['string', 'text'].includes(definition.fields[field].type))
  return strings.length || definition.list?.search ? strings : select.includes('id') ? ['id'] : []
}
export function displayName(entity: Entity, row: Record<string, any>, caps?: Capabilities['entities'][string]) { const field = caps?.displayField ?? entity.displayField; return field && !['id', 'organization_id'].includes(field) && (!caps || caps.readable.includes(field)) && row[field] != null && String(row[field]).trim() ? String(row[field]) : '' }
export { formatValue, formatFieldValue, recordLabel } from './labels'
/** RFC 0005 decision 6; complex models also load to-one relations independently. */
export function separateRelations(model: Model) {
  const refs = (name: string) => Object.values(model.entities[name].fields).filter(field => field.type === 'ref').length
  // Each traversal consumes a relation predicate in addition to its target refs.
  return Object.entries(model.entities).some(([name, entity]) => refs(name) + Object.values(entity.relations).reduce((sum, relation) => sum + 1 + refs(relation.entity), 0) > model.limits.exists)
}
export function readableRelations(model: Model, entity: string, caps: Capabilities) {
  return Object.entries(model.entities[entity].relations).filter(([, relation]) => {
    const target = caps.entities[relation.entity]; const fkEntity = relation.cardinality === '1:n' ? relation.entity : entity
    return (!relation.through || caps.entities[relation.through.entity]?.operations.includes('read') && caps.entities[relation.through.entity]?.readable.includes('id') && target?.readable.includes(relation.through.field)) && target?.operations.includes('read') && target.readable.includes('id') && caps.entities[fkEntity]?.readable.includes(relation.field)
  })
}
export function relationQuery(model: Model, entity: string, name: string, row: Record<string, any>, caps: Capabilities, cursor?: string): ReadQuery {
  const relation = model.entities[entity].relations[name]
  const many = relation.cardinality === '1:n'
  const sort = model.entities[entity].detail?.relations?.[name]?.defaultSort
  const order = sort && caps.entities[relation.entity]?.readable.includes(sort.key) ? { field: sort.key, dir: sort.direction } : { field: 'id', dir: 'asc' as const }
  const target = model.entities[relation.entity]; const readable = projection(model, relation.entity, caps)
  const columns = model.entities[entity].detail?.relations?.[name]?.columns.filter(field => readable.includes(field))
  const projected = model.entities[entity].detail?.groups && columns ? [...new Set(['id', ...(relation.through ? [relation.through.field] : columns), ...columns.flatMap(field => target.fields[field]?.ui?.signedBy ? [target.fields[field].ui!.signedBy!.field] : [])])].filter(field => readable.includes(field) && (field !== target.displayField || !target.labelDependencies || detailReadableField(model, relation.entity, caps, field))) : readable
  const labels = projected.filter(field => target.fields[field]?.type === 'ref')
  return { entity: relation.entity, select: projected, ...(model.entities[entity].detail?.groups && labels.length ? { labels } : {}), limit: many ? Math.min(10, model.limits.children, model.limits.root) : 1,
    where: { [many ? relation.field : 'id']: { eq: many ? row.id : row[relation.field] } }, orderBy: [order], ...(cursor ? { cursor } : {}) }
}
export function readQuery(model: Model, entity: string, caps: Capabilities, options: ReadOptions = {}): ReadQuery {
  const definition = model.entities[entity]; const plan = options.id && options.purpose !== 'edit' ? detailPlan(model, entity, caps) : undefined; const select = plan?.select ?? projection(model, entity, caps); const include: Record<string, Selection> = {}
  for (const [name, relation] of (separateRelations(model) || options.id && (definition.detail || Object.values(definition.relations).some(relation => relation.through)) ? [] : Object.entries(definition.relations).slice(0, model.limits.relations))) {
    const target = caps.entities[relation.entity]; const fkEntity = relation.cardinality === '1:n' ? relation.entity : entity
    if (relation.cardinality === '1:n' || relation.through || !target?.operations.includes('read') || !target.readable.includes('id') || !caps.entities[fkEntity]?.readable.includes(relation.field)) continue
    const fields = projection(model, relation.entity, caps)
    const display = target.displayField ?? model.entities[relation.entity].displayField
    include[name] = { select: options.id ? fields : fields.filter(field => field === 'id' || field === display), limit: Math.min(10, model.limits.children) }
  }
  const query: ReadQuery = { entity, limit: options.id ? 1 : Math.min(definition.listLimit ?? 10, model.limits.root), select, include }
  if (options.id) {
    query.where = { id: { eq: options.id } }
    const labels = plan?.labels ?? select.filter(field => definition.fields[field]?.type === 'ref')
    if (options.purpose !== 'edit' && labels.length) query.labels = labels
    return query
  }
  const conditions: Record<string, unknown>[] = []
  const strings = searchableFields(model, entity, caps)
  if (options.search?.trim() && strings.length) conditions.push({ or: strings.map(field => ({ [field]: { contains: options.search!.trim() } })) })
  for (const [field, value] of Object.entries(options.filters ?? {})) {
    if (!value || !select.includes(field)) continue
    const type = definition.fields[field].type
    if (type === 'enum') conditions.push({ [field]: { eq: value } })
    if (type === 'bool') conditions.push({ [field]: { eq: value === 'true' } })
    if (['date', 'datetime'].includes(type)) conditions.push({ [field]: { gte: type === 'date' ? value : `${value}T00:00:00.000Z` } })
  }
  if (conditions.length) query.where = { and: conditions }
  const sort = options.sort && select.includes(options.sort) && definition.fields[options.sort].type !== 'json' ? options.sort : 'id'
  query.orderBy = [{ field: sort, dir: options.descending ? 'desc' : 'asc' }]
  if (options.cursor) query.cursor = options.cursor
  return query
}
