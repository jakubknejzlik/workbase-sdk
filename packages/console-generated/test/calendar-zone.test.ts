import { expect, it, vi } from 'vitest'
import { calendarRange, calendarQuery, dayKey, eventOnDay } from '../src/calendar-model'
import { stateFromSearch } from '../src/list-model'
import { filterMapping } from '../src/filter-kinds'
import type { Model, Capabilities } from '../src/read'
const view = { kind: 'calendar' as const, startField: 'starts', endField: 'ends' }
const model: Model = { instance: 'zone', revision: 1, timeZone: 'Europe/Prague', limits: { root: 100, children: 10, relations: 4, exists: 4 }, entities: { events: { fields: { id: { type: 'string' }, starts: { type: 'datetime' }, ends: { type: 'datetime' } }, columns: ['starts'], relations: {}, routes: { list: '', detail: '' }, views: [view] } } }
const caps: Capabilities = { revision: 1, entities: { events: { readable: ['id', 'starts', 'ends'], writable: [], operations: ['read'] } } }
it.each([['2026-03-29', '2026-03-22T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 167], ['2026-10-25', '2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 169]] as const)('uses Prague civil week boundaries %s', (day, start, end, hours) => {
  const range = calendarRange(day, 'week', model.timeZone)
  expect([range.start.toISOString(), range.end.toISOString(), (+range.end - +range.start) / 3600000]).toEqual([start, end, hours])
  expect(calendarQuery({ entity: 'events', select: ['id'], limit: 10 }, { kind: 'calendar', startField: 'starts' }, day, 'week', model).where).toEqual({ and: [{ starts: { gte: start, lt: end } }] })
})
it('places cross-midnight and multiday events with exclusive midnight ends', () => {
  const on = (starts: string, ends: string | undefined, day: string) => eventOnDay({ starts, ends }, view, day, model.timeZone)
  expect(on('2026-10-24T22:30:00Z', undefined, '2026-10-25')).toBe(true)
  expect(on('2026-10-24T22:30:00Z', undefined, '2026-10-24')).toBe(false)
  expect(on('2026-10-24T21:30:00Z', '2026-10-25T23:00:00Z', '2026-10-25')).toBe(true)
  expect(on('2026-10-24T21:30:00Z', '2026-10-25T23:00:00Z', '2026-10-26')).toBe(false)
})
it('uses instance Today for the default anchor', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T22:30:00Z'))
  try { expect(dayKey(new Date(), model.timeZone)).toBe('2026-10-25'); expect(stateFromSearch({}, model, 'events', caps).state.calendarDate).toBe('2026-10-25') } finally { vi.useRealTimers() }
})
it.each([undefined, 'Not/AZone'])('uses UTC fallback %s for month bounds and filters', zone => {
  expect(calendarRange('2026-10-25', 'month', zone).start.toISOString()).toBe('2026-09-28T00:00:00.000Z')
  expect(filterMapping('date', { type: 'datetime' }, 'en', undefined, zone).toPredicate({ value: '2026-10-25' }, true)).toEqual({ gte: '2026-10-25T00:00:00.000Z', lt: '2026-10-26T00:00:00.000Z' })
})
