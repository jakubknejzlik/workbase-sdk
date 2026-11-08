import { forwardRef } from 'react'
import { format } from 'date-fns'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '../components/ui/select'
import { DatePicker } from '../vendor/tiketo/components/form/DatePicker'
import { DateTimePicker } from '../vendor/tiketo/components/form/DateTimePicker'
import { NumberInput } from '../vendor/tiketo/components/form/NumberInput'
import { fieldSpec, fieldNullable, fieldUI, localDateValue, useRegistryLabels } from './schema'
import type { ControllerRenderProps } from 'react-hook-form'

/** Source PassTemplateThemeTab ColorField pattern, with a synchronized nullable hex value. */
const ColourInput = forwardRef<HTMLInputElement, React.ComponentProps<typeof Input> & { onValueChange: (value: string) => void; swatchLabel: string }>(function ColourInput({ onValueChange, swatchLabel, value, ...props }, ref) {
  return <div className="flex items-center gap-2"><input type="color" className="h-9 w-16 cursor-pointer rounded border border-border bg-transparent" aria-label={swatchLabel} disabled={props.disabled} value={typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : '#000000'} onChange={event => onValueChange(event.target.value)} /><Input {...props} ref={ref} value={value} onChange={event => onValueChange(event.target.value)} /></div>
})
// Select reserves an empty string; this sentinel is never sent to the resolver/API.
const emptyValue = (values: string[] = []) => { let value = '__workbase_empty__'; while (values.includes(value)) value += '_'; return value }
export const RegistryField = forwardRef<HTMLElement, { raw: any; field: ControllerRenderProps; label: string; optionLabel: (value: string) => string; disabled?: boolean; required?: boolean } & Record<string, any>>(function RegistryField({ raw, field, label, optionLabel, disabled, required, ...control }, ref) {
  const spec = fieldSpec(raw); const ui = fieldUI(raw); const labels = useRegistryLabels()
  const kind = ui.kind ?? (spec.enum ? 'select' : spec.type === 'boolean' ? 'boolean' : ['integer', 'number'].includes(spec.type) ? 'number' : spec.format === 'date-time' ? 'datetime' : spec.format === 'date' ? 'date' : ['array', 'object'].includes(spec.type) || spec.maxLength > 2000 ? 'textarea' : 'input')
  const input = { ...field, ...control, disabled, ref: (node: any) => { field.ref(node); if (typeof ref === 'function') ref(node); else if (ref) ref.current = node } }
  const emptyOption = emptyValue(spec.enum)
  if (kind === 'select') return <Select value={field.value || emptyOption} onValueChange={value => field.onChange(value === emptyOption ? '' : value)} disabled={disabled}><SelectTrigger {...input} type="button" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={emptyOption}>—</SelectItem>{spec.enum?.map((value: string) => <SelectItem key={value} value={value}>{optionLabel(value)}</SelectItem>)}</SelectContent></Select>
  if (kind === 'boolean' && (!required || fieldNullable(raw))) return <Select value={typeof field.value === 'boolean' ? String(field.value) : emptyOption} onValueChange={value => field.onChange(value === emptyOption ? '' : value === 'true')} disabled={disabled}><SelectTrigger {...input} type="button" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={emptyOption}>{labels.unfilled ?? 'Unfilled'}</SelectItem><SelectItem value="true">{labels.yes ?? 'Yes'}</SelectItem><SelectItem value="false">{labels.no ?? 'No'}</SelectItem></SelectContent></Select>
  if (kind === 'boolean') return <Input {...input} type="checkbox" className="size-4 w-4" checked={!!field.value} onChange={event => field.onChange(event.target.checked)} />
  if (kind === 'textarea') return <Textarea {...input} rows={4} />
  if (kind === 'number') return <NumberInput {...input} value={field.value === '' ? undefined : Number(field.value)} onValueChange={value => field.onChange(value == null ? '' : String(value))} min={spec.minimum} max={spec.maximum} step={spec.type === 'integer' ? 1 : 'any'} decreaseLabel={labels.decrease} increaseLabel={labels.increase} />
  if (kind === 'date' || kind === 'datetime') {
    const date = field.value ? new Date(kind === 'date' ? `${field.value}T00:00:00` : field.value) : undefined
    const props = { ...input, value: date && !Number.isNaN(date.getTime()) ? date : undefined, onChange: (value?: Date) => field.onChange(value ? kind === 'date' ? localDateValue(value) : value.toISOString() : ''), locale: labels.locale, dateFormat: 'd. M. yyyy', 'aria-label': label }
    props['aria-label'] = `${label}: ${props.value ? format(props.value, kind === 'date' ? 'd. M. yyyy' : 'd. M. yyyy HH:mm', { locale: labels.locale }) : kind === 'date' ? labels.date : labels.datetime}`
    return kind === 'date' ? <DatePicker {...props} placeholder={labels.date} /> : <DateTimePicker {...props} placeholder={labels.datetime} timeLabel={labels.time} />
  }
  if (kind === 'colour') return <ColourInput {...input} onValueChange={field.onChange} swatchLabel={labels.swatch(label)} />
  return <Input {...input} type={kind === 'time' ? 'time' : spec.format === 'email' ? 'email' : spec.format === 'tel' ? 'tel' : 'text'} />
})
