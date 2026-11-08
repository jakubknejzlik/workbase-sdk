import type { Capabilities, Field, Model } from './read'
type Translate = (key: string, options?: any) => string
export function shortRecordId(id: unknown) {
  const value = String(id ?? '')
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-3)}` : value
}
export function formatValue(value: unknown, field: Field, locale: string, yes: string, no: string, empty: string) {
  if (value === null || value === undefined) return empty
  if (['int', 'float', 'number'].includes(field.type)) return new Intl.NumberFormat(locale, { useGrouping: field.ui?.format === 'identifier' ? false : undefined }).format(Number(value))
  if (['date', 'datetime'].includes(field.type)) { const date = new Date(String(value)); if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat(locale === 'cs' ? 'cs-CZ' : locale, { dateStyle: 'medium', ...(field.type === 'date' ? { timeZone: 'UTC' } : {}), ...(field.type === 'datetime' ? { timeStyle: 'short' as const } : {}) }).format(date) }
  if (field.type === 'bool') return value ? yes : no
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
export function formatFieldValue(value: unknown, field: Field, locale: string, t: Translate) {
  return field.type === 'enum' && value != null ? t(`value_${value}`, { defaultValue: String(value) }) : formatValue(value, field, locale, t('yes'), t('no'), t('nullValue'))
}
/** Read masks apply even if a cached response contains a previously readable label. */
export function recordLabel(model: Model, entity: string, row: Record<string, any>, caps: Capabilities, locale: string, t: Translate) {
  const definition = model.entities[entity], grant = caps.entities[entity]
  const field = grant?.displayField ?? definition.displayField
  const fallback = grant?.operations.includes('read') && grant.readable.includes('id') ? shortRecordId(row.id) : t('unavailableRecord')
  if (!grant?.operations.includes('read') || !field || ['id', 'organization_id'].includes(field) || !grant.readable.includes(field) || !definition.fields[field] || row[field] == null || String(row[field]).trim() === '') return fallback
  if (Array.isArray(row.__display)) return row.__display.map((part: unknown) => part && typeof part === 'object' && 'type' in part && (part.type === 'datetime' || part.type === 'date') && 'value' in part
    ? part.value == null ? '' : formatFieldValue(part.value, { type: part.type }, locale, t)
    : String(part ?? '')).join('')
  return formatFieldValue(row[field], definition.fields[field], locale, (key, options) => t(key, { context: entity, ...options }))
}
