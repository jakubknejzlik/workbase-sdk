import { expect, test, vi } from 'vitest'
import { createClient, diff, ApiFailure, cacheKey, type ClientRequestInit, type EntityMeta } from '../src/client'
const meta: EntityMeta = { displayField: 'name', fields: {
  name: { type: 'string', required: true, readOnly: false, computed: false, userLink: false },
  extra: { type: 'text', required: false, readOnly: false, computed: false, userLink: false },
  user: { type: 'ref', required: false, readOnly: false, computed: false, userLink: true, ref: 'users' },
} }
const signal = () => new AbortController().signal
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
test('diff trims, clears optional fields, blocks required empties, and excludes protected/unplaced keys', () => {
  expect(diff(meta, ['name', { kind: 'section', children: ['extra', 'user'] }], { name: 'A', extra: 'set' }, { name: ' A ', extra: '', user: 'forged', unknown: 1 })).toEqual({ extra: null })
  expect(() => diff(meta, ['name'], {}, { name: '  ' })).toThrow(ApiFailure)
  expect(diff(meta, ['extra'], {}, {})).toEqual({})
  for (const flag of ['readOnly', 'computed', 'userLink']) expect(diff({ ...meta, fields: { name: { ...meta.fields.name, [flag]: true } } }, ['name'], { name: 'A' }, { name: 'B' })).toEqual({})
})
test.each(['string', 'text'])('diff retains free-text trimming for %s', type => {
  const metadata = { ...meta, fields: { value: { ...meta.fields.extra, type } } }
  expect(diff(metadata, ['value'], {}, { value: ' padded ' })).toEqual({ value: 'padded' })
})
test('an unchanged padded enum literal produces no PATCH entry', () => {
  const metadata = { ...meta, fields: { status: { ...meta.fields.extra, type: 'enum', values: ['open', ' closed '] } } }
  const initial = { status: ' closed ' }
  expect(diff(metadata, ['status'], initial, { ...initial })).toEqual({})
})
test.each([
  ['enum', ' closed '], ['enum', '   '], ['ref', ' record-id '],
  ['datetime', ' 2026-11-13T00:00:00Z '], ['bool', false], ['int', 3], ['float', 1.5],
  ['bool', ' false '], ['int', ' 3 '], ['float', ' 1.5 '],
])('diff preserves exact %s value %j and omits it when unchanged', (type, value) => {
  const metadata = { ...meta, fields: { value: { ...meta.fields.extra, type: String(type), values: ['open', ' closed ', '   '] } } }
  expect(diff(metadata, ['value'], {}, { value })).toEqual({ value })
  expect(diff(metadata, ['value'], { value }, { value })).toEqual({})
})
test('canonical cache keys and scoped client instances', async () => {
  expect(cacheKey('list', 'test', { b: 1, a: 2 })).toBe(cacheKey('list', 'test', { a: 2, b: 1 }))
  const fetch = vi.fn(async (_url: string, _init: ClientRequestInit) => response({ id: 'x', version: 1 }))
  const a = createClient({ baseURL: '', actorId: 'a', orgId: 'one', fetch })
  await a.one('test', { id: 'x' }, signal()); await a.one('test', { id: 'x' }, signal())
  const b = createClient({ baseURL: '', actorId: 'a', orgId: 'two', fetch })
  await b.one('test', { id: 'x' }, signal())
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(new Headers(fetch.mock.calls[1][1]?.headers).get('X-Organization-Id')).toBe('two')
})
test('same-origin wire, bounded query, exact reserved binds, cursor resets', async () => {
  const fetch = vi.fn(async (_url: string, _init: ClientRequestInit) => response({ data: [], next_cursor: 'opaque' }))
  const client = createClient({ baseURL: '/service/', actorId: 'a', orgId: 'one', fetch })
  const list = client.list('test', meta)
  await list.load({ search: 'A', sort: 'name', dir: 'desc' }, signal())
  await list.more(signal())
  await list.load({ search: 'B', sort: 'name', dir: 'asc' }, signal())
  const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)))
  expect(bodies[0]).toMatchObject({ entity: 'test', limit: 25, search: { text: 'A', fields: ['name'] }, orderBy: [{ field: 'name', dir: 'desc' }] })
  expect(bodies[1].cursor).toBe('opaque'); expect(bodies[2].cursor).toBeUndefined()
  expect(fetch.mock.calls[0][0]).toBe('/service/query')
  expect(fetch.mock.calls.every(([, init]) => init.credentials === 'same-origin' && !new Headers(init.headers).has('Authorization'))).toBe(true)
  await expect(list.load({ other: 'bad' } as any, signal())).rejects.toMatchObject({ code: 'manifest_error' })
})
test('aborted late response cannot overwrite a newer response or mutation', async () => {
  const pending: ((r: Response) => void)[] = []
  const fetch = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
  const client = createClient({ baseURL: '', actorId: 'a', orgId: 'one', fetch })
  const a = new AbortController(), first = client.one('test', { id: 'x' }, a.signal).catch(e => e)
  a.abort()
  const second = client.one('test', { id: 'x' }, signal())
  pending[1](response({ id: 'x', name: 'B', version: 2 })); await second
  pending[0](response({ id: 'x', name: 'A', version: 1 })); expect((await first).name).toBe('AbortError')
  expect(await client.one('test', { id: 'x' }, signal())).toMatchObject({ name: 'B' })
})
test('mutation uses draft idempotency and quoted If-Match; conflicts preserve detail cache', async () => {
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => init.method === 'PATCH' ? response({ error: 'version_conflict' }, 409) : response({ id: 'x', name: 'A', version: 1 }))
  const client = createClient({ baseURL: '', actorId: 'a', orgId: 'one', fetch })
  await client.create('test', { name: 'A' }, 'draft-key', signal())
  expect(new Headers(fetch.mock.calls[0][1].headers).get('Idempotency-Key')).toBe('draft-key')
  await expect(client.update('test', 'x', 1, { name: 'B' }, signal())).rejects.toMatchObject({ status: 409, code: 'version_conflict' })
  expect(new Headers(fetch.mock.calls[1][1].headers).get('If-Match')).toBe('"1"')
  expect(await client.one('test', { id: 'x' }, signal())).toMatchObject({ name: 'A' })
})
test('successful mutation seeds detail, invalidates other entries and supersedes in-flight reads', async () => {
  let delayed: (value: Response) => void = () => {}
  const fetch = vi.fn(async (url: string, init: ClientRequestInit) => init.method === 'PATCH' ? response({ id: 'x', name: 'saved', version: 2 }) : url.endsWith('/slow') ? new Promise<Response>(resolve => { delayed = resolve }) : response({ id: 'y', name: 'old', version: 1 }))
  const client = createClient({ baseURL: '', orgId: 'o', actorId: 'a', fetch })
  await client.one('test', { id: 'y' }, signal())
  const pending = client.one('test', { id: 'slow' }, signal()).catch(e => e)
  await client.update('test', 'x', 1, { name: 'saved' }, signal())
  delayed(response({ id: 'slow', version: 1 })); expect((await pending).name).toBe('AbortError')
  expect(await client.one('test', { id: 'x' }, signal())).toMatchObject({ name: 'saved' })
  await client.one('test', { id: 'y' }, signal())
  expect(fetch).toHaveBeenCalledTimes(4)
})

test('act writes a returned detail into cache and failure surfaces reason without overwriting detail', async () => {
  const initial = { id: 'x', version: 1, actions: { close: { enabled: true } } }
  const updated = { id: 'x', version: 2, actions: { close: { enabled: false, reason: 'record.closed' } } }
  const fetch = vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(updated)).mockResolvedValueOnce(response({ error: 'action_unavailable', reason: 'record.closed' }, 409))
  const client = createClient({ baseURL: '', actorId: 'a', orgId: 'one', fetch })
  await client.one('record', { id: 'x' }, signal())
  expect(await client.act('record', 'x', 'close', signal())).toEqual(updated)
  expect(await client.one('record', { id: 'x' }, signal())).toEqual(updated)
  await expect(client.act('record', 'x', 'close', signal())).rejects.toMatchObject({ status: 409, code: 'action_unavailable', reason: 'record.closed' })
  expect(await client.one('record', { id: 'x' }, signal())).toEqual(updated)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(fetch.mock.calls[1][0]).toBe('/api/record/x/actions/close')
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' })
})
test('act refetches detail after a command response without a returned row', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ id: 'x', version: 2, actions: {} }))
  const client = createClient({ baseURL: '', actorId: 'a', orgId: 'one', fetch })
  expect(await client.act('record', 'x', 'close', signal())).toMatchObject({ id: 'x', version: 2 })
  expect(await client.one('record', { id: 'x' }, signal())).toMatchObject({ version: 2 })
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/record/x/actions/close', '/api/record/x'])
})
test('actWith returns the command result and fresh detail, without caching the invitation credential', async () => {
  const result = { invitation_id: 'inv', expires_at: '2099', accept_url: 'https://example.test/invitations/accept?token=synthetic' }
  const record = { id: 'x', version: 1, access: { state: 'invited' }, actions: {} }
  const fetch = vi.fn().mockResolvedValueOnce(response(result)).mockResolvedValueOnce(response(record))
  const client = createClient({ baseURL: '', actorId: 'a', orgId: 'one', fetch })
  expect(await client.actWith('worker', 'x', 'invite', { email: 'a@example.test' }, signal())).toEqual({ record, result })
  expect(fetch.mock.calls[0][1].body).toBe('{"email":"a@example.test"}')
  expect(await client.one('worker', { id: 'x' }, signal())).toEqual(record)
  expect(JSON.stringify(await client.one('worker', { id: 'x' }, signal()))).not.toContain('accept_url')
  expect(fetch).toHaveBeenCalledTimes(2)
})
