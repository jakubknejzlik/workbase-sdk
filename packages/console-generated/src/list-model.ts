import { availableCalendar, calendarQuery, dayKey, validDay, type CalendarMode } from './calendar-model'
import { filterableFields, filterKind, filterMapping, selectionCap, type FilterKind } from './filter-kinds'
import { projection, listSearchableFields, type Model, type Capabilities, type ReadQuery, type RowAccessState } from './read'
export interface ListHints {
  compact?: boolean; mobileCards?: boolean
  filter?: Record<string, false | FilterKind>
  views?: { id: string; label: string; where: Record<string, unknown>; default?: boolean }[]
  columns?: string[]
  relatedColumns?: Record<string, { via: string; field: string }>
  defaultSort?: { key: string; direction: 'asc' | 'desc' }
  pageSize?: number
  search?: string[]
  sort?: Record<string, false | { fields: string[] }>
}
export interface ListFilter { field: string; predicate: Record<string, unknown> }
export interface ListState {
  rowAccess?: RowAccessState
  presentation?: 'table' | 'calendar'
  calendarMode?: CalendarMode
  calendarDate?: string
  search: string
  view?: string
  sort: { key: string; direction: 'asc' | 'desc' } | null
  userFilters: ListFilter[]
  presetFilters: ListFilter[]
  cursor?: string
  limit: number
}
export interface ListSearch { rowAccess?: RowAccessState; presentation?: 'table' | 'calendar'; calendarMode?: CalendarMode; calendarDate?: string; invalidSettings?: boolean; filters?: ListFilter[]; view?: string; search?: string; sort?: string; direction?: 'asc' | 'desc'; pageSize?: number }
export const pageSizes = [10, 20, 30, 50, 100] as const
/** Router validator: excludes actor-bound cursors; field/kind validation follows against capabilities. */
export function validateListSearch(input: Record<string, unknown>): ListSearch {
  const result: ListSearch = input.invalidSettings === true ? { invalidSettings: true } : {}
  if (typeof input.view === 'string' && /^[a-z][a-z0-9_]*$/.test(input.view)) result.view = input.view
  else if (input.view !== undefined) result.invalidSettings = true
  if (input.presentation === 'table' || input.presentation === 'calendar') result.presentation = input.presentation
  else if (input.presentation !== undefined) result.invalidSettings = true
  if (input.calendarMode === 'month' || input.calendarMode === 'week') result.calendarMode = input.calendarMode
  else if (input.calendarMode !== undefined) result.invalidSettings = true
  if (validDay(input.calendarDate)) result.calendarDate = input.calendarDate
  else if (input.calendarDate !== undefined) result.invalidSettings = true
  if (typeof input.rowAccess === 'string' && ['no_account', 'invited', 'expired', 'signed_in'].includes(input.rowAccess)) result.rowAccess = input.rowAccess as RowAccessState
  else if (input.rowAccess !== undefined) result.invalidSettings = true
  let filters = input.filters
  if (typeof filters === 'string' && filters.length <= 64000) { try { filters = JSON.parse(filters) } catch { filters = undefined; result.invalidSettings = true } }
  if (Array.isArray(filters) && filters.length <= 100) result.filters = filters.filter((filter): filter is ListFilter => !!filter && typeof filter === 'object' && typeof filter.field === 'string' && /^[a-z][a-z0-9_]*$/.test(filter.field) && !!filter.predicate && typeof filter.predicate === 'object' && !Array.isArray(filter.predicate))

  if (input.filters !== undefined && (!Array.isArray(filters) || filters.length > 100 || result.filters?.length !== filters.length)) result.invalidSettings = true
  if (typeof input.search === 'string' && input.search) result.search = input.search.slice(0, 2000)
  if (typeof input.sort === 'string' && /^[a-z][a-z0-9_]*$/.test(input.sort)) {
    result.sort = input.sort
    result.direction = input.direction === 'desc' ? 'desc' : 'asc'
  }
  const size = Number(input.pageSize)
  if (pageSizes.includes(size as any)) result.pageSize = size
  return result
}
export function defaultListState(model: Model, entity: string): ListState {
  const hints = model.entities[entity].list
  return { ...(hints?.views?.find(view => view.default) ? { view: hints.views.find(view => view.default)!.id } : {}), search: '', sort: hints?.defaultSort ?? null, userFilters: [], presetFilters: [], limit: hints?.pageSize ?? 30 }
}
/** Ref sorting remains available for denied targets: their key is uniformly null. */
export function labelColumns(model: Model, entity: string, caps: Capabilities) {
  const definition = model.entities[entity]
  return [...Object.keys(definition.fields).filter(key => definition.fields[key].type === 'ref' && caps.entities[entity]?.readable.includes(key)),
    ...Object.entries(definition.list?.relatedColumns ?? {}).filter(([, column]) => caps.entities[entity]?.readable.includes(column.via)).map(([key]) => key)]
}
function sortFields(model: Model, entity: string, caps: Capabilities, key: string): string[] {
  const definition = model.entities[entity]; const hint = definition.list?.sort?.[key]
  if (labelColumns(model, entity, caps).includes(key)) return [key]
  if (hint === false || !caps.entities[entity]?.readable.includes(key)) return []
  const scalar = (field: string) => {
    const type = definition.fields[field]?.type
    return !!type && !['json', 'ref'].includes(type) && caps.entities[entity]?.readable.includes(field)
  }
  if (!scalar(key) || (['enum', 'text'].includes(definition.fields[key].type) && !hint)) return []
  const fields = [...new Set(hint ? hint.fields : [key])]
  return fields.length > 0 && fields.length <= 4 && fields.every(scalar) ? fields : []
}
export function sortableFields(model: Model, entity: string, caps: Capabilities) {
  return [...new Set([...projection(model, entity, caps), ...labelColumns(model, entity, caps)])].filter(field => sortFields(model, entity, caps, field).length > 0)
}
export function stateFromSearch(search: ListSearch, model: Model, entity: string, caps: Capabilities) {
  const state = defaultListState(model, entity)
  const calendar = availableCalendar(model, entity, caps)
  if (calendar) {
    state.presentation = search.presentation === 'calendar' ? 'calendar' : 'table'
    state.calendarMode = search.calendarMode ?? 'month'
    state.calendarDate = search.calendarDate ?? dayKey(new Date())
  }
  const unavailableSearch = !!search.search && !listSearchableFields(model, entity, caps, state.presentation).length
  if (search.search && !unavailableSearch) state.search = search.search
  if (search.pageSize) state.limit = search.pageSize
  const sort = search.sort === 'none' ? null : search.sort ? { key: search.sort, direction: search.direction ?? 'asc' as const } : state.sort
  const unavailableSort = !!sort && !sortFields(model, entity, caps, sort.key).length
  const allowedFilters = new Set(filterableFields(model, entity, caps))
  let dropped = search.presentation === 'calendar' && !calendar || !!search.invalidSettings || (!!search.sort && unavailableSort) || unavailableSearch
  const filters: ListFilter[] = []
  for (const filter of search.filters ?? []) {
    const kind = allowedFilters.has(filter.field) ? filterKind(model, entity, filter.field, caps) : undefined
    const mapping = kind && filterMapping(kind, model.entities[entity].fields[filter.field])
    const value = mapping && mapping.fromPredicate(filter.predicate)
    const predicate = value !== undefined && mapping ? mapping.toPredicate(value) : undefined
    if (!predicate || filters.some(item => item.field === filter.field)) { dropped = true; continue }
    filters.push({ field: filter.field, predicate })
  }
  if (search.rowAccess && model.entities[entity].rowInvitations) state.rowAccess = search.rowAccess
  else if (search.rowAccess) dropped = true
  state.userFilters = filters
  const viewId = search.view ?? state.view
  const view = viewId === 'all' ? undefined : model.entities[entity].list?.views?.find(view => view.id === viewId)
  if (viewId && viewId !== 'all' && (!view || !readableWhere(view.where, model, entity, caps))) { dropped ||= !!search.view; state.view = 'all' }
  else if (viewId) state.view = viewId

  state.sort = unavailableSort ? null : sort
  return { state, dropped }
}
export function searchFromState(state: ListState): ListSearch {
  return { ...(state.rowAccess ? { rowAccess: state.rowAccess } : {}), ...(state.presentation === 'calendar' ? { presentation: state.presentation } : {}), ...(state.calendarDate ? { calendarDate: state.calendarDate } : {}), ...(state.calendarMode ? { calendarMode: state.calendarMode } : {}), ...(state.view ? { view: state.view } : {}), ...(state.userFilters.length ? { filters: state.userFilters } : {}), ...(state.search ? { search: state.search } : {}), ...(state.sort ? { sort: state.sort.key, direction: state.sort.direction } : { sort: 'none' }), pageSize: state.limit }
}
/** The only list compiler adapter. All work is performed by POST /query, never by the table. */
export function toQueryDocument(state: ListState, model: Model, entity: string, caps: Capabilities, locale: 'en' | 'cs' = 'en'): ReadQuery {
  const select = projection(model, entity, caps)
  // UI and URL validation cap selections first. Reject bypassing callers rather than widening a filter.
  for (const filter of state.userFilters) if (select.includes(filter.field) && Array.isArray(filter.predicate.in) && filter.predicate.in.length > selectionCap) throw new RangeError(`Select at most ${selectionCap} values per filter`)
  const labelWhere: Record<string, { contains: string; locale?: 'en' | 'cs' }> = {}
  for (const filter of state.userFilters) if (labelColumns(model, entity, caps).includes(filter.field) && typeof filter.predicate.contains === 'string') labelWhere[filter.field] = { contains: filter.predicate.contains, ...(locale === 'cs' ? { locale } : {}) }
  const conditions: Record<string, unknown>[] = [...state.presetFilters, ...state.userFilters].filter(filter => select.includes(filter.field) && !(filter.field in labelWhere && state.userFilters.includes(filter))).map(filter => {
    const spec = model.entities[entity].fields[filter.field]
    if (spec?.type === 'bool' && JSON.stringify(filter.predicate) === '{"in":[false,null]}') return { or: [{ [filter.field]: { eq: false } }, { [filter.field]: { isNull: true } }] }
    // Shared state stores local calendar days; only the request carries instants.
    const mapping = spec?.type === 'datetime' && Object.values(filter.predicate).some(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) ? filterMapping('date', spec) : undefined
    return { [filter.field]: mapping?.toPredicate(mapping.fromPredicate(filter.predicate), true) ?? filter.predicate }
  })
  const view = model.entities[entity].list?.views?.find(view => view.id === state.view)
  if (view && readableWhere(view.where, model, entity, caps)) conditions.unshift(view.where)
  const strings = listSearchableFields(model, entity, caps, state.presentation)
  const fields = state.sort ? sortFields(model, entity, caps, state.sort.key) : []
  const labels = labelColumns(model, entity, caps).filter(key => (model.entities[entity].list?.columns ?? model.entities[entity].listColumns ?? model.entities[entity].columns).includes(key))
  const query: ReadQuery = { entity, ...(state.rowAccess && model.entities[entity].rowInvitations ? { rowAccess: state.rowAccess } : {}), ...(state.search.trim() && strings.length ? { search: { text: state.search.trim(), fields: strings, locale } } : {}), select: select.length ? select : ['id'], ...(labels.length ? { labels } : {}), limit: Math.min(pageSizes.includes(state.limit as any) ? state.limit : 30, model.limits.root),
    ...(conditions.length ? { where: { and: conditions } } : {}),
    ...(Object.keys(labelWhere).length ? { labelWhere } : {}),
    orderBy: (fields.length ? fields : ['id']).map(field => ({ field, dir: fields.length ? state.sort!.direction : 'asc', ...(labelColumns(model, entity, caps).includes(field) ? { label: true } : {}) })),
    ...(state.cursor ? { cursor: state.cursor } : {}) }
  const calendar = state.presentation === 'calendar' && availableCalendar(model, entity, caps)
  if (calendar && calendar.titleFields) {
    const refs = calendar.titleFields.filter(field => select.includes(field) && model.entities[entity].fields[field]?.type === 'ref')
    if (refs.length) query.labels = [...new Set([...(query.labels ?? []), ...refs])]
  }
  return calendar ? calendarQuery(query, calendar, state.calendarDate ?? dayKey(new Date()), state.calendarMode ?? 'month', model) : query
}
/** Detail/picker hydration, chunked to the compiler's IN limit. Never used for list cells. */
export function relationHydrationQueries(model: Model, entity: string, caps: Capabilities, columns: string[], rows: Record<string, any>[], extraFields: Record<string, string[]> = {}) {
  return columns.flatMap(field => {
    const relation = Object.values(model.entities[entity].relations).find(value => value.cardinality === 'n:1' && value.field === field)
    if (!relation || !caps.entities[entity]?.readable.includes(field)) return []
    const target = caps.entities[relation.entity]
    if (!target?.operations.includes('read') || !target.readable.includes('id')) return []
    const display = target.displayField ?? model.entities[relation.entity].displayField
    const select = [...new Set(['id', ...(display && target.readable.includes(display) ? [display] : []), ...(extraFields[field] ?? []).filter(key => target.readable.includes(key))])]
    const ids = [...new Set(rows.map(row => row[field]).filter((id): id is string => typeof id === 'string'))]
    const chunks = []
    for (let start = 0; start < ids.length; start += 40) chunks.push({ field, target: relation.entity, display, query: { entity: relation.entity, select, where: { id: { in: ids.slice(start, start + 40) } }, limit: Math.min(40, model.limits.root) } satisfies ReadQuery })
    return chunks
  })
}

export function readableWhere(where: Record<string, unknown>, model: Model, entity: string, caps: Capabilities): boolean {
  return Object.entries(where).every(([key, value]) => key === 'and' || key === 'or'
    ? Array.isArray(value) && value.every(child => readableWhere(child, model, entity, caps))
    : key === 'not' ? readableWhere(value as Record<string, unknown>, model, entity, caps)
    : Object.hasOwn(model.entities[entity].fields, key) ? !!caps.entities[entity]?.readable.includes(key)
    : (() => {
      const relation = model.entities[entity].relations[key]
      if (!relation || !caps.entities[relation.entity]?.operations.includes('read')) return false
      const fk = relation.cardinality === '1:n' ? relation.entity : entity
      if (!caps.entities[fk]?.readable.includes(relation.field)) return false
      const child = relation.cardinality === '1:n' ? Object.values(value as Record<string, Record<string, unknown>>)[0] : value
      return readableWhere(child as Record<string, unknown>, model, relation.entity, caps)
    })())
}
