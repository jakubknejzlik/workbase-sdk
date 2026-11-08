/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx'
import { z } from 'zod'
import type { Field } from './config'
import { ApiError } from './errors'
import { assertUnprotectedFields } from './user-links'

export const Hidden = ({ name, value }: { name: string; value: unknown }) => <input type="hidden" name={name} value={String(value ?? '')} />
export function Form({ action, csrf, children, label = 'Save' }: { action: string; csrf: string; children?: Child; label?: string }) {
  return <form method="post" action={action}><Hidden name="_csrf" value={csrf} />{children}<button type="submit">{label}</button></form>
}
export function FieldInput({ name, field, value, choices = [], error }: { name: string; field: Field; value?: unknown; choices?: Record<string, any>[]; error?: Child }) {
  const current = value === undefined ? field.default ?? '' : value ?? ''
  const required = field.required && field.default === undefined
  const options = field.type === 'ref' ? choices.map(row => ({ value: row.id, label: row.name ?? row.title ?? row.id }))
    : field.type === 'bool' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : field.values?.map(value => ({ value, label: value }))
  return <label>{name}{required ? ' *' : ''}{options ? <select name={name} required={required}>
    <option value="">Choose…</option>{options.map(option => <option value={option.value} selected={String(current) === String(option.value)}>{option.label}</option>)}
    {current !== '' && !options.some(option => String(option.value) === String(current)) ? <option value={String(current)} selected>{String(current)}</option> : null}
  </select> : field.type === 'text' ? <textarea name={name} required={required} rows={4}>{String(current)}</textarea>
    : <input name={name} type={['int', 'float'].includes(field.type) ? 'number' : field.type === 'datetime' ? 'datetime-local' : 'text'}
      step={field.type === 'float' ? 'any' : field.type === 'datetime' ? '1' : undefined} min={field.min} required={required}
      value={field.type === 'datetime' && current ? String(current).replace(/Z$/, '') : String(current)} />}{field.type === 'ref' && choices.length === 90 ? <small>showing first 90 — use the API for more</small> : null}{error}</label>
}
export function entityBody(form: URLSearchParams, fields: Record<string, Field>) {
  assertUnprotectedFields({ fields }, [...form.keys()])
  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (field.readOnly || !form.has(key)) continue
    const value = form.get(key)!
    if (value === '') {
      if (field.required) continue // Existing validator supplies defaults / required errors.
      result[key] = null; continue
    }
    result[key] = field.type === 'bool' ? value === 'true' ? true : value === 'false' ? false : value
      : ['int', 'float'].includes(field.type) ? Number(value)
      : field.type === 'datetime' ? utcDate(value, key) : value
  }
  return result
}
function utcDate(value: string, field: string) {
  // The control is explicitly labelled UTC in the form; do not use the server timezone.
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
  if (!Number.isFinite(date.getTime())) throw new ApiError(400, 'invalid_date', field)
  return date.toISOString()
}
/** Zod is the command contract. No instance-specific field names live in the UI. */
export function commandFields(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as any
  return Object.entries(json.properties ?? {}).map(([name, definition]) => ({ name, definition: definition as any, required: (json.required ?? []).includes(name) }))
}
export function CommandInput({ name, definition: d, required, value, error }: ReturnType<typeof commandFields>[number] & { value?: string; error?: Child }) {
  const current = value ?? ''
  const type = d.type
  const complex = type === 'array' || type === 'object' || d.anyOf || !type
  return <label>{name}{required ? ' *' : ''}{d.enum ? <select name={name} required={required}><option value="">Choose…</option>{current && !d.enum.includes(current) ? <option value={current} selected>{current}</option> : null}{d.enum.map((option: string) => <option value={option} selected={option === current}>{option}</option>)}</select>
    : type === 'boolean' ? <select name={name} required={required}><option value="">Choose…</option>{current && !['true', 'false'].includes(current) ? <option value={current} selected>{current}</option> : null}<option value="true" selected={current === 'true'}>Yes</option><option value="false" selected={current === 'false'}>No</option></select>
    : complex ? <textarea name={name} required={required} placeholder={type === 'array' ? 'JSON array' : 'JSON value'} rows={3}>{current}</textarea>
    : <input name={name} value={current} required={required} type={type === 'number' || type === 'integer' ? 'number' : 'text'} step={type === 'number' ? 'any' : undefined} min={d.minimum} max={d.maximum} maxLength={d.maxLength} />}{error}</label>
}
export function commandBody(form: URLSearchParams, schema: z.ZodType) {
  const body: Record<string, unknown> = {}
  for (const { name, definition: d } of commandFields(schema)) {
    const value = form.get(name)
    if (value === null || value === '') continue
    const complex = d.type === 'array' || d.type === 'object' || d.anyOf || !d.type
    body[name] = complex ? JSON.parse(value) : ['integer', 'number'].includes(d.type) ? Number(value) : d.type === 'boolean' ? JSON.parse(value) : value
  }
  if (form.get('idempotencyKey')) body.idempotencyKey = form.get('idempotencyKey')
  return body
}
