import { afterAll, beforeAll, expect, it } from 'vitest'
import { filterMapping } from '../src/filter-kinds'
import { toQueryDocument, stateFromSearch } from '../src/list-model'
import { formatValue, instanceTimeZone } from '../src/labels'
import type { Capabilities, Model } from '../src/read'

// The host zone is deliberately neither UTC nor the instance zone.
const host = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/Los_Angeles' })
afterAll(() => { if (host === undefined) delete process.env.TZ; else process.env.TZ = host })
const model = (timeZone?: string): Model => ({ instance: 'tz', revision: 1, timeZone, limits: { root: 100, children: 10, relations: 4, exists: 4 }, entities: {
  events: { fields: { id: { type: 'string' }, name: { type: 'string' }, starts: { type: 'datetime' }, day: { type: 'date' } }, columns: ['name', 'starts', 'day'], relations: {}, routes: { list: '', detail: '' }, list: { filter: { starts: { kind: 'date', placement: 'panel', operators: ['gte', 'lte', 'lt'] } } } },
} })
const caps: Capabilities = { revision: 1, entities: { events: { readable: ['id', 'name', 'starts', 'day'], writable: [], operations: ['read'] } } }
const field = { type: 'datetime' }

it('renders datetimes in the instance zone, not the host zone, across DST', () => {
  expect(formatValue('2026-11-17T23:30:00Z', field, 'en', 'y', 'n', '-', 'Asia/Tokyo')).toBe('Nov 18, 2026, 8:30 AM')
  expect(formatValue('2026-11-17T23:30:00Z', field, 'en', 'y', 'n', '-', 'America/Los_Angeles')).toBe('Nov 17, 2026, 3:30 PM')
  // Europe/Prague leaves summer time on 2026-10-25: the same wall clock maps to different offsets.
  expect(formatValue('2026-10-24T22:30:00Z', field, 'en', 'y', 'n', '-', 'Europe/Prague')).toBe('Oct 25, 2026, 12:30 AM')
  expect(formatValue('2026-10-25T22:30:00Z', field, 'en', 'y', 'n', '-', 'Europe/Prague')).toBe('Oct 25, 2026, 11:30 PM')
  expect(formatValue('2026-11-17T23:30:00Z', field, 'cs', 'y', 'n', '-', 'Europe/Prague')).toBe('18. 11. 2026 0:30')
})
it('keeps date-only values on their calendar day in every zone and applies the cell whitelist', () => {
  for (const zone of ['Asia/Tokyo', 'Pacific/Honolulu', 'UTC']) expect(formatValue('2026-11-17', { type: 'date' }, 'en', 'y', 'n', '-', zone)).toBe('Nov 17, 2026')
  expect(formatValue('2026-11-17T23:30:00Z', field, 'en', 'y', 'n', '-', 'Asia/Tokyo', 'date')).toBe('Nov 18, 2026')
  expect(formatValue('1234567.5', { type: 'string' }, 'cs', 'y', 'n', '-', 'UTC', 'number')).toBe('1\u00a0234\u00a0567,5')
  expect(formatValue(1234567.5, { type: 'float' }, 'en', 'y', 'n', '-')).toBe('1,234,567.5')
})
it('falls back to UTC, never the host, for a missing or invalid zone', () => {
  expect(instanceTimeZone(undefined)).toBe('UTC')
  expect(instanceTimeZone('Not/AZone')).toBe('UTC')
  expect(formatValue('2026-11-17T23:30:00Z', field, 'en', 'y', 'n', '-')).toBe('Nov 17, 2026, 11:30 PM')
})
it('compiles date filters to the instance zone day boundaries (DST-aware) and shows the same day in chips', () => {
  const tokyo = model('Asia/Tokyo'), search = { filters: [{ field: 'starts', predicate: { gte: '2026-11-17', lte: '2026-11-17' } }] }
  const { state } = stateFromSearch(search, tokyo, 'events', caps)
  expect(toQueryDocument(state, tokyo, 'events', caps).where).toEqual({ and: [{ starts: { gte: '2026-11-16T15:00:00.000Z', lt: '2026-11-17T15:00:00.000Z' } }] })
  const prague = model('Europe/Prague'), range = stateFromSearch({ filters: [{ field: 'starts', predicate: { gte: '2026-10-25', lte: '2026-10-25' } }] }, prague, 'events', caps)
  expect(toQueryDocument(range.state, prague, 'events', caps).where).toEqual({ and: [{ starts: { gte: '2026-10-24T22:00:00.000Z', lt: '2026-10-25T23:00:00.000Z' } }] })
  const mapping = filterMapping('date', field, 'en', ['gte', 'lte'], 'Asia/Tokyo')
  expect(mapping.fromPredicate({ gte: '2026-11-16T15:00:00.000Z' })).toEqual({ from: '2026-11-17' })
  expect(mapping.label({ from: '2026-11-17' }, key => key)).toBe('Nov 17, 2026 – filterMaximum')
  expect(filterMapping('date', field, 'cs', undefined, 'Asia/Tokyo').label({ value: '2026-11-17' }, key => key)).toBe('17. 11. 2026')
})
