import { RangeFilter as NumericRange, type RangeInput } from '../vendor/tiketo/components/data-table/filters/RangeFilter'
import { DateRangePicker } from '../vendor/tiketo/components/form/DateRangePicker'
import { Input } from '../components/ui/input'
import { cs, enUS } from 'react-day-picker/locale'
export type { RangeInput } from '../vendor/tiketo/components/data-table/filters/RangeFilter'
const parse = (day?: string) => { if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined; const [y, m, d] = day.split('-').map(Number); const date = new Date(y, m - 1, d); return Number.isNaN(date.getTime()) ? undefined : date }
const day = (date?: Date) => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : undefined
export function RangeFilter({ value, onChange, type, labels, locale = 'en', calendarLabel = 'Select date range' }: { value: RangeInput; onChange: (value: RangeInput) => void; type: 'number' | 'date'; labels: { single: string; from: string; to: string }; locale?: string; calendarLabel?: string }) {
  if (type === 'number') return <NumericRange value={value} onChange={onChange} labels={labels} />
  return <div className="grid gap-3">
    <DateRangePicker value={{ from: parse(value.value ?? value.from), to: parse(value.value ?? value.to) }} onChange={range => onChange({ from: day(range?.from), to: day(range?.to) })} numberOfMonths={1} locale={locale.startsWith('cs') ? cs : enUS} label={calendarLabel} placeholder={calendarLabel} />
    {(['value', 'from', 'to'] as const).map(key => <label key={key} className="grid gap-1 text-sm">{labels[key === 'value' ? 'single' : key]}<Input type="text" placeholder="YYYY-MM-DD" value={value[key] ?? ''} onChange={event => onChange(key === 'value' ? { value: event.target.value } : { ...value, value: undefined, [key]: event.target.value })} /></label>)}
  </div>
}
