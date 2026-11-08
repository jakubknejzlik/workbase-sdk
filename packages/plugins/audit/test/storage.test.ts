import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import type { AuditEvent } from '../../../core/src/audit-event'
import { KvAuditSink, audit } from '../src'
import { auditPrefix, sortKey, timeKey, timePrefixes, type AuditMetadata } from '../src/keys'

const event = (extra: Partial<AuditEvent> = {}): AuditEvent => ({ event_id: 'event-A_1', instance_id: 'sample', organization_id: 'org-a',
  actor: { type: 'user', id: 'owner-a' }, operation: 'clients.created', entity: 'clients', entity_id: 'client_1-A',
  occurred_at: '2026-10-28T12:00:00.000Z', correlation_id: 'trace', schema_version: 1, changes: {}, ...extra })
beforeEach(reset)
it('stores four fixed keys with redacted event JSON and filter metadata; deduplicates by event_id', async () => {
  const sink = new KvAuditSink(env.AUDIT_KV); const original = event()
  await sink.insert(original); await sink.insert(original)
  // A repeated id retains its canonical payload and original index positions.
  await sink.insert(event({ entity: 'jobs', entity_id: 'changed', occurred_at: '2026-10-29T00:00:00.000Z' }))
  const page = await env.AUDIT_KV.list<AuditMetadata>()
  expect(page.keys.map(key => key.name)).toEqual([
    'org/org-a/i/sample/all/20261028120000000/event-A_1',
    'org/org-a/i/sample/e/clients/client_1-A/20261028120000000/event-A_1',
    'org/org-a/i/sample/id/event-A_1',
    'org/org-a/i/sample/t/clients/20261028120000000/event-A_1',
  ])
  for (const key of page.keys) {
    expect(key.metadata).toEqual({ occurred_at: original.occurred_at, event_id: original.event_id, entity: 'clients', entity_id: 'client_1-A' })
    expect(await env.AUDIT_KV.get(key.name, 'json')).toEqual(original)
  }
})
it('orders ascending by occurred_at then event_id, preserving ASCII identifier ordering', async () => {
  const sink = new KvAuditSink(env.AUDIT_KV)
  const ids = ['z', 'a', '_', 'Z', 'A', '0', '-']
  for (const id of ids) await sink.insert(event({ event_id: id }))
  await sink.insert(event({ event_id: 'older', occurred_at: '2026-10-27T23:59:59.999Z' }))
  const keys = (await env.AUDIT_KV.list({ prefix: 'org/org-a/i/sample/all/' })).keys
  expect(keys.map(key => key.name.split('/').at(-1))).toEqual(['older', ...ids.sort()])
})
it('escapes slash and percent in every component without tenant prefix collisions', async () => {
  const sink = new KvAuditSink(env.AUDIT_KV)
  await sink.insert(event({ organization_id: 'org-a/i/other', entity_id: 'a/b%2Fc', event_id: 'id/slash' }))
  expect((await env.AUDIT_KV.list({ prefix: auditPrefix('org-a', 'sample') })).keys).toEqual([])
  const keys = (await env.AUDIT_KV.list()).keys.map(key => key.name)
  expect(keys).toContain('org/org-a%2Fi%2Fother/i/sample/e/clients/a%2Fb%252Fc/20261028120000000/id%2Fslash')
})
it.each(['e', 't'])('repairs indexes after a partial %s write, without rewriting already stored keys', async index => {
  const puts: string[] = []; let fail = true
  const kv = new Proxy(env.AUDIT_KV, { get(target, property) {
    if (property === 'put') return async (key: string, value: string, options: KVNamespacePutOptions) => {
      puts.push(key)
      if (key.includes(`/${index}/`) && fail) { fail = false; throw new Error('temporary KV failure') }
      return target.put(key, value, options)
    }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const sink = new KvAuditSink(kv)
  await expect(sink.insert(event())).rejects.toThrow('temporary KV failure')
  await sink.insert(event()); await sink.insert(event())
  expect((await env.AUDIT_KV.list()).keys).toHaveLength(4)
  expect(puts.filter(key => key.includes('/all/'))).toHaveLength(1)
  expect(puts.filter(key => key.includes('/id/'))).toHaveLength(1)
  expect(puts.filter(key => key.includes('/t/'))).toHaveLength(index === 't' ? 2 : 1)
})
it('rejects an invalid timestamp or oversized key before writing anything', async () => {
  const sink = new KvAuditSink(env.AUDIT_KV)
  await expect(sink.insert(event({ occurred_at: 'bad' }))).rejects.toThrow('invalid_audit_timestamp')
  await expect(sink.insert(event({ entity_id: 'x'.repeat(512) }))).rejects.toThrow('audit_key_too_long')
  expect((await env.AUDIT_KV.list()).keys).toEqual([])
})
it('requires a KV binding and no audit SQL database', async () => {
  await expect(audit().checkEnvironment!({ DB: env.DB })).rejects.toThrow('audit_kv_required')
  await expect(audit().checkEnvironment!({ DB: env.DB, AUDIT_KV: env.AUDIT_KV })).resolves.toBeUndefined()
})
it.each([
  [undefined, undefined], ['2026-10-28T12:34:56.789Z', undefined], [undefined, '2026-10-28T12:34:56.789Z'],
  ['2026-10-28T12:34:56.789Z', '2026-10-28T12:34:56.789Z'],
  ['2025-12-31T23:59:59.998Z', '2026-01-01T00:00:00.001Z'],
])('covers the exact inclusive range with ordered disjoint key prefixes (%s, %s)', (from, to) => {
  let next = BigInt(from ? timeKey(from) : '00000000000000000')
  const end = BigInt(to ? timeKey(to) : '99999999999999999')
  const prefixes = timePrefixes(from, to)
  expect(prefixes.length).toBeLessThanOrEqual(306)
  for (const prefix of prefixes) {
    const lower = BigInt(prefix.padEnd(17, '0')); const upper = BigInt(prefix.padEnd(17, '9'))
    expect(lower).toBe(next); expect(upper <= end).toBe(true)
    next = upper + 1n
  }
  expect(next).toBe(end + 1n)
  expect(sortKey('2026-10-28T00:00:00.000Z', 'a')).toBe('20261028000000000/a')
})
it('returns no ranges when from exceeds to', () => {
  expect(timePrefixes('2026-10-29T00:00:00.000Z', '2026-10-28T00:00:00.000Z')).toEqual([])
})
