import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { EntityCalendar } from '../../console-generated/src/calendar'
import * as timeZone from '../../console-generated/src/time-zone'
import { stateFromSearch, type ListState } from '../../console-generated/src/list-model'
import type { Model, Capabilities } from '../../console-generated/src/read'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
const instant = '2026-10-24T22:30:00Z'
const model: Model = { instance: 'calendar', revision: 1, timeZone: 'Europe/Prague', limits: { root: 100, children: 10, relations: 4, exists: 4 }, entities: { events: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, starts: { type: 'datetime' }, ends: { type: 'datetime' }, updated: { type: 'datetime' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' }, writeSchema: { properties: { starts: { type: 'string' } } }, views: [{ kind: 'calendar', startField: 'starts', endField: 'ends', secondaryField: 'updated' }] } } }
const caps: Capabilities = { revision: 1, entities: { events: { readable: ['id', 'name', 'starts', 'ends', 'updated'], writable: ['starts'], operations: ['read', 'create'] } } }
afterEach(() => { vi.restoreAllMocks() })
async function mount(language: 'en' | 'cs' = 'en', zone: string | undefined = 'Europe/Prague', performanceRows?: Record<string, string>[]) {
  const configured = { ...model, timeZone: zone }; const create = vi.fn(), change = vi.fn()
  const Harness = () => {
    const [state, setState] = useState<ListState>(stateFromSearch({ presentation: 'calendar', calendarDate: performanceRows ? '2026-03-15' : '2026-10-25', calendarMode: performanceRows ? 'month' : 'week' }, configured, 'events', caps).state)
    return <EntityCalendar model={configured} caps={caps} entity="events" orgId="org" state={state} pending={false} previous={false} onPage={() => {}} onCreate={create} onChange={next => { change(next); setState(next) }} data={{ next_cursor: null, data: performanceRows ?? [{ id: '1', name: 'Prague event', starts: instant, updated: instant }, { id: '2', name: 'Ends at midnight', starts: '2026-10-23T21:30:00Z', ends: '2026-10-24T22:00:00Z' }, { id: '3', name: 'Multiple days', starts: '2026-10-23T21:30:00Z', ends: '2026-10-25T23:00:00Z' }] }} />
  }
  const root = createRootRoute(), route = createRoute({ getParentRoute: () => root, path: '/', component: Harness })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/'] }) }); await router.load()
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } } })
  const rendered = render(<I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider>)
  await screen.findByText('Prague event')
  const day = (date: string) => rendered.container.querySelector<HTMLButtonElement>(`[data-calendar-day="${date}"]`)!
  return { ...rendered, create, change, day, user: userEvent.setup(), t: language === 'en' ? en : cs }
}
it.each(['en', 'cs'] as const)('places and formats events/secondary in Prague, locale %s, creates at civil 09:00', async language => {
  const { day, create, user } = await mount(language)
  const cell = day('2026-10-25').closest('td')!
  const event = within(cell).getByText('Prague event').closest('a')!
  const format = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' })
  expect(event.querySelector('time')?.textContent).toBe(format.format(new Date(instant)))
  expect(event.querySelector('time')?.getAttribute('datetime')).toBe(instant)
  expect(event.querySelector('[data-calendar-secondary]')?.textContent).toBe(new Intl.DateTimeFormat(language === 'cs' ? 'cs-CZ' : language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }).format(new Date(instant)))
  expect(within(cell).queryByText('Ends at midnight')).toBeNull(); expect(within(cell).getByText('Multiple days')).toBeTruthy()
  await user.click(day('2026-10-25')); expect(create).toHaveBeenCalledWith({ starts: '2026-10-25T08:00:00.000Z' })
})
it('keeps week/month, keyboard and date-picker navigation civil', async () => {
  const { user, day, change, t } = await mount()
  day('2026-10-25').focus(); await user.keyboard('{ArrowRight}')
  expect(change.mock.calls.at(-1)?.[0].calendarDate).toBe('2026-10-26'); expect(document.activeElement).toBe(day('2026-10-26'))
  await user.keyboard('{Home}'); expect(document.activeElement).toBe(day('2026-10-26'))
  await user.keyboard('{End}'); expect(document.activeElement).toBe(day('2026-11-01'))
  await user.click(screen.getByRole('button', { name: t.calendarPrevious })); expect(change.mock.calls.at(-1)?.[0].calendarDate).toBe('2026-10-19')
  await user.click(screen.getByRole('button', { name: t.calendar_month }))
  await user.click(screen.getByRole('button', { name: t.calendarNext })); expect(change.mock.calls.at(-1)?.[0].calendarDate).toBe('2026-11-01')
  await user.click(screen.getByRole('button', { name: new RegExp(`^${t.calendarJump}`) }))
  const picker = screen.getByRole('dialog', { name: t.calendarJump })
  await user.click(within(picker).getByRole('button', { name: /Sunday, November 15, 2026$/ }))
  expect(change.mock.calls.at(-1)?.[0].calendarDate).toBe('2026-11-15')
})
it('Today and current-day marker use the instance date at a host-mismatched instant', async () => {
  const { day, change, t } = await mount()
  const RealDate = Date
  vi.spyOn(globalThis, 'Date').mockImplementation(function(value?: any) { return value === undefined ? new RealDate(instant) : new RealDate(value) } as any)
  fireEvent.click(screen.getByRole('button', { name: t.calendarToday }))
  expect(change.mock.calls.at(-1)?.[0].calendarDate).toBe('2026-10-25')
  expect(day('2026-10-25').getAttribute('aria-current')).toBe('date')
})
it.each(['Not/AZone', 'UTC'])('uses UTC fallback clock and create defaults for %s', async zone => {
  const { day, user, create } = await mount('en', zone)
  const event = within(day('2026-10-24').closest('td')!).getByText('Prague event').closest('a')!
  expect(event.querySelector('time')?.textContent).toBe(new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(instant)))
  await user.click(day('2026-10-25')); expect(create).toHaveBeenCalledWith({ starts: '2026-10-25T09:00:00.000Z' })
})

// Reviewer probe: six displayed weeks × 100 events; count conversions, not elapsed time.
it('converts each displayed day boundary once outside the event loop', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: i === 0 ? 'Prague event' : `Event ${i}`, starts: new Date(Date.UTC(2026, 2, 1 + i % 31, 9)).toISOString(), ends: new Date(Date.UTC(2026, 2, 1 + i % 31, 10)).toISOString() }))
  const conversions = vi.spyOn(timeZone, 'civilInstant')
  const { container } = await mount('en', 'Europe/Prague', rows)
  expect(container.querySelectorAll('[data-calendar-day]')).toHaveLength(42)
  expect(container.querySelectorAll('[data-calendar-event]')).toHaveLength(100)
  expect(conversions.mock.calls.length).toBeLessThanOrEqual(42 * 2)
})
