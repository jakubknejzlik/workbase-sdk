import { useEffect, useState } from 'react'
import type { RangeInput } from '../vendor/tiketo/components/data-table/filters/RangeFilter'
import { Calendar } from '../components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { cs, enUS } from 'react-day-picker/locale'
export type { RangeInput } from '../vendor/tiketo/components/data-table/filters/RangeFilter'
const parse = (day?: string) => { if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined; const [y, m, d] = day.split('-').map(Number); const date = new Date(y, m - 1, d); return Number.isNaN(date.getTime()) ? undefined : date }
const day = (date?: Date) => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : undefined
type Operator = 'equals' | 'from' | 'to' | 'between'
const mode = (value: RangeInput): Operator | undefined => value.value ? 'equals' : value.from && value.to ? 'between' : value.from ? 'from' : value.to ? 'to' : undefined
/** Compact editor only: the host still validates and applies the existing RangeInput. */
export function RangeFilter({ value, onChange, type, labels, locale = 'en', calendarLabel = 'Select date range', lowerBoundOnly = false, operators, localDay = false }: { value: RangeInput; onChange: (value: RangeInput) => void; type: 'number' | 'date'; labels: { single: string; from: string; to: string; operator?: string; equals?: string; between?: string }; locale?: string; calendarLabel?: string; lowerBoundOnly?: boolean; operators?: readonly string[]; localDay?: boolean }) {
  const allowed = (operator: string) => !operators || operators.includes(operator)
  const from = allowed('gte'), to = allowed(localDay ? 'lt' : 'lte')
  const modes: Operator[] = lowerBoundOnly ? ['from'] : [
    ...((localDay ? from && to : allowed('eq')) ? ['equals' as const] : []),
    ...(from ? ['from' as const] : []), ...(to ? ['to' as const] : []), ...(from && to ? ['between' as const] : []),
  ]
  const initial = mode(value)
  const [operator, setOperator] = useState<Operator>(() => initial && modes.includes(initial) ? initial : type === 'number' && modes.includes('from') ? 'from' : modes[0])
  // Restored values / host Clear can change independently of this editor.
  useEffect(() => { const next = mode(value); if (next && modes.includes(next) && !(operator === 'between' && (next === 'from' || next === 'to'))) setOperator(next) }, [value.value, value.from, value.to, modes.join()])
  const active = modes.includes(operator) ? operator : modes[0]
  const keys = active === 'equals' ? ['value' as const] : active === 'between' ? ['from' as const, 'to' as const] : active ? [active] as ('from' | 'to')[] : []
  const caption = { equals: labels.equals ?? labels.single, from: `${labels.from} (≥)`, to: `${labels.to} (${localDay ? '<' : '≤'})`, between: labels.between ?? `${labels.from} – ${labels.to}` }
  return <div className="grid min-w-0 gap-2">
    <label className="grid min-w-0 gap-1 text-sm"><span className="sr-only">{labels.operator ?? 'Operator'}</span><select className="min-h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm" aria-label={labels.operator ?? 'Operator'} value={active} onChange={event => { setOperator(event.target.value as Operator); onChange({}) }}>
      {modes.map(option => <option key={option} value={option}>{caption[option]}</option>)}
    </select></label>
    <div className="grid min-w-0 gap-2" style={active === 'between' ? { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 8rem), 1fr))' } : undefined}>{keys.map(key => {
      const label = labels[key === 'value' ? 'single' : key]
      const change = (text?: string) => onChange(active === 'equals' ? { value: text } : active === 'between' ? { from: value.from, to: value.to, [key]: text } : { [key]: text })
      return <label key={key} className="grid min-w-0 gap-1 text-sm">{label}<span className="flex min-w-0 gap-1">
        <Input className="min-w-0" type={type === 'number' ? 'number' : 'text'} step={type === 'number' ? 'any' : undefined} placeholder={type === 'date' ? 'YYYY-MM-DD' : undefined} value={value[key] ?? ''} onChange={event => change(event.target.value)} />
        {type === 'date' && <CalendarInput value={value[key]} onChange={change} locale={locale} label={`${calendarLabel}: ${label}`} />}
      </span></label>
    })}</div>
  </div>
}

function CalendarInput({ value, onChange, locale, label }: { value?: string; onChange: (value?: string) => void; locale: string; label: string }) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" size="icon" variant="outline" aria-label={label}><svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z" /></svg></Button></PopoverTrigger>
    <PopoverContent aria-label={label} className="w-auto max-w-[calc(100vw-1rem)] overflow-auto p-0" align="start" collisionPadding={8}>
      <Calendar mode="single" selected={parse(value)} defaultMonth={parse(value)} onSelect={date => { onChange(day(date)); setOpen(false) }} locale={locale.startsWith('cs') ? cs : enUS} />
    </PopoverContent>
  </Popover>
}
