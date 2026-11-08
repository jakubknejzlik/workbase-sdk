import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { cs, enUS } from '@workbasehq/ui'
import { Button } from '@workbasehq/ui/components/ui/button'
import { Calendar } from '@workbasehq/ui/components/ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from '@workbasehq/ui/components/ui/popover'
import { formatFieldValue, type Model, type Capabilities, type Result } from './read'
import { availableCalendar, addDays, calendarRange, dayKey, localDay, eventOnDay, calendarCreateField, calendarTitle } from './calendar-model'
import { useEntityTranslation } from './entity-translation'
import type { ListState } from './list-model'

export function EntityCalendar({ model, entity, caps, orgId, state, data, pending, error, onChange, onCreate, onPage, previous }: {
  model: Model; entity: string; caps: Capabilities; orgId: string; state: ListState; data?: Result; pending: boolean; error?: string
  onChange: (state: ListState) => void; onCreate?: (values: Record<string, string>) => void; onPage: (direction: 'next' | 'previous') => void; previous: boolean
}) {
  const { t, i18n } = useEntityTranslation(entity)
  const view = availableCalendar(model, entity, caps)!
  const date = state.calendarDate!; const mode = state.calendarMode ?? 'month'
  const { start, end } = calendarRange(date, mode)
  const [jump, setJump] = useState(false)
  const [focused, setFocused] = useState(date)
  const focusAfterChange = useRef(false)
  const grid = useRef<HTMLTableElement>(null)
  const dates: Date[] = []
  for (let day = start; day < end; day = addDays(day, 1)) dates.push(day)
  const fullDate = (day: Date) => day.toLocaleDateString(i18n.language, { dateStyle: 'full' })
  const setDate = (next: Date) => onChange({ ...state, calendarDate: dayKey(next) })
  const move = (amount: number) => { const next = localDay(date); if (mode === 'week') next.setDate(next.getDate() + 7 * amount); else { next.setDate(1); next.setMonth(next.getMonth() + amount) }; setDate(next) }
  useEffect(() => {
    if (focusAfterChange.current) { grid.current?.querySelector<HTMLButtonElement>(`[data-calendar-day="${focused}"]`)?.focus(); focusAfterChange.current = false }
  }, [date, focused, mode])
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, day: Date) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -(day.getDay() + 6) % 7, End: 6 - (day.getDay() + 6) % 7 }[event.key]
    if (offset === undefined) return
    event.preventDefault(); const next = addDays(day, offset); setFocused(dayKey(next)); focusAfterChange.current = true
    if (next < start || next >= end) setDate(next)
  }
  const canCreate = !!onCreate && calendarCreateField(model, entity, caps, view)
  const rows = data?.data ?? []
  const createDay = (day: Date) => {
    if (!canCreate) return
    grid.current?.querySelector<HTMLButtonElement>(`[data-calendar-day="${dayKey(day)}"]`)?.focus()
    const instant = new Date(day); instant.setHours(9)
    onCreate!({ [view.startField]: instant.toISOString() })
  }
  const title = mode === 'month' ? localDay(date).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' }) : `${start.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })} – ${addDays(end, -1).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })}`
  return <section data-entity-calendar="" aria-label={t('calendarView')} aria-busy={pending} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="icon" aria-label={t('calendarPrevious')} onClick={() => move(-1)}>‹</Button>
      <Popover open={jump} onOpenChange={setJump}><PopoverTrigger asChild><Button variant="outline" aria-label={`${t('calendarJump')}: ${title}`}>{title}</Button></PopoverTrigger><PopoverContent aria-label={t('calendarJump')} className="w-auto p-0" align="start"><Calendar locale={i18n.language.startsWith('cs') ? cs : enUS} mode="single" weekStartsOn={1} selected={localDay(date)} defaultMonth={localDay(date)} onSelect={day => { if (day) { setDate(day); setJump(false) } }} formatters={{ formatCaption: day => day.toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' }), formatWeekdayName: day => day.toLocaleDateString(i18n.language, { weekday: 'short' }) }} labels={{ labelNext: () => t('calendarNext'), labelPrevious: () => t('calendarPrevious'), labelDayButton: fullDate, labelGrid: () => t('calendarView'), labelNav: () => t('calendarJump') }} /></PopoverContent></Popover>
      <Button variant="outline" size="icon" aria-label={t('calendarNext')} onClick={() => move(1)}>›</Button>
      <Button variant="ghost" onClick={() => setDate(new Date())}>{t('calendarToday')}</Button>
      <div role="group" aria-label={t('calendarPeriod')} className="flex gap-1">{(['month', 'week'] as const).map(value => <Button key={value} variant={value === mode ? 'secondary' : 'ghost'} aria-pressed={value === mode} onClick={() => onChange({ ...state, calendarMode: value })}>{t(`calendar_${value}`)}</Button>)}</div>
    </div>
    <p className="text-sm text-muted-foreground" id={`calendar-help-${entity}`}>{t(canCreate ? 'calendarCreateHelp' : 'calendarBrowseHelp')}</p>
    <div role="status" className="text-sm">{error || (pending ? t('loading') : !rows.length ? t('calendarEmpty') : t('calendarEventCount', { count: rows.length }))}</div>
    <table ref={grid} className={`w-full table-fixed border-collapse ${mode === 'week' ? 'block md:table' : ''}`} aria-label={title} aria-describedby={`calendar-help-${entity}`}>
      <thead className={mode === 'week' ? 'hidden md:table-header-group' : undefined}><tr>{dates.slice(0, 7).map(day => <th key={dayKey(day)} scope="col" className="border p-1 text-xs font-medium"><abbr className="no-underline" title={day.toLocaleDateString(i18n.language, { weekday: 'long' })}>{day.toLocaleDateString(i18n.language, { weekday: 'short' })}</abbr></th>)}</tr></thead>
      <tbody className={mode === 'week' ? 'block md:table-row-group' : undefined}>{Array.from({ length: dates.length / 7 }, (_, week) => <tr key={week} className={mode === 'week' ? 'block md:table-row' : undefined}>{dates.slice(week * 7, week * 7 + 7).map(day => {
        const key = dayKey(day); const events = rows.filter(row => eventOnDay(row, view, day))
        return <td key={key} onClick={event => { if (event.target === event.currentTarget) createDay(day) }} className={`${mode === 'week' ? 'block h-auto md:table-cell' : 'h-28'} min-w-0 border p-0.5 align-top md:h-36 md:p-2 ${day.getMonth() !== localDay(date).getMonth() && mode === 'month' ? 'bg-muted/40' : ''}`}>
          <button type="button" data-calendar-day={key} className={`mb-1 flex ${mode === 'week' ? 'h-8 px-2 md:size-8 md:px-0' : 'size-8'} items-center justify-center rounded-md text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring`} tabIndex={focused === key || !dates.some(value => dayKey(value) === focused) && key === dayKey(start) ? 0 : -1} aria-label={canCreate ? t('calendarCreateOn', { date: fullDate(day) }) : fullDate(day)} aria-current={key === dayKey(new Date()) ? 'date' : undefined} onFocus={() => setFocused(key)} onKeyDown={event => keyboard(event, day)} onClick={() => createDay(day)}><span className={mode === 'week' ? 'hidden md:inline' : undefined}>{day.getDate()}</span>{mode === 'week' && <span className="md:hidden">{fullDate(day)}</span>}</button>
          <ul className="space-y-1">{events.map(row => {
            const label = calendarTitle(model, entity, caps, view, row, i18n.language, t)
            const secondary = mode === 'week' && view.secondaryField && caps.entities[entity].readable.includes(view.secondaryField) && row[view.secondaryField] != null ? formatFieldValue(row[view.secondaryField], model.entities[entity].fields[view.secondaryField], i18n.language, t) : undefined
            const time = new Date(row[view.startField]).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
            return <li key={row.id}><Link data-calendar-event="" to="/o/$orgId/e/$entity/$id" params={{ orgId, entity, id: String(row.id) }} title={`${time} ${label}`} className="block rounded bg-primary/10 p-1 text-xs text-foreground [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><time className="block text-[10px] text-muted-foreground" dateTime={row[view.startField]}>{time}</time>{' '}<span className="block truncate md:whitespace-normal md:[overflow-wrap:anywhere]">{label}</span>{secondary && <span data-calendar-secondary="" className="mt-0.5 block text-muted-foreground">{secondary}</span>}</Link></li>
          })}</ul>
        </td>
      })}</tr>)}</tbody>
    </table>
    {(data?.next_cursor || previous) && <div className="space-y-2"><p role="status" className="text-sm">{t('calendarPaged')}</p><div className="flex gap-2"><Button variant="outline" disabled={!previous || pending} onClick={() => onPage('previous')}>{t('previousPage')}</Button><Button variant="outline" disabled={!data?.next_cursor || pending} onClick={() => onPage('next')}>{t('nextPage')}</Button></div></div>}
  </section>
}
