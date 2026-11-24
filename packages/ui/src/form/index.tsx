import { MutationSubmitButton, useMutationForm, useMutationSubmit, useMutationSession } from '../dialog/mutation-lifecycle'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { FormProvider, type UseFormReturn } from 'react-hook-form'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Form } from '../components/form/Form'
import { RegisteredField, fieldValue, fieldReady, type FieldSeed, type FieldInstallation } from './field-lifecycle'
import { formValidator } from './validation'
import { editableSchema, fieldSpec, fieldNullable, fieldUI, type RegistrySchema } from './schema'
// Prevent the optional Zod JIT probe from violating script-src self.
z.config({ jitless: true })
const schema = z.object({ name: z.string().trim().min(1, 'Enter a name') })
export function NameForm({ label, submitLabel, onSubmit }: { label: string; submitLabel: string; onSubmit: (data: z.infer<typeof schema>) => void | Promise<unknown> }) {
  const id = useId()
  const form = useMutationForm({ resolver: zodResolver(schema), defaultValues: { name: '' } }); const submit = useMutationSubmit()
  const { register, handleSubmit, formState: { errors, isDirty, isSubmitting } } = form
  return <form noValidate onSubmit={handleSubmit(data => submit(() => Promise.resolve(onSubmit(data))))}><Label htmlFor={id}>{label}</Label>
    <Input id={id} {...register('name')} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-error` : undefined} />
    {errors.name && <p id={`${id}-error`} role="alert">{errors.name.message}</p>}<MutationSubmitButton type="submit" pending={isSubmitting} disabled={!isDirty}>{submitLabel}</MutationSubmitButton>
  </form>
}

/** JSON-schema resolution and normalization stay in the host; rendering uses source fields. */
export function RegistryForm({ schema: inputSchema, values = {}, lockedValues = {}, label, submitLabel, invalidLabel, pending, disabled, onSubmit, relation, serverInvalid = false, serverErrors = {}, inline = false, requireDirty = false, partial = false, seeds, onReadyChange, secondaryAction, optionLabel = value => value }: {
  schema: RegistrySchema; values?: Record<string, any>; lockedValues?: Record<string, any>; label: (name: string) => string; submitLabel: string; invalidLabel: string; pending?: boolean; disabled?: boolean; serverInvalid?: boolean; serverErrors?: Record<string, string>; inline?: boolean; requireDirty?: boolean; partial?: boolean; optionLabel?: (value: string) => string
  onSubmit: (values: Record<string, any>) => void | Promise<unknown>
  seeds?: Record<string, FieldSeed>; onReadyChange?: (ready: boolean) => void
  secondaryAction?: React.ReactNode
  relation?: (name: string, value: string, change: (value: string) => void, error?: string) => React.ReactNode
}) {
  const schema = editableSchema(inputSchema)
  const properties = schema.properties ?? {}
  const order: string[] = schema['x-ui']?.fieldOrder ?? []
  const fields = [...new Set([...order, ...Object.keys(properties)])].filter(name => Object.hasOwn(properties, name)).map(name => [name, properties[name]] as [string, any])
  const convert = (raw: any, value: any) => {
    const spec = fieldSpec(raw)
    if (value === '') return fieldNullable(raw) ? null : undefined
    if (value == null) return value
    if (spec.type === 'integer' || spec.type === 'number') return Number(value)
    if (spec.format === 'date-time') { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toISOString() }
    if ((spec.type === 'array' || spec.type === 'object') && typeof value === 'string') { try { return JSON.parse(value) } catch { return value } }
    return value
  }
  const defaults = Object.fromEntries(fields.map(([name, raw]) => {
    const spec = fieldSpec(raw); let value = Object.hasOwn(lockedValues, name) ? lockedValues[name] : Object.hasOwn(values, name) ? values[name] : partial ? undefined : raw.default ?? spec.default
    return [name, fieldValue(raw, value, schema.required?.includes(name))]
  }))
  const installations = useRef(new Map<string, FieldInstallation>()).current
  const [, renderInstallation] = useState(0)
  const acknowledge = useCallback(() => renderInstallation(value => value + 1), [])
  const fieldSeed = (name: string): FieldSeed => seeds ? seeds[name] ?? { state: 'blocked' } : Object.hasOwn(values, name) || Object.hasOwn(lockedValues, name) || !partial ? { state: 'known', value: defaults[name] } : { state: 'unknown' }
  const ready = () => fields.every(([name]) => fieldReady(fieldSeed(name), installations.get(name)))
  const blocked = useRef<() => boolean>(() => false)
  blocked.current = () => !!disabled || !!pending || !ready()
  const installed = ready()
  useEffect(() => { onReadyChange?.(!disabled && installed) }, [installed, disabled, onReadyChange])

  const resolve = zodResolver(formValidator(schema) as any) as any
  const submit = useMutationSubmit(); const session = useMutationSession()
  const form: UseFormReturn<Record<string, any>> = useMutationForm<Record<string, any>>({ resolver: async (data, context, options) => {
    // An edit only validates and writes changed fields. Missing read values are unknown,
    // not an instruction to clear them, and create defaults must not fill them in.
    if (blocked.current()) return { values: {}, errors: { root: { type: 'readiness', message: invalidLabel } } }
    const submitted = partial ? fields.filter(([name]) => form.getFieldState(name).isDirty) : fields
    const validate = partial ? zodResolver(formValidator({ ...schema, properties: Object.fromEntries(submitted), required: schema.required?.filter(name => submitted.some(([field]) => field === name)) }) as any) as any : resolve
    const result = await validate(Object.fromEntries(submitted.map(([name, raw]) => [name, convert(raw, Object.hasOwn(lockedValues, name) ? lockedValues[name] : data[name])])), context, options)
    // Resolver messages are intentionally closed/localized, never raw Zod/server text.
    for (const error of Object.values(result.errors) as any[]) error.message = invalidLabel
    return result
  }, defaultValues: defaults })
  const serverKey = JSON.stringify(serverErrors)
  useEffect(() => {
    for (const name of Object.keys(form.formState.errors)) if (form.getFieldState(name).error?.type === 'server') form.clearErrors(name)
    for (const [name, message] of Object.entries(serverErrors)) if (Object.hasOwn(schema.properties ?? {}, name)) form.setError(name, { type: 'server', message })
  }, [serverKey])
  const clearServerError = (name: string) => { if (form.getFieldState(name).error?.type === 'server') form.clearErrors(name) }
  const busy = pending || session?.pending || form.formState.isSubmitting
  const submitValues = (data: Record<string, any>) => { if (!blocked.current()) return submit(() => Promise.resolve(onSubmit(data))) }
  const submitButton = <MutationSubmitButton data-inline-submit={inline ? '' : undefined} footer={!inline} type={inline ? 'button' : 'submit'} pending={busy} disabled={disabled || !installed || (requireDirty && !form.formState.isDirty)} onClick={inline ? form.handleSubmit(submitValues) : undefined}>{submitLabel}</MutationSubmitButton>
  // Preserve the existing adjacent-section presentation; the ledger survives mask remounts.
  const groups: { section: string; entries: typeof fields }[] = []
  for (const entry of fields) {
    const section = fieldUI(entry[1]).section ?? ''
    if (groups.at(-1)?.section !== section) groups.push({ section, entries: [] })
    groups.at(-1)!.entries.push(entry)
  }
  const contents = <>{serverInvalid && <p role="alert">{invalidLabel}</p>}{groups.map(({ section, entries }, index) => <fieldset key={`${section}-${index}`} className="min-w-0 space-y-4" disabled={disabled || busy}>
    {section && <legend className="text-sm font-medium">{label(section)}</legend>}
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{entries.map(([name, raw]) => <RegisteredField key={name} name={name} raw={raw} required={!!schema.required?.includes(name)} form={form} seed={fieldSeed(name)} installations={installations} acknowledge={acknowledge} label={label(name)} optionLabel={optionLabel} disabled={disabled || busy} locked={Object.hasOwn(lockedValues, name)} relation={relation} clearServerError={() => clearServerError(name)} />)}</div>
  </fieldset>)}{secondaryAction ? <div className="flex items-center gap-2">{submitButton}{secondaryAction}</div> : submitButton}</>
  return inline ? <FormProvider {...form}><div className="space-y-4" onKeyDown={event => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || event.nativeEvent.isComposing) return
    event.preventDefault(); event.stopPropagation()
    if (!busy && !disabled && !event.repeat) void form.handleSubmit(submitValues)()
  }}>{contents}</div></FormProvider> : <div onSubmitCapture={event => { if (blocked.current()) { event.preventDefault(); event.stopPropagation() } }}><Form form={form} className="space-y-4" pending={busy} onSubmit={submitValues}>{contents}</Form></div>
}

export { Form, useFormSubmissionState } from '../components/form/Form'
export { FormFieldWrapper } from '../components/form/FormFieldWrapper'
export { FormFieldInput } from '../components/form/FormFieldInput'
export { FormSubmitButton } from '../components/form/FormSubmitButton'
export { RegistryLabelsProvider, cs, enUS, type RegistrySchema } from './schema'

export { formValidator } from './validation'
