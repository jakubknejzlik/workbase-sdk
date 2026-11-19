import type { Field, Model, Capabilities } from './read'
import { instanceTimeZone } from './labels'
export type FilterKind = 'text' | 'enum' | 'relation' | 'number' | 'date' | 'boolean'
export const selectionCap = 20
export interface RangeValue { from?: string; to?: string; value?: string }
export type FilterValue = string | string[] | boolean | RangeValue
export interface FilterMapping {
  toPredicate(value: unknown, instants?: boolean): Record<string, unknown> | undefined
  fromPredicate(predicate: Record<string, unknown>): FilterValue | undefined
  label(value: any, translate: (value: string) => string): string
}
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
/** Offset (ms) of an IANA zone at an instant, from the formatter rather than the host's own zone. */
function zoneOffset(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant)).map(part => [part.type, Number(part.value)]))
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000
}
/** First instant of a calendar day in the instance zone; `next` yields the following day's start. */
const localDay = (value: string, next = false, zone?: string) => {
  const timeZone = instanceTimeZone(zone)
  const [y, m, d] = value.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d + Number(next))
  // Two passes settle offsets that change between the guess and the real instant (DST).
  let instant = wall - zoneOffset(wall, timeZone)
  instant = wall - zoneOffset(instant, timeZone)
  return new Date(instant).toISOString()
}
const localDate = (instant: string, previous = false, zone?: string) => {
  const timeZone = instanceTimeZone(zone)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(instant)).map(part => [part.type, Number(part.value)]))
  const wall = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - Number(previous)))
  return wall.toISOString().slice(0, 10)
}
/** One reversible mapping per kind. Predicates stay root scalar predicates, including refs. */
function rawFilterMapping(kind: FilterKind, field?: Pick<Field, 'type' | 'required' | 'values'>, locale?: string, timeZone?: string): FilterMapping {
  if (kind === 'text') return {
    toPredicate: value => typeof value === 'string' && value.length > 0 && value.length <= 2000 ? { contains: value } : undefined,
    fromPredicate: p => Object.keys(p).join() === 'contains' && typeof p.contains === 'string' ? p.contains : undefined,
    label: value => value,
  }
  if (kind === 'enum' || kind === 'relation') return {
    toPredicate: value => Array.isArray(value) && value.length > 0 && value.length <= selectionCap && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 2000 && (kind !== 'enum' || !field?.values || field.values.includes(v))) ? { in: [...new Set(value)] } : undefined,
    fromPredicate: p => Object.keys(p).join() === 'in' && Array.isArray(p.in) && p.in.every(v => typeof v === 'string') ? p.in as string[] : undefined,
    label: (value: string[], translate) => value.map(translate).join(', '),
  }
  if (kind === 'boolean') return {
    toPredicate: value => typeof value === 'boolean' ? !value && field?.required === false ? { in: [false, null] } : { eq: value } : undefined,
    fromPredicate: p => Object.keys(p).join() === 'eq' && typeof p.eq === 'boolean' ? p.eq : JSON.stringify(p) === '{"in":[false,null]}' ? false : undefined,
    label: (value, translate) => translate(value ? 'yes' : 'no'),
  }
  const datetime = kind === 'date' && field?.type === 'datetime'
  const valid = (v: unknown) => kind === 'date' ? day(v) : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) && (field?.type !== 'int' || Number.isSafeInteger(Number(v)))
  return {
    toPredicate: (value, instants = false) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
      const v = value as RangeValue; const result: Record<string, unknown> = {}
      if (v.value) {
        if (!valid(v.value)) return undefined
        return datetime && instants ? { gte: localDay(v.value, false, timeZone), lt: localDay(v.value, true, timeZone) } : { eq: kind === 'number' ? Number(v.value) : v.value }
      }
      if (v.from) { if (!valid(v.from)) return undefined; result.gte = datetime && instants ? localDay(v.from, false, timeZone) : kind === 'number' ? Number(v.from) : v.from }
      if (v.to) { if (!valid(v.to)) return undefined; result[datetime && instants ? 'lt' : 'lte'] = datetime && instants ? localDay(v.to, true, timeZone) : kind === 'number' ? Number(v.to) : v.to }
      if (v.from && v.to && (kind === 'number' ? Number(v.from) > Number(v.to) : v.from > v.to)) return undefined
      return Object.keys(result).length ? result : undefined
    },
    fromPredicate: p => {
      if (!Object.keys(p).length || Object.keys(p).some(key => !['eq', 'gte', 'lte', ...(datetime ? ['lt'] : [])].includes(key))) return undefined
      if (p.eq !== undefined) return Object.keys(p).length === 1 ? { value: String(p.eq) } : undefined
      return { ...(p.gte !== undefined ? { from: datetime && !day(p.gte) ? localDate(String(p.gte), false, timeZone) : String(p.gte) } : {}), ...(p.lte !== undefined ? { to: String(p.lte) } : datetime && p.lt !== undefined ? { to: localDate(String(p.lt), true, timeZone) } : {}) }
    },
    label: (value: RangeValue, translate) => {
      const format = (v: string) => !locale ? v : kind === 'number' ? new Intl.NumberFormat(locale).format(Number(v)) : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${v}T12:00:00Z`))
      return value.value ? format(value.value) : value.from && value.from === value.to ? format(value.from) : `${value.from ? format(value.from) : translate('filterMinimum')} – ${value.to ? format(value.to) : translate('filterMaximum')}`
    },
  }
}
/** Validate the backend operators too: local day/nullable-bool state has compound emissions. */
export function filterMapping(kind: FilterKind, field?: Pick<Field, 'type' | 'required' | 'values'>, locale?: string, operators?: readonly string[], timeZone?: string): FilterMapping {
  const mapping = rawFilterMapping(kind, field, locale, timeZone)
  if (!operators) return mapping
  const permitted = (value: unknown) => {
    const predicate = mapping.toPredicate(value, true)
    if (!predicate) return false
    const keys = kind === 'boolean' && JSON.stringify(predicate) === '{"in":[false,null]}' ? ['eq', 'isNull'] : Object.keys(predicate)
    return keys.every(key => operators.includes(key))
  }
  return {
    ...mapping,
    toPredicate: (value, instants) => permitted(value) ? mapping.toPredicate(value, instants) : undefined,
    fromPredicate: predicate => {
      const value = mapping.fromPredicate(predicate)
      return value !== undefined && permitted(value) ? value : undefined
    },
  }
}
export function filterOperators(model: Model, entity: string, field: string): readonly string[] | undefined {
  const hint = model.entities[entity].list?.filter?.[field]
  return hint ? hint.operators : undefined
}
export function filterKind(model: Model, entity: string, field: string, caps?: Capabilities): FilterKind | undefined {
  const definition = model.entities[entity]
  const hint = definition?.list?.filter?.[field]
  if (hint === false) return undefined
  const spec = definition?.fields[field]
  const related = definition?.list?.relatedColumns?.[field]
  if (related) return !caps || caps.entities[entity]?.readable.includes(related.via) ? 'text' : undefined
  if (!spec || caps && !caps.entities[entity]?.readable.includes(field)) return undefined
  if (hint?.kind === 'relation' && spec.type === 'ref') return !caps || !!spec.entity && caps.entities[spec.entity]?.operations.includes('read') && caps.entities[spec.entity]?.readable.includes('id') ? 'relation' : undefined
  if (spec.type === 'ref') return 'text'
  return hint?.kind ?? ({ string: 'text', text: 'text', enum: 'enum', ref: 'relation', int: 'number', float: 'number', number: 'number', datetime: 'date', date: 'date', bool: 'boolean' } as Record<string, FilterKind>)[spec.type]
}

/** Runtime descriptors consume the canonical contract; they never carry option rows or target labels. */
export interface FilterDescriptor {
  field: string
  kind: FilterKind
  placement: 'toolbar' | 'panel'
  label?: string
  operators?: readonly string[]
}
export function filterDescriptors(model: Model, entity: string, caps: Capabilities): FilterDescriptor[] {
  const definition = model.entities[entity]
  const display = caps.entities[entity]?.displayField ?? definition.displayField
  // Declaration order owns explicit controls; preserve implicit header filters for compatibility.
  const fields = [...new Set([...Object.keys(definition.list?.filter ?? {}), display && caps.entities[entity]?.readable.includes(display) ? display : 'id', ...(definition.list?.columns?.map(column => column.field) ?? definition.listColumns ?? definition.columns)])]
  return fields.flatMap(field => {
    const kind = filterKind(model, entity, field, caps)
    const hint = definition.list?.filter?.[field]
    return kind ? [{ field, kind, placement: hint && hint.placement || 'panel', ...(hint && hint.label ? { label: hint.label } : {}), ...(hint && hint.operators ? { operators: hint.operators } : {}) }] : []
  })
}
/** Compatibility field list; every consumer derives from the same descriptors. */
export function filterableFields(model: Model, entity: string, caps: Capabilities): string[] {
  return filterDescriptors(model, entity, caps).map(filter => filter.field)
}
