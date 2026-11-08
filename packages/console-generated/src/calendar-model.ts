import type { ConsoleCalendarView } from '../../plugins/console/src/contract'
import type { Capabilities, Model, ReadQuery } from './read'
import { recordLabel, formatFieldValue } from './labels'
import { detailReadableField } from './detail-plan'
export type CalendarMode = 'month' | 'week'
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function localDay(value: string): Date { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day) }
export function validDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 1000 && dayKey(localDay(value)) === value
}
export function addDays(value: Date, count: number): Date { const date = new Date(value); date.setDate(date.getDate() + count); return date }
/** Local Monday boundaries, converted to instants only at the query boundary (DST safe). */
export function calendarRange(value: string, mode: CalendarMode) {
  const anchor = localDay(value)
  const start = mode === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth(), 1) : anchor
  start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  const end = mode === 'week' ? addDays(start, 7) : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)
  if (mode === 'month' && end.getDay() !== 1) end.setDate(end.getDate() + (8 - end.getDay()) % 7)
  return { start, end }
}
export function availableCalendar(model: Model, entity: string, caps: Capabilities): ConsoleCalendarView | undefined {
  const grant = caps.entities[entity]
  if (!grant?.operations.includes('read') || !grant.readable.includes('id')) return
  return model.entities[entity].views?.find(view => grant.readable.includes(view.startField) && (!view.endField || grant.readable.includes(view.endField)))
}
/** One ordinary ts-query, retaining search, presets, filters and server policy enforcement. */
export function calendarQuery(query: ReadQuery, view: ConsoleCalendarView, date: string, mode: CalendarMode, model: Model): ReadQuery {
  const { start, end } = calendarRange(date, mode)
  const startsInRange = { [view.startField]: { gte: start.toISOString(), lt: end.toISOString() } }
  const range = view.endField ? { and: [
    { [view.startField]: { lt: end.toISOString() } },
    { or: [{ [view.endField]: { gt: start.toISOString() } }, { and: [{ [view.endField]: { isNull: true } }, startsInRange] }] },
  ] } : startsInRange
  return { ...query, limit: model.limits.root, where: { and: [...query.where ? [query.where] : [], range] }, orderBy: [{ field: view.startField, dir: 'asc' }, { field: 'id', dir: 'asc' }] }
}
export function calendarCreateField(model: Model, entity: string, caps: Capabilities, view: ConsoleCalendarView): boolean {
  const definition = model.entities[entity]; const field = view.startField
  return !!caps.entities[entity]?.operations.includes('create') && caps.entities[entity].writable.includes(field) && !definition.fields[field]?.readOnly && !definition.fields[field]?.ui?.hidden && !!definition.writeSchema?.properties?.[field] && (!definition.form?.create || definition.form.create.fields.includes(field))
}
export function eventOnDay(row: Record<string, any>, view: ConsoleCalendarView, date: Date): boolean {
  const start = Date.parse(row[view.startField]); const end = view.endField ? Date.parse(row[view.endField]) : NaN
  return Number.isFinite(start) && start < addDays(date, 1).getTime() && (Number.isFinite(end) && end > start ? end > date.getTime() : start >= date.getTime())
}

/** Ref operands are SR-61 labels already computed by the range SELECT (SR-50).
 * Compose presentation fields only; never hydrate labels or read cached masked values. */
export function calendarTitle(model: Model, entity: string, caps: Capabilities, view: ConsoleCalendarView, row: Record<string, any>, locale: string, t: (key: string, options?: any) => string): string {
  const display = caps.entities[entity]?.displayField ?? model.entities[entity].displayField
  const fallback = () => recordLabel(model, entity, display && detailReadableField(model, entity, caps, display) ? row : { id: row.id }, caps, locale, t)
  const fields = view.titleFields ?? (view.titleField ? [view.titleField] : [])
  if (!fields.length || fields.some(field => !detailReadableField(model, entity, caps, field))) return fallback()
  const parts = fields.map(field => {
    const spec = model.entities[entity].fields[field]
    if (spec.type !== 'ref') return row[field] == null || !String(row[field]).trim() ? undefined : formatFieldValue(row[field], spec, locale, t)
    const label = row.__labels?.[field]
    const target = spec.entity!
    const display = caps.entities[target]?.displayField ?? model.entities[target].displayField
    if (label?.status !== 'ok' || label.entity !== target || !display || !detailReadableField(model, target, caps, display) || label.row?.[display] == null || !String(label.row[display]).trim()) return undefined
    return recordLabel(model, target, label.row, caps, locale, t)
  })
  return parts.every(part => part !== undefined) ? parts.join(' · ') : fallback()
}
