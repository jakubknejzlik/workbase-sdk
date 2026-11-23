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
  const fetch = vi.fn(async (_url: string, _init: ClientRequestInit) => response({ id: 'x', version: 1, actions: {} }))
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
  pending[1](response({ id: 'x', name: 'B', version: 2, actions: {} })); await second
  pending[0](response({ id: 'x', name: 'A', version: 1 })); expect((await first).name).toBe('AbortError')
  expect(await client.one('test', { id: 'x' }, signal())).toMatchObject({ name: 'B' })
})
test('mutation uses draft idempotency and quoted If-Match; conflicts refresh the owner', async () => {
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => init.method === 'PATCH' ? response({ error: 'version_conflict' }, 409) : response({ id: 'x', name: 'A', version: 1, actions: {} }))
  const client = createClient({ baseURL: '', actorId: 'a', orgId: 'one', fetch })
  await client.create('test', { name: 'A' }, 'draft-key', signal())
  expect(new Headers(fetch.mock.calls[0][1].headers).get('Idempotency-Key')).toBe('draft-key')
  await expect(client.update('test', 'x', 1, { name: 'B' }, signal())).rejects.toMatchObject({ status: 409, code: 'version_conflict' })
  expect(new Headers(fetch.mock.calls[1][1].headers).get('If-Match')).toBe('"1"')
  expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'PATCH', 'GET'])
  expect(await client.one('test', { id: 'x' }, signal())).toMatchObject({ name: 'A' })
})
test('successful mutation returns its bare row, invalidates other entries and supersedes in-flight reads', async () => {
  let delayed: (value: Response) => void = () => {}
  const fetch = vi.fn(async (url: string, init: ClientRequestInit) => init.method === 'PATCH' ? response({ id: 'x', name: 'saved', version: 2 }) : url.endsWith('/slow') ? new Promise<Response>(resolve => { delayed = resolve }) : response({ id: url.endsWith('/x') ? 'x' : 'y', name: 'fresh GET', version: 2, actions: {} }))
  const client = createClient({ baseURL: '', orgId: 'o', actorId: 'a', fetch })
  await client.one('test', { id: 'y' }, signal())
  const pending = client.one('test', { id: 'slow' }, signal()).catch(e => e)
  expect(await client.update('test', 'x', 1, { name: 'saved' }, signal())).toEqual({ id: 'x', name: 'saved', version: 2 })
  delayed(response({ id: 'slow', version: 1 })); expect((await pending).name).toBe('AbortError')
  expect(await client.one('test', { id: 'x' }, signal())).toMatchObject({ name: 'fresh GET', actions: {} })
  await client.one('test', { id: 'y' }, signal())
  expect(fetch).toHaveBeenCalledTimes(5)
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
test('authorization failures notify even for non-JSON bodies, but an aborted old scope cannot notify', async () => {
  const onAuthorizationFailure = vi.fn(), abort = new AbortController()
  let release: (response: Response) => void = () => {}
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch, onAuthorizationFailure })
  const old = client.one('test', { id: 'old' }, abort.signal).catch(error => error)
  abort.abort(); release(new Response('expired', { status: 401 })); await old
  expect(onAuthorizationFailure).not.toHaveBeenCalled()
  const current = client.one('test', { id: 'current' }, signal()).catch(error => error)
  release(new Response('denied', { status: 403 })); await current
  expect(onAuthorizationFailure).toHaveBeenCalledWith(403)
})
test('list projection excludes unreadable fields, sorts and searches even when forged into bindings', async () => {
  const fetch = vi.fn(async (_url: string, _init: ClientRequestInit) => response({ data: [], next_cursor: null }))
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch })
  await client.list('test', meta, ['id', 'extra']).load({ sort: 'user', search: 'secret' }, signal())
  const body = JSON.parse(String(fetch.mock.calls[0][1].body))
  expect(body.select).toEqual(['id', 'extra']); expect(body.orderBy).toEqual([{ field: 'id', dir: 'asc' }]); expect(body.search).toBeUndefined()
})
test('native-style transport receives no client-options receiver', async () => {
  const fetch = async function(this: unknown, _url: string, _init: ClientRequestInit) {
    expect(this).toBeUndefined()
    return response({ id: 'x', version: 1 })
  }
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch })
  await client.one('test', { id: 'x' }, signal())
})
test.each(['create', 'update'] as const)('bare %s remains a result but never establishes detail freshness', async kind => {
  const bare = { id: 'x', version: 1 }, detail = { ...bare, actions: {} }
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => response(init.method === 'GET' ? detail : bare))
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch })
  const result = kind === 'create' ? await client.create('test', {}, 'draft', signal()) : await client.update('test', 'x', 1, {}, signal())
  expect(result).toEqual(bare)
  expect(await client.one('test', { id: 'x' }, signal())).toEqual(detail)
  await client.one('test', { id: 'x' }, signal(), true)
  expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual([kind === 'create' ? 'POST' : 'PATCH', 'GET'])
})
test.each([undefined, null, [], 'invalid', { close: {} }, { close: { enabled: 'yes' } }])('invalid/missing metadata %j is never a loaded-empty detail', async actions => {
  const fetch = vi.fn(async () => response({ id: 'x', version: 1, ...(actions === undefined ? {} : { actions }) }))
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch })
  await client.one('test', { id: 'x' }, signal(), true)
  await client.one('test', { id: 'x' }, signal(), true)
  expect(fetch).toHaveBeenCalledTimes(2)
})
test.each([
  { id: 'other', version: 8 }, {},
  { id: 'x', version: 1, actions: { close: { enabled: true } } },
])('action result %j always refreshes explicit owner and never caches credentials', async shape => {
  const result = { ...shape, accept_url: 'https://example.test/synthetic' }, record = { id: 'x', version: 2, actions: {} }
  const fetch = vi.fn(async (url: string, init: ClientRequestInit) => response(url === '/query' ? { data: [record], next_cursor: null } : init.method === 'GET' ? record : result))
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch })
  expect(await client.actWith('test', 'x', 'invite', {}, signal())).toEqual({ result, record })
  expect(await client.one('test', { id: 'x' }, signal(), true)).toEqual(record)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/test/x/actions/invite', '/api/test/x'])
  const list = client.list('test', meta)
  expect(await list.load({}, signal())).toEqual({ data: [record], next_cursor: null })
  expect(await list.load({}, signal())).toEqual({ data: [record], next_cursor: null })
  expect(fetch.mock.calls.at(-1)![0]).toBe('/query')
  expect(fetch).toHaveBeenCalledTimes(3)
})
test.each(['update', 'act'].flatMap(kind => [409, 403, 404, 0].map(status => [kind, status] as const)))('%s refusal/uncertain outcome (%s) revokes availability, notifies and preserves the error if refresh fails', async (kind, status) => {
  const original = { id: 'x', version: 1, actions: { close: { enabled: true } } }
  const fetch = vi.fn().mockResolvedValueOnce(response(original))
  if (status) fetch.mockResolvedValueOnce(response({ error: 'original', reason: 'record.closed' }, status))
  else fetch.mockRejectedValueOnce(new TypeError('offline'))
  fetch.mockResolvedValueOnce(response({ error: 'refresh_failure' }, 503)).mockResolvedValueOnce(response({ ...original, version: 2, actions: {} }))
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch }), listener = vi.fn()
  await client.one('test', { id: 'x' }, signal(), true)
  client.subscribe(listener)
  await expect(kind === 'update' ? client.update('test', 'x', 1, {}, signal()) : client.act('test', 'x', 'close', signal())).rejects.toMatchObject({ status, code: status ? 'original' : 'network', ...(status ? { reason: 'record.closed' } : {}) })
  expect(listener).toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(await client.one('test', { id: 'x' }, signal(), true)).toMatchObject({ version: 2, actions: {} })
  expect(fetch).toHaveBeenCalledTimes(4)
})
test('late action refresh and older un-aborted reads cannot replace newer mutation/detail state', async () => {
  const pending: ((value: Response) => void)[] = []
  let version = 1
  const fetch = vi.fn(async (_url: string, init: ClientRequestInit) => {
    if (init.method === 'POST') return response({ ok: true })
    if (init.method === 'PATCH') { version = 3; return response({ id: 'x', version }) }
    if (version === 1) return new Promise<Response>(resolve => pending.push(resolve))
    return response({ id: 'x', version, actions: {} })
  })
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch })
  const older = client.one('test', { id: 'x' }, signal(), true).catch(e => e)
  const action = client.act('test', 'x', 'close', signal()).catch(e => e)
  await vi.waitFor(() => expect(pending).toHaveLength(2))
  await client.update('test', 'x', 2, {}, signal())
  const fresh = await client.one('test', { id: 'x' }, signal(), true)
  pending[1](response({ id: 'x', version: 2, actions: { close: { enabled: true } } }))
  pending[0](response({ id: 'x', version: 1, actions: { close: { enabled: true } } }))
  expect((await action).name).toBe('AbortError'); expect((await older).name).toBe('AbortError')
  expect(await client.one('test', { id: 'x' }, signal(), true)).toEqual(fresh)
  expect(fresh.version).toBe(3)
})
test('local version validation does not request or invalidate cached detail', async () => {
  const fetch = vi.fn(async () => response({ id: 'x', version: 1, actions: { close: { enabled: true } } }))
  const client = createClient({ baseURL: '', orgId: 'one', actorId: 'a', fetch }), listener = vi.fn()
  const initial = await client.one('test', { id: 'x' }, signal(), true)
  client.subscribe(listener)
  expect(() => client.update('test', 'x', 0, {}, signal())).toThrow('version_required')
  expect(await client.one('test', { id: 'x' }, signal(), true)).toEqual(initial)
  expect(fetch).toHaveBeenCalledTimes(1); expect(listener).not.toHaveBeenCalled()
})
