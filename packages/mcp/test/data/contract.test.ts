import { afterEach, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../src/data/server.ts'
import { loadEnvironment } from '../../src/data/client.ts'
import { publicSchema } from '../../../core/src/public-schema.ts'
import { sample } from '../fixtures/model'
const token = 'wb_' + 'a'.repeat(64)
const env = { WORKBASE_BASE_URL: 'http://127.0.0.1:8997', WORKBASE_TOKEN: token, WORKBASE_ORG_ID: 'test-org' }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map(close => close())) })
async function connect(request = vi.fn<typeof fetch>(), extra = {}) {
  const server = createServer({ ...env, ...extra }, request)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'contract', version: '1' })
  cleanup.push(() => client.close(), () => server.close())
  await server.connect(b); await client.connect(a)
  const call = async (name: string, args: any = {}) => client.callTool({ name, arguments: args })
  return { client, call, request }
}
test('C1 non-object arguments and unknown tool names return structured errors', async () => {
  const { call, request } = await connect()
  for (const args of [null, [], 'invalid', 12]) expect((await call('whoami', args)).structuredContent).toEqual({ ok: false, code: 'validation_error', status: 400 })
  expect((await call('__proto__')).structuredContent).toEqual({ ok: false, code: 'unknown_tool', status: 404 })
  expect(request).not.toHaveBeenCalled()
})
test('C2 HTTP authentication org selector typed filters version and idempotency envelopes', async () => {
  const { call, request } = await connect(vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: 'test', version: 2 })))
  await call('list_records', { entity: 'slots', limit: 5, cursor: 'abc', filters: { 'capacity[gte]': 2, starts_at: '2026-10-23T00:00:00.000Z' } })
  const [url, init] = request.mock.calls[0]
  expect(String(url)).toContain('capacity%5Bgte%5D=2'); expect(String(url)).toContain('limit=5')
  expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'X-Organization-Id': 'test-org' })
  expect(init?.redirect).toBe('error')
  await call('update_record', { entity: 'clients', id: 'test', data: { name: 'Updated' }, version: 4 })
  expect(request.mock.calls[1][1]?.headers).toMatchObject({ 'If-Match': '4' })
  expect(request.mock.calls[1][1]?.body).toBe('{"name":"Updated"}')
  await call('create_record', { entity: 'clients', data: { name: 'Created' }, idempotencyKey: 'create-key' })
  expect(request.mock.calls[2][1]?.headers).toMatchObject({ 'Idempotency-Key': 'create-key' })
})
test('C3 API error codes are surfaced verbatim without hints stack traces or credentials', async () => {
  const { call } = await connect(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'permission_denied', hint: token, stack: 'sensitive stack' }, { status: 403 })))
  const result = await call('delete_record', { entity: 'clients', id: 'x' })
  expect(result.structuredContent).toEqual({ ok: false, code: 'permission_denied', status: 403 }); expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain('stack')
})
test('C4 token is redacted even when an API value or error code reflects it', async () => {
  const request = vi.fn<typeof fetch>().mockImplementationOnce(async () => Response.json({ reflected: token })).mockImplementationOnce(async () => Response.json({ error: token }, { status: 400 }))
  const { call } = await connect(request)
  for (let i = 0; i < 2; i++) expect(JSON.stringify(await call('whoami'))).not.toContain(token)
})
test('C5 transport exceptions invalid JSON and non-object responses become fixed structured failures', async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(token)).mockResolvedValueOnce(new Response('bad')).mockResolvedValueOnce(Response.json([token]))
  const { call } = await connect(request)
  for (const code of ['transport_error', 'invalid_response', 'invalid_response']) expect((await call('whoami')).structuredContent).toEqual({ ok: false, code, status: 502 })
})
test('C6 registered workflow check never posts to owner cancel or resume endpoints', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ workflows: [] }))
  const { call } = await connect(request)
  for (const name of ['fake/cancel', 'fake/resume']) expect((await call('start_workflow', { name, input: {} })).structuredContent).toEqual({ ok: false, code: 'workflow_not_found', status: 404 })
  expect(request.mock.calls.every(([path, init]) => String(path).endsWith('/schema') && init?.method === 'GET')).toBe(true)
})
test('C7 reserved filters nested idempotency and version overrides are rejected before HTTP', async () => {
  const { call, request } = await connect()
  for (const [name, args] of [
    ['list_records', { entity: 'clients', filters: { limit: 1000 } }],
    ['run_command', { name: 'jobs/transition', input: { idempotencyKey: 'hidden' } }],
    ['update_record', { entity: 'clients', id: 'x', data: { version: 8 }, version: 1 }],
    ['get_record', { entity: 'clients', id: '../orgs' }],
  ] as const) expect((await call(name, args)).structuredContent).toEqual({ ok: false, code: 'validation_error', status: 400 })
  expect(request).not.toHaveBeenCalled()
})
test('C8 environment rejects missing credentials unsafe URLs headers and malformed read-only without values', () => {
  for (const invalid of [{ WORKBASE_TOKEN: '' }, { WORKBASE_BASE_URL: 'https://user:secret@example.test' }, { WORKBASE_BASE_URL: 'http://example.test' }, { WORKBASE_BASE_URL: 'file:///tmp/api' }, { WORKBASE_ORG_ID: 'bad\r\nheader' }, { WORKBASE_READ_ONLY: 'TRUE' }]) {
    try { loadEnvironment({ ...env, ...invalid }); expect.fail('Expected invalid environment') } catch (error) { expect(String(error)).toBe('Error: Workbase request failed') }
  }
})
test('C9 describe_schema accepts the safe public projection and preserves the discovery contract', async () => {
  const schema = publicSchema(sample, {})
  const health = { instance: sample.id, revision: sample.revision, schema: { compatible: true } }
  const request = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).endsWith('/schema') ? schema : health))
  const { call } = await connect(request)
  const result = await call('describe_schema')
  expect(result.isError).toBe(false)
  expect(result.structuredContent).toEqual({ ok: true, data: { health, schema } })
  expect(schema.entities.clients.fields.email).toEqual({ type: 'string', required: false, sensitive: true })
  expect(request.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual(['/health', '/schema'])
})

test('Q2 query forwards malformed documents and preserves the HTTP error path/cost envelope', async () => {
  const envelope = { error: 'query_too_expensive', path: ['include', 'client'], cost: { depth: 3, relations: 2, fieldRows: 100001, exists: 0, nodes: 5 } }
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(envelope, { status: 400 }))
  const { call } = await connect(request)
  for (const args of [null, [], { entity: 'clients', limit: 100001 }, { unknown: 'PRIVATE_CANARY' }, { entity: '\ud800', limit: 1 }, { entity: {}, limit: 1 }]) {
    const result = await call('query', args)
    expect(result.structuredContent).toEqual(envelope); expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(envelope) }])
  }
  expect(request.mock.calls.every(([url, init]) => String(url).endsWith('/query') && init?.method === 'POST')).toBe(true)
  expect(request.mock.calls[0][1]?.body).toBe('null')
})
test('Q3 query success keeps HTTP values byte-identical and uses only the configured Bearer/org transport', async () => {
  const envelope = { data: [{ id: 'literal', name: token }], next_cursor: null }
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope))
  const { call } = await connect(request, { WORKBASE_READ_ONLY: 'true' })
  const result = await call('query', { entity: 'clients', limit: 100, include: { jobs: { limit: 20 } } })
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(envelope) }]); expect(result.isError).toBe(false)
  expect(request.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'X-Organization-Id': 'test-org' })
})

test('SR-34 describe_schema preserves both pure join endpoint and mutation declarations', async () => {
  const { joinConfig, joinCommands } = await import('../fixtures/joins')
  const schema = publicSchema(joinConfig, { commands: joinCommands })
  const request = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).endsWith('/schema') ? schema : { instance: 'joins' }))
  const { call } = await connect(request)
  const result = await call('describe_schema')
  expect(result.structuredContent).toMatchObject({ ok: true, data: { schema: { query: { entities: {
    people: { relations: { teams: { entity: 'enrollments', cardinality: '1:n', through: { entity: 'teams', field: 'team_id', createCommand: 'enrollments/create', deleteCommand: 'enrollments/delete' } } } },
    teams: { relations: { people: { through: { entity: 'people', field: 'person_id' } } } },
  } } } } })
})

test('176 row invitation tools preserve row target, forward permissions and never return acceptance credentials', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'invite', role: 'member', accept_url: 'https://example.test/secret' }))
  const { call } = await connect(request)
  expect((await call('invite_from_row', { entity: 'people', id: 'person', email: 'recipient@example.test' })).structuredContent).toEqual({ ok: true, data: { id: 'invite', role: 'member' } })
  expect(request.mock.calls[0][0]).toBe('http://127.0.0.1:8997/orgs/test-org/invitations')
  expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ email: 'recipient@example.test', target: { entity: 'people', row: 'person' } })
  await call('row_access', { entity: 'people', id: 'person' })
  await call('resend_row_invitation', { id: 'invite' })
  await call('cancel_row_invitation', { id: 'invite' })
  expect(request.mock.calls.slice(1).map(([url, init]) => [url, init?.method])).toEqual([
    ['http://127.0.0.1:8997/orgs/test-org/row-access/people/person', 'GET'],
    ['http://127.0.0.1:8997/orgs/test-org/invitations/invite/resend', 'POST'],
    ['http://127.0.0.1:8997/orgs/test-org/invitations/invite', 'DELETE'],
  ])
  const readonly = await connect(request, { WORKBASE_READ_ONLY: 'true' })
  for (const name of ['invite_from_row', 'resend_row_invitation', 'cancel_row_invitation']) {
    expect((await readonly.call(name, {})).structuredContent).toEqual({ ok: false, code: 'read_only', status: 403 })
    expect((await readonly.client.listTools()).tools.some(tool => tool.name === name)).toBe(false)
  }
})
