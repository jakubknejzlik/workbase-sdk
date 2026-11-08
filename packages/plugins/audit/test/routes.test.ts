import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { json, request, runtime, setup } from '@workbasehq/test-support/helpers'
import { seedAudit } from '../../../core/test/audit-helpers'
import { timeKey } from '../src/keys'
import { auditListBudget } from '../src/routes'

let app: Awaited<ReturnType<typeof setup>>
const at = '2026-10-28T12:34:56.789Z'
const fixture = (id: string, extra = {}) => ({ event_id: id, instance_id: 'sample', organization_id: 'org-a', entity: 'clients', entity_id: 'same_ID-1', occurred_at: at, operation: 'clients.created', ...extra })
beforeEach(async () => { app = await setup() })
it('P07: bulk reads a 25-event page and its lookahead in one KV call, preserving the cursor', async () => {
  await Promise.all(Array.from({ length: 26 }, (_, i) => seedAudit(fixture(`bulk-${String(i).padStart(3, '0')}`))))
  let listCalls = 0; const valueCalls: string[][] = []
  const observed = new Proxy(env.AUDIT_KV, { get(target, property) {
    if (property === 'list') return (options: KVNamespaceListOptions) => { listCalls++; return target.list(options) }
    if (property === 'get') return (keys: string | string[], type: 'json') => {
      valueCalls.push(Array.isArray(keys) ? keys : [keys])
      return Array.isArray(keys) ? target.get(keys, type) : target.get(keys, type)
    }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const isolated = createApp(sample, { ...runtime(), AUDIT_KV: observed })
  const path = `/audit/events?limit=25&from=${at}&to=${at}`
  const response = await request(isolated, path)
  expect(response.status).toBe(200)
  const first = await json(response)
  expect(first.data.map((event: any) => event.event_id)).toEqual(Array.from({ length: 25 }, (_, i) => `bulk-${String(i).padStart(3, '0')}`))
  expect(first.next_cursor).toBeTruthy()
  console.log(`P07 audit_rows=${first.data.length} kv_list=${listCalls} kv_get=${valueCalls.length} values=${valueCalls.flat().length}`)
  expect(listCalls).toBe(1); expect(valueCalls.map(keys => keys.length)).toEqual([26])
  listCalls = 0; valueCalls.length = 0
  const second = await json(await request(isolated, `${path}&cursor=${encodeURIComponent(first.next_cursor)}`))
  expect(second.data.map((event: any) => event.event_id)).toEqual(['bulk-025']); expect(second.next_cursor).toBeNull()
  expect(listCalls).toBe(1); expect(valueCalls.map(keys => keys.length)).toEqual([1])
})
async function seedFilters() {
  for (const event of [fixture('a', { occurred_at: '2026-10-27T00:00:00.000Z' }), fixture('b'), fixture('c', { entity: 'jobs' }),
    fixture('d', { entity_id: 'other' }), fixture('e', { occurred_at: '2026-10-29T00:00:00.000Z' }),
    fixture('foreign-org', { organization_id: 'org-b' }), fixture('foreign-instance', { instance_id: 'another' })]) await seedAudit(event)
}
it.each([
  ['', ['e', 'b', 'c', 'd', 'a']], ['entity=client', ['e', 'b', 'd', 'a']], ['entity=jobs', ['c']],
  ['entity=unknown', []], ['entity_id=same_ID-1', ['e', 'b', 'c', 'a']], ['entity=client&entity_id=same_ID-1', ['e', 'b', 'a']],
  [`from=${at}&to=${at}`, ['b', 'c', 'd']], [`from=${at}`, ['e', 'b', 'c', 'd']], [`to=${at}`, ['b', 'c', 'd', 'a']],
  ['from=2026-10-29&to=2026-10-27', []], ['from=2026-10-28T14:34:56.789%2B02:00&to=2026-10-28T14:34:56.789%2B02:00', ['b', 'c', 'd']],
])('preserves legacy filters and response shape: %s', async (query, ids) => {
  await seedFilters()
  const response = await request(app, `/audit/events?${query}`)
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(Object.keys(body)).toEqual(['data'])
  expect(body.data.map((event: any) => event.event_id)).toEqual(ids)
})
it('pages through timestamp ties and multiple native KV list pages without gaps or duplicates', async () => {
  await Promise.all(Array.from({ length: 111 }, (_, i) => seedAudit(fixture(`page-${String(i).padStart(3, '0')}`))))
  let cursor: string | null = null; const ids: string[] = []; const sizes: number[] = []
  do {
    const response = await request(app, `/audit/events?limit=37&entity=clients&entity_id=same_ID-1&from=${at}&to=${at}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(response.status).toBe(200)
    const page = await json(response)
    sizes.push(page.data.length); ids.push(...page.data.map((event: any) => event.event_id)); cursor = page.next_cursor
  } while (cursor)
  expect(sizes).toEqual([37, 37, 37]); expect(ids).toEqual(Array.from({ length: 111 }, (_, i) => `page-${String(i).padStart(3, '0')}`))
  expect((await json(await request(app, '/audit/events'))).data).toHaveLength(100)
})
it('pages a crowded timestamp tree newest first across days and native list boundaries', async () => {
  const events = Array.from({ length: 111 }, (_, i) => fixture(`tree-${String(i).padStart(3, '0')}`, {
    occurred_at: new Date(Date.UTC(2026, 9, 27 + Math.floor(i / 37), 10, 0, i % 37)).toISOString(),
  }))
  await Promise.all(events.map(seedAudit))
  let cursor: string | null = null; const ids: string[] = []
  do {
    const response = await request(app, `/audit/events?limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(response.status).toBe(200)
    const page = await json(response)
    ids.push(...page.data.map((event: any) => event.event_id)); cursor = page.next_cursor
    expect(ids.length).toBeLessThanOrEqual(events.length)
  } while (cursor)
  expect(ids).toEqual(events.map(event => event.event_id).reverse())
})
it('continues across filtered native pages and across time range prefixes, fetching only matching payloads', async () => {
  await seedFilters()
  let cursor: string | null = null; const ids: string[] = []
  do {
    const page = await json(await request(app, `/audit/events?limit=1&entity=clients&from=2026-10-27&to=2026-10-29${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
    ids.push(...page.data.map((event: any) => event.event_id)); cursor = page.next_cursor
  } while (cursor)
  expect(ids).toEqual(['e', 'b', 'd', 'a'])
  await Promise.all(Array.from({ length: 101 }, (_, i) => seedAudit(fixture(`0-filter-${i}`, { entity: 'jobs' }))))
  const gets: string[] = []; const prefixes: string[] = []
  const observed = new Proxy(env.AUDIT_KV, { get(target, property) {
    if (property === 'list') return (options: KVNamespaceListOptions) => { prefixes.push(options.prefix!); return target.list(options) }
    if (property === 'get') return (keys: string | string[], type: 'json') => {
      gets.push(...(Array.isArray(keys) ? keys : [keys]))
      return Array.isArray(keys) ? target.get(keys, type) : target.get(keys, type)
    }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const response = await request(createApp(sample, { ...runtime(), AUDIT_KV: observed }), `/audit/events?entity=clients&from=${at}&to=${at}&limit=1`)
  expect(response.status).toBe(200)
  expect((await json(response)).data.map((event: any) => event.event_id)).toEqual(['b'])
  expect(gets).toHaveLength(2); expect(gets.every(key => !key.includes('filter'))).toBe(true)
  expect(prefixes).toEqual([`org/org-a/i/sample/t/clients/${timeKey(at)}`])
})

// Model a large native result set without thousands of fixture writes. Native
// cursors are page boundaries; the API also retains its last inspected key.
function sparseKv(options: { matchAll?: boolean; missingBefore?: number } = {}) {
  const matches = [0, 89, 28349, 28350, 29999]
  let calls = 0; let gets = 0
  const kv = new Proxy(env.AUDIT_KV, { get(target, property) {
    if (property === 'list') return async (listOptions: KVNamespaceListOptions) => {
      calls++
      const start = listOptions.cursor ? Number(listOptions.cursor.slice(5)) : 0
      const end = Math.min(start + listOptions.limit!, 30000)
      return { keys: Array.from({ length: end - start }, (_, i) => ({ name: `${listOptions.prefix}/${String(start + i).padStart(5, '0')}`, metadata: {
        entity: 'clients', entity_id: options.matchAll || matches.includes(start + i) ? 'same_ID-1' : 'other', occurred_at: at, event_id: String(start + i),
      } })), list_complete: end === 30000, cursor: `scan-${end}`, cacheStatus: null }
    }
    if (property === 'get') return async (keys: string | string[]) => {
      const value = (key: string) => { gets++; return Number(key.split('/').at(-1)) < (options.missingBefore ?? 0) ? null : fixture(`event-${Number(key.split('/').at(-1))}`) }
      return Array.isArray(keys) ? new Map(keys.map(key => [key, value(key)])) : value(keys)
    }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  return { kv, matches, calls: () => calls, gets: () => gets }
}
it.each([1, 4, 90])('bounds entity_id-only scans and resumes every event exactly once (limit %s)', async limit => {
  const scan = sparseKv(); const isolated = createApp(sample, { ...runtime(), AUDIT_KV: scan.kv })
  let cursor: string | null = null; const ids: string[] = []; const sizes: number[] = []
  do {
    const before = scan.calls()
    const response = await request(isolated, `/audit/events?from=${at}&to=${at}&entity_id=same_ID-1&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(response.status).toBe(200)
    expect(scan.calls() - before).toBeLessThanOrEqual(auditListBudget)
    const page = await json(response)
    sizes.push(page.data.length); ids.push(...page.data.map((event: any) => event.event_id)); cursor = page.next_cursor
    if (sizes.length === 1 && limit > 1) { expect(page.data).toHaveLength(3); expect(cursor).toBeTruthy(); expect(scan.calls()).toBe(auditListBudget) }
  } while (cursor)
  expect(ids).toEqual(scan.matches.map(i => `event-${i}`))
  if (limit > 1) expect(sizes).toEqual([3, 2])
})
it('bounds legacy metadata scans and retains the data-only response shape', async () => {
  const scan = sparseKv()
  const response = await request(createApp(sample, { ...runtime(), AUDIT_KV: scan.kv }), `/audit/events?from=${at}&to=${at}&entity_id=same_ID-1`)
  expect(await json(response)).toEqual({ data: [0, 89, 28349].map(i => fixture(`event-${i}`)) })
  expect(scan.calls()).toBe(auditListBudget); expect(scan.gets()).toBe(3)
})
it.each(['', '&entity=clients', '&entity=clients&entity_id=same_ID-1'])('bounds missing value reads and resumes within the native page: %s', async filter => {
  const scan = sparseKv({ matchAll: true, missingBefore: 600 })
  const isolated = createApp(sample, { ...runtime(), AUDIT_KV: scan.kv })
  const first = await json(await request(isolated, `/audit/events?from=${at}&to=${at}&limit=1${filter}`))
  expect(first.data).toEqual([]); expect(first.next_cursor).toBeTruthy()
  expect(scan.gets()).toBe(600); expect(scan.calls()).toBe(7)
  const second = await json(await request(isolated, `/audit/events?from=${at}&to=${at}&limit=1${filter}&cursor=${encodeURIComponent(first.next_cursor)}`))
  expect(second.data).toEqual([fixture('event-600')])
  expect(second.next_cursor).toBeTruthy()
  expect(scan.gets()).toBe(602)
})
it.each([false, true])('bounds empty native pages and resumes after the last scanned cursor (paginated %s)', async paginated => {
  const cursors: (string | undefined)[] = []
  const kv = new Proxy(env.AUDIT_KV, { get(target, property) {
    if (property === 'list') return async (options: KVNamespaceListOptions) => {
      cursors.push(options.cursor ?? undefined)
      const index = Number(options.cursor ?? 0)
      return { keys: index < auditListBudget ? [] : [{ name: `${options.prefix}${timeKey(at)}/visible`, metadata: { entity: 'clients', entity_id: 'same_ID-1' } }],
        list_complete: index === auditListBudget, cursor: String(index + 1), cacheStatus: null }
    }
    if (property === 'get') return async (keys: string | string[]) => Array.isArray(keys) ? new Map(keys.map(key => [key, fixture('visible')])) : fixture('visible')
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const isolated = createApp(sample, { ...runtime(), AUDIT_KV: kv })
  const first = await json(await request(isolated, `/audit/events${paginated ? '?limit=1' : ''}`))
  expect(first.data).toEqual([]); expect(cursors).toHaveLength(auditListBudget)
  if (paginated) {
    expect(first.next_cursor).toBeTruthy()
    const second = await json(await request(isolated, `/audit/events?cursor=${encodeURIComponent(first.next_cursor)}`))
    expect(second).toEqual({ data: [fixture('visible')], next_cursor: null })
    expect(cursors.at(-1)).toBe(String(auditListBudget))
  } else expect(Object.keys(first)).toEqual(['data'])
})
it('resumes older ranges and skips late newer arrivals without shifting a page', async () => {
  await seedAudit(fixture('older', { occurred_at: '2026-10-27T00:00:00.000Z' }))
  await seedAudit(fixture('b')); await seedAudit(fixture('d'))
  const path = '/audit/events?limit=1&from=2026-10-27&to=2026-10-29'
  const first = await json(await request(app, path))
  expect(first.data.map((event: any) => event.event_id)).toEqual(['b'])
  await seedAudit(fixture('a')) // Inserts before the old within-page offset.
  await seedAudit(fixture('newest', { occurred_at: '2026-10-29T00:00:00.000Z' }))
  const second = await json(await request(app, `${path}&cursor=${encodeURIComponent(first.next_cursor)}`))
  expect(second.data.map((event: any) => event.event_id)).toEqual(['d'])
  const third = await json(await request(app, `${path}&cursor=${encodeURIComponent(second.next_cursor)}`))
  expect(third.data.map((event: any) => event.event_id)).toEqual(['older'])
  expect(third.next_cursor).toBeNull()
  expect((await json(await request(app, path))).data[0].event_id).toBe('newest')
})
it('bounds legacy payload reads when all matching values are missing', async () => {
  const scan = sparseKv({ matchAll: true, missingBefore: 30000 })
  const response = await request(createApp(sample, { ...runtime(), AUDIT_KV: scan.kv }), `/audit/events?from=${at}&to=${at}`)
  expect(await json(response)).toEqual({ data: [] })
  expect(scan.gets()).toBe(600); expect(scan.calls()).toBe(7)
})
it('builds every list prefix from scope and confines from/to at storage level', async () => {
  await seedFilters()
  const prefixes: string[] = []
  const observed = new Proxy(env.AUDIT_KV, { get(target, property) {
    if (property === 'list') return (options: KVNamespaceListOptions) => { prefixes.push(options.prefix!); return target.list(options) }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const isolated = createApp(sample, { ...runtime(), AUDIT_KV: observed })
  const response = await request(isolated, `/audit/events?org=org-a&organization_id=org-a&instance=another&from=${at}&to=${at}`, 'GET', undefined, 'owner-b', 'org-b')
  expect(response.status).toBe(200)
  expect((await json(response)).data.map((event: any) => event.event_id)).toEqual(['foreign-org'])
  expect(prefixes).toEqual([`org/org-b/i/sample/all/${timeKey(at)}`])
  expect((await request(isolated, '/audit/events?entity=clients%2F..%2Forg-a&entity_id=..%2Fall')).status).toBe(200)
  expect(prefixes.at(-1)).toBe('org/org-a/i/sample/e/clients%2F..%2Forg-a/..%2Fall/')
})
it('escapes slash in entity ids for reads as well as writes', async () => {
  await seedAudit(fixture('slash', { entity_id: 'a/b' }))
  expect((await json(await request(app, '/audit/events?entity=client&entity_id=a%2Fb'))).data.map((event: any) => event.event_id)).toEqual(['slash'])
})
it('rejects tampered, malformed, cross-tenant and changed-filter cursors before listing', async () => {
  await seedFilters()
  const { next_cursor: cursor } = await json(await request(app, '/audit/events?limit=1'))
  expect(cursor).toBeTruthy()
  for (const value of ['bad', '', 'x'.repeat(8001), btoa(JSON.stringify([at, 'b'])), `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`]) {
    const response = await request(app, `/audit/events?limit=1&cursor=${encodeURIComponent(value)}`)
    expect(response.status).toBe(400); expect(await json(response)).toEqual({ error: 'invalid_cursor' })
  }
  for (const query of ['entity=jobs', `from=${at}`, 'entity_id=other']) expect((await request(app, `/audit/events?limit=1&${query}&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400)
  expect((await request(app, `/audit/events?limit=1&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, 'owner-b', 'org-b')).status).toBe(400)
})
it.each(['0', '91', '1.5', 'NaN', '-1', ''])('rejects invalid limit %s', async limit => {
  expect(await json(await request(app, `/audit/events?limit=${limit}`))).toEqual({ error: 'invalid_limit' })
})
it.each(['from=bad', 'to=bad', 'from=NaN'])('rejects invalid date %s', async query => {
  expect(await json(await request(app, `/audit/events?${query}`))).toEqual({ error: 'invalid_date' })
})
it('retains owner-only authorization', async () => {
  const response = await request(app, '/audit/events', 'GET', undefined, 'viewer-a')
  expect(response.status).toBe(403); expect(await json(response)).toEqual({ error: 'owner_required' })
})
it('continues past an empty KV list page when list_complete is false', async () => {
  await seedAudit(fixture('visible'))
  let injected = false
  const kv = new Proxy(env.AUDIT_KV, { get(target, property) {
    if (property === 'list') return async (options: KVNamespaceListOptions) => {
      if (!injected) { injected = true; return { keys: [], list_complete: false, cursor: 'empty-page', cacheStatus: null } }
      return target.list({ ...options, cursor: options.cursor === 'empty-page' ? undefined : options.cursor })
    }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const response = await request(createApp(sample, { ...runtime(), AUDIT_KV: kv }), '/audit/events?limit=1')
  expect(response.status).toBe(200)
  expect(await json(response)).toEqual({ data: [fixture('visible')], next_cursor: null })
})
