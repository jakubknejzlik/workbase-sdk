import { useEffect, useId } from 'react'
import { useController, type UseFormReturn } from 'react-hook-form'
import { Label } from '../components/ui/label'
import { RegistryField } from './registry-field'
import { fieldSpec, fieldNullable } from './schema'

/** Availability is separate from value: false, zero, null and empty sets are seeds. */
export type FieldSeed = { state: 'known'; value: unknown } | { state: 'unknown' | 'pending' | 'blocked' }
export interface FieldInstallation { state: 'known' | 'unknown' | 'unknown-draft' | 'raced'; baseline: unknown }
export function fieldValue(raw: any, value: any, required = false): any {
  const spec = fieldSpec(raw)
  if (raw['x-ui']?.valueSet && value != null) {
    try { return JSON.stringify([...new Set(typeof value === 'string' ? JSON.parse(value) : value)].sort()) } catch { return value }
  }
  if ((spec.type === 'array' || spec.type === 'object') && value != null) return typeof value === 'string' ? value : JSON.stringify(value)
  if (spec.format === 'date-time' && value) { const date = new Date(value); if (!Number.isNaN(date.getTime())) return date.toISOString() }
  if ((spec.type === 'integer' || spec.type === 'number') && value != null) return String(value)
  return value ?? (spec.type === 'boolean' && required && !fieldNullable(raw) ? false : '')
}
export function fieldReady(seed: FieldSeed, installed?: FieldInstallation) {
  return seed.state !== 'blocked' && seed.state !== 'pending' && !!installed && installed.state !== 'raced' && (seed.state !== 'known' || installed.state !== 'unknown')
}

/** Both renderers register here. Only this registered owner can install/acknowledge a default. */
export function RegisteredField({ name, raw, required, form, seed, installations, acknowledge, label, optionLabel, disabled, locked, relation, clearServerError }: {
  name: string; raw: any; required: boolean; form: UseFormReturn<Record<string, any>>; seed: FieldSeed
  installations: Map<string, FieldInstallation>; acknowledge: () => void; label: string; optionLabel: (value: string) => string
  disabled?: boolean; locked: boolean; clearServerError: () => void
  relation?: (name: string, value: string, change: (value: string) => void, error?: string) => React.ReactNode
}) {
  const { field, fieldState } = useController({ name, control: form.control, defaultValue: fieldValue(raw, undefined, required), shouldUnregister: false })
  const id = useId()
  const installed = installations.get(name)
  const value = seed.state === 'known' ? fieldValue(raw, seed.value, required) : fieldValue(raw, undefined, required)
  useEffect(() => {
    const previous = installations.get(name)
    if (previous?.state === 'known' || previous?.state === 'unknown-draft' || previous?.state === 'raced') return
    if (previous?.state === 'unknown' && seed.state !== 'known') return
    const baseline = previous?.baseline ?? form.formState.defaultValues?.[name] ?? fieldValue(raw, undefined, required)
    const state = form.getFieldState(name)
    const edited = state.isDirty || state.isTouched || !Object.is(form.getValues(name), baseline)
    if (previous?.state === 'unknown' && edited) {
      // An explicit unknown-value edit owns its local baseline, even after a read grant.
      installations.set(name, { state: 'unknown-draft', baseline }); acknowledge(); return
    }
    if (edited) {
      installations.set(name, { state: 'raced', baseline }); acknowledge(); return
    }
    if (seed.state === 'pending' || seed.state === 'blocked') return
    form.resetField(name, { defaultValue: value, keepTouched: true, keepError: true })
    if (Object.is(form.getValues(name), value) && Object.is(form.formState.defaultValues?.[name], value)) {
      installations.set(name, { state: seed.state, baseline: value }); acknowledge()
    }
  })
  const ready = fieldReady(seed, installed)
  const error = fieldState.error?.message
  const change = (value: any) => { if (!ready || disabled || locked) return; clearServerError(); field.onChange(fieldValue(raw, value?.target ? value.target.value : value, required)) }
  const custom = relation?.(name, field.value ?? '', change, error)
  // Pickers keep their accessible layout; the adapter still owns blur and focus/error refs.
  return <fieldset ref={node => { if (custom != null) field.ref(node?.querySelector('input,select,textarea,button[role="combobox"]') ?? null) }} onBlur={custom != null ? field.onBlur : undefined} disabled={disabled || locked || !ready} data-write-field={name} data-field-ready={ready} className={raw['x-ui']?.span === 'half' ? 'min-w-0' : 'min-w-0 sm:col-span-2'}>
    {custom ?? <div data-slot="form-item" className="grid gap-2">
      <Label htmlFor={id} data-error={!!error}>{label}</Label>
      <RegistryField raw={raw} required={required} field={{ ...field, value: field.value ?? '', onChange: change }} id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} label={label} optionLabel={optionLabel} disabled={disabled || locked || !ready} />
      {error && <p id={`${id}-error`} role="alert" data-slot="form-message" className="text-destructive text-sm">{error}</p>}
    </div>}
  </fieldset>
}
