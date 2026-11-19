import type { Capabilities, Field, Model } from './read'
type Translate = (key: string, options?: any) => string
export function shortRecordId(id: unknown) {
  const value = String(id ?? '')
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-3)}` : value
}
/** Instance zone for instants. Never the browser's: an absent zone is UTC, not the host. */
export function instanceTimeZone(timeZone?: string) {
  if (!timeZone) return 'UTC'
  try { new Intl.DateTimeFormat('en', { timeZone }); return timeZone } catch { return 'UTC' }
}
export type CellKind = 'text' | 'identifier' | 'badge' | 'date' | 'datetime' | 'number'
export function formatValue(value: unknown, field: Field, locale: string, yes: string, no: string, empty: string, timeZone?: string, cell?: CellKind) {
  if (value === null || value === undefined) return empty
  if (['int', 'float', 'number'].includes(field.type) || cell === 'number' && (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value))) return new Intl.NumberFormat(locale, { useGrouping: field.ui?.format === 'identifier' ? false : undefined }).format(Number(value))
  if (['date', 'datetime'].includes(field.type)) {
    const date = new Date(String(value))
    if (!Number.isNaN(date.getTime())) {
      // A date-only value is a calendar day (UTC midnight), never an instant to shift into a zone.
      const instant = field.type === 'datetime'
      return new Intl.DateTimeFormat(locale === 'cs' ? 'cs-CZ' : locale, { dateStyle: 'medium', timeZone: instant ? instanceTimeZone(timeZone) : 'UTC', ...(instant && cell !== 'date' ? { timeStyle: 'short' as const } : {}) }).format(date)
    }
  }
  if (field.type === 'bool') return value ? yes : no
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
export function formatFieldValue(value: unknown, field: Field, locale: string, t: Translate, timeZone?: string, cell?: CellKind) {
  return field.type === 'enum' && value != null ? t(`value_${value}`, { defaultValue: String(value) }) : formatValue(value, field, locale, t('yes'), t('no'), t('nullValue'), timeZone, cell)
}
/** Read masks apply even if a cached response contains a previously readable label. */
export function recordLabel(model: Model, entity: string, row: Record<string, any>, caps: Capabilities, locale: string, t: Translate) {
  const definition = model.entities[entity], grant = caps.entities[entity]
  const field = grant?.displayField ?? definition.displayField
  const fallback = grant?.operations.includes('read') && grant.readable.includes('id') ? shortRecordId(row.id) : t('unavailableRecord')
  if (!grant?.operations.includes('read') || !field || ['id', 'organization_id'].includes(field) || !grant.readable.includes(field) || !definition.fields[field] || row[field] == null || String(row[field]).trim() === '') return fallback
  if (Array.isArray(row.__display)) return row.__display.map((part: unknown) => part && typeof part === 'object' && 'type' in part && (part.type === 'datetime' || part.type === 'date') && 'value' in part
    ? part.value == null ? '' : formatFieldValue(part.value, { type: part.type }, locale, t, model.timeZone)
    : String(part ?? '')).join('')
  return formatFieldValue(row[field], definition.fields[field], locale, (key, options) => t(key, { context: entity, ...options }), model.timeZone)
}
