import { createContext, useContext } from 'react'
import type { Locale } from 'date-fns'
export { cs, enUS } from 'date-fns/locale'
export interface FieldUI { kind?: 'input' | 'textarea' | 'select' | 'boolean' | 'number' | 'date' | 'datetime' | 'time' | 'colour'; span?: 'half' | 'full'; section?: string; hidden?: boolean }
export interface RegistrySchema { type?: string | string[]; properties?: Record<string, any>; required?: string[]; 'x-ui'?: { fieldOrder?: string[] }; [key: string]: any }
export const fieldSpec = (raw: any): any => {
  const spec = raw.anyOf?.find((item: any) => item.type !== 'null') ?? raw
  return Array.isArray(spec.type) ? { ...spec, type: spec.type.find((type: string) => type !== 'null') } : spec
}
export const fieldNullable = (raw: any): boolean => raw.type === 'null' || (Array.isArray(raw.type) && raw.type.includes('null')) || !!raw.anyOf?.some(fieldNullable)
export const fieldUI = (raw: any): FieldUI => raw['x-ui'] ?? {}
/** readOnly/hidden is presentation metadata, independent of the server's authorization. */
export function editableSchema(schema: RegistrySchema): RegistrySchema {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, raw]) => !raw.readOnly && !fieldUI(raw).hidden))
  return { ...schema, properties, required: schema.required?.filter(name => Object.hasOwn(properties, name)) }
}
export function schemaDialogWidth(schema: RegistrySchema) {
  return Object.values(editableSchema(schema).properties ?? {}).some(raw => fieldUI(raw).span === 'half') ? 'sm:max-w-[600px]' : 'sm:max-w-[500px]'
}
export interface RegistryLabels { date: string; datetime: string; time: string; decrease: string; increase: string; swatch: (label: string) => string; locale?: Locale; yes?: string; no?: string; unfilled?: string }
const Labels = createContext<RegistryLabels>({ date: 'Pick a date', datetime: 'Pick a date and time', time: 'Time', decrease: 'Decrease', increase: 'Increase', swatch: label => `${label} swatch` })
export const RegistryLabelsProvider = Labels.Provider
export const useRegistryLabels = () => useContext(Labels)
/** Local calendar days must never pass through UTC midnight. */
export function localDateValue(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
