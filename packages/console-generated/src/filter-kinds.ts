import type { Field, Model, Capabilities } from './read'
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
const localDay = (value: string, next = false) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d + Number(next)).toISOString() }
const localDate = (instant: string, previous = false) => { const d = new Date(instant); if (previous) d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
/** One reversible mapping per kind. Predicates stay root scalar predicates, including refs. */
export function filterMapping(kind: FilterKind, field?: Pick<Field, 'type' | 'required' | 'values'>, locale?: string): FilterMapping {
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
        return datetime && instants ? { gte: localDay(v.value), lt: localDay(v.value, true) } : { eq: kind === 'number' ? Number(v.value) : v.value }
      }
      if (v.from) { if (!valid(v.from)) return undefined; result.gte = datetime && instants ? localDay(v.from) : kind === 'number' ? Number(v.from) : v.from }
      if (v.to) { if (!valid(v.to)) return undefined; result[datetime && instants ? 'lt' : 'lte'] = datetime && instants ? localDay(v.to, true) : kind === 'number' ? Number(v.to) : v.to }
      if (v.from && v.to && (kind === 'number' ? Number(v.from) > Number(v.to) : v.from > v.to)) return undefined
      return Object.keys(result).length ? result : undefined
    },
    fromPredicate: p => {
      if (!Object.keys(p).length || Object.keys(p).some(key => !['eq', 'gte', 'lte', ...(datetime ? ['lt'] : [])].includes(key))) return undefined
      if (p.eq !== undefined) return Object.keys(p).length === 1 ? { value: String(p.eq) } : undefined
      return { ...(p.gte !== undefined ? { from: datetime && !day(p.gte) ? localDate(String(p.gte)) : String(p.gte) } : {}), ...(p.lte !== undefined ? { to: String(p.lte) } : datetime && p.lt !== undefined ? { to: localDate(String(p.lt), true) } : {}) }
    },
    label: (value: RangeValue, translate) => {
      const format = (v: string) => !locale ? v : kind === 'number' ? new Intl.NumberFormat(locale).format(Number(v)) : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(`${v}T12:00:00`))
      return value.value ? format(value.value) : value.from && value.from === value.to ? format(value.from) : `${value.from ? format(value.from) : translate('filterMinimum')} – ${value.to ? format(value.to) : translate('filterMaximum')}`
    },
  }
}
export function filterKind(model: Model, entity: string, field: string, caps?: Capabilities): FilterKind | undefined {
  const spec = model.entities[entity]?.fields[field]
  const related = model.entities[entity]?.list?.relatedColumns?.[field]
  if (related) return !caps || caps.entities[entity]?.readable.includes(related.via) ? 'text' : undefined
  if (!spec || caps && !caps.entities[entity]?.readable.includes(field)) return undefined
  const hint = model.entities[entity].list?.filter?.[field]
  if (hint === false) return undefined
  if (spec.type === 'ref') return 'text'
  return hint ?? ({ string: 'text', text: 'text', enum: 'enum', ref: 'relation', int: 'number', float: 'number', number: 'number', datetime: 'date', date: 'date', bool: 'boolean' } as Record<string, FilterKind>)[spec.type]
}

/** Filterable means a header rendered by this list; hidden schema fields are not extra filters. */
export function filterableFields(model: Model, entity: string, caps: Capabilities): string[] {
  const definition = model.entities[entity]
  const display = caps.entities[entity]?.displayField ?? definition.displayField
  return [...new Set([display && caps.entities[entity]?.readable.includes(display) ? display : 'id', ...(definition.list?.columns ?? definition.listColumns ?? definition.columns)])].filter(field => !!filterKind(model, entity, field, caps))
}
