import { afterEach, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../src/ops/server.ts'
import { loadEnvironment } from '../../src/ops/client.ts'
import { createServer as createDataServer } from '../../src/data/server.ts'
import { schemas as dataSchemas } from '../../src/data/schemas.ts'
import { schemas as configSchemas } from '../../src/schemas.ts'

const token = 'synthetic-ops-secret'
const mailboxToken = 'synthetic-mailbox-secret-at-least-32-characters'
const env = { WORKBASE_BASE_URL: 'http://127.0.0.1:8997', WORKBASE_OPS_TOKEN: token }
const mailboxEnv = { WORKBASE_DEV_MAILBOX_URL: 'http://localhost:8998', WORKBASE_DEV_MAILBOX_TOKEN: mailboxToken }
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map(close => close())) })
async function link(server: ReturnType<typeof createServer>) {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'ops-contract', version: '1' })
  cleanup.push(() => client.close(), () => server.close())
  await server.connect(b); await client.connect(a)
  return { client, call: (name: string, args: any = {}) => client.callTool({ name, arguments: args }) }
}
async function connect(request = vi.fn<typeof fetch>(), extra: NodeJS.ProcessEnv = {}) {
  return { ...await link(createServer({ ...env, ...extra }, request)), request }
}

test('lists read_dev_mail only with both mailbox environment variables; hidden calls fail closed', async () => {
  const { client, call, request } = await connect()
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['provision_organization', 'bootstrap_instance_owner'])
  expect((await call('read_dev_mail', { recipient: 'a@example.test' })).structuredContent)
    .toEqual({ ok: false, code: 'unknown_tool', status: 404 })
  expect(request).not.toHaveBeenCalled()
  const enabled = await connect(undefined, mailboxEnv)
  const tools = (await enabled.client.listTools()).tools
  expect(tools.map(tool => tool.name)).toEqual(['provision_organization', 'bootstrap_instance_owner', 'read_dev_mail'])
  expect(tools.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true)
  expect(tools.map(tool => tool.annotations?.readOnlyHint)).toEqual([false, false, true])
  expect(tools[2].description).toContain('credential')
  expect(Object.keys(tools[2].inputSchema.properties!)).toEqual(['recipient', 'limit'])
  for (const { name } of tools) {
    expect(Object.hasOwn(dataSchemas, name)).toBe(false)
    expect(Object.hasOwn(configSchemas, name)).toBe(false)
  }
})

test('provision forwards only name and ownerEmail using the dedicated internal token', async () => {
  const data = { id: 'org', name: 'First org', role: 'owner', replayed: false }
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(data, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ ...data, replayed: true }))
  const { call } = await connect(request, { WORKBASE_TOKEN: 'data-secret', WORKBASE_ORG_ID: 'unrelated-org' })
  for (const replayed of [false, true]) {
    expect((await call('provision_organization', { name: ' First org ', ownerEmail: ' first@example.test ' })).structuredContent)
      .toEqual({ ok: true, data: { ...data, replayed } })
  }
  expect(request.mock.calls[0][0]).toBe(`${env.WORKBASE_BASE_URL}/internal/organizations`)
  const init = request.mock.calls[0][1]!
  expect(init.method).toBe('POST'); expect(init.redirect).toBe('error')
  expect(init.headers).toEqual({ 'X-Internal-Token': token, 'Content-Type': 'application/json' })
  expect(JSON.parse(init.body as string)).toEqual({ name: 'First org', ownerEmail: 'first@example.test' })
  expect(init.signal).toBeInstanceOf(AbortSignal)
})

test('mail uses the merged sidecar GET /messages contract, bearer token and 1–50 limit', async () => {
  const data = { messages: [{ id: 'mail', recipient: 'first+ops@example.test', subject: 'Workbase sign-in',
    body: 'http://localhost/auth/magic-link/verify?token=synthetic-link', created_at: '2026-11-14T00:00:00Z', expires_at: null }] }
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(data))
  const { call } = await connect(request, mailboxEnv)
  for (const limit of [undefined, 1, 50]) {
    expect((await call('read_dev_mail', { recipient: 'first+ops@example.test', ...(limit ? { limit } : {}) })).structuredContent)
      .toEqual({ ok: true, data })
    const [url, init] = request.mock.calls.at(-1)!
    expect(url).toBe(`${mailboxEnv.WORKBASE_DEV_MAILBOX_URL}/messages?recipient=first%2Bops%40example.test&limit=${limit ?? 20}`)
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${mailboxToken}` } })
    expect(init?.headers).not.toHaveProperty('X-Internal-Token')
    expect(init?.headers).not.toHaveProperty('X-Organization-Id')
    expect(init?.body).toBeUndefined()
  }
  request.mockResolvedValueOnce(Response.json({ messages: [] }))
  expect((await call('read_dev_mail', { recipient: 'missing@example.test' })).structuredContent)
    .toEqual({ ok: true, data: { messages: [] } })
})

test('bootstrap forwards only ownerEmail to the Members internal route with operator auth', async () => {
  const data = { organization_id: 'instance', user_id: 'first', role: 'owner', replayed: false }
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(data, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ ...data, replayed: true }))
  const { call } = await connect(request)
  for (const replayed of [false, true]) expect((await call('bootstrap_instance_owner', { ownerEmail: ' first@example.test ' })).structuredContent)
    .toEqual({ ok: true, data: { ...data, replayed } })
  expect(request.mock.calls[0][0]).toBe(`${env.WORKBASE_BASE_URL}/internal/members/instance-owner`)
  expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error',
    headers: { 'X-Internal-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerEmail: 'first@example.test' }) })
})

test('bootstrap maps fixed denial codes and suppresses arbitrary upstream error text', async () => {
  const request = vi.fn<typeof fetch>()
  const cases = [[409, 'owner_sign_in_required', 'owner_sign_in_required'], [409, 'instance_owner_exists', 'instance_owner_exists'],
    [409, 'membership_conflict', 'membership_conflict'], [409, 'account_already_assigned', 'account_already_assigned'],
    [409, token, 'membership_conflict'], [403, token, 'internal_token_required'], [503, token, 'internal_token_not_configured'],
    [404, token, 'http_error']] as const
  for (const [status, error] of cases) request.mockResolvedValueOnce(Response.json({ error, hint: token }, { status }))
  const { call } = await connect(request)
  for (const [status, , code] of cases) expect((await call('bootstrap_instance_owner', { ownerEmail: 'first@example.test' })).structuredContent)
    .toEqual({ ok: false, code, status })
})

test('rejects malformed arguments and authority overrides before making any request', async () => {
  const { call, request } = await connect(undefined, mailboxEnv)
  for (const [name, args] of [
    ['provision_organization', {}], ['provision_organization', { name: 'Org', ownerEmail: 'invalid' }],
    ['provision_organization', { name: 'Org', ownerEmail: 'a@example.test', role: 'owner' }],
    ['provision_organization', { name: 'Org', ownerEmail: 'a@example.test', token }],
    ['bootstrap_instance_owner', {}], ['bootstrap_instance_owner', { ownerEmail: 'invalid' }],
    ['bootstrap_instance_owner', { ownerEmail: 'a@example.test', role: 'owner' }],
    ['bootstrap_instance_owner', { ownerEmail: 'a@example.test', scope: 'instance' }],
    ['bootstrap_instance_owner', { ownerEmail: 'a@example.test', token }],
    ['bootstrap_instance_owner', { ownerEmail: 'a@example.test', baseUrl: 'https://attacker.test' }],
    ['read_dev_mail', {}], ['read_dev_mail', { recipient: 'a@example.test', limit: 51 }],
    ['read_dev_mail', { recipient: 'a@example.test', baseUrl: 'https://attacker.test' }],
    ['read_dev_mail', { recipient: 'a@example.test', kind: 'sign-in', after: 'yesterday' }],
    ['read_dev_mail', { recipient: 'a@example.test', limit: 0 }], ['read_dev_mail', { recipient: 'a@example.test', limit: 1.5 }],
    ['read_dev_mail', { recipient: `${'a'.repeat(242)}@example.test` }],
    ['read_dev_mail', null], ['read_dev_mail', []], ['read_dev_mail', 'x'],
  ] as const) expect((await call(name, args)).structuredContent).toEqual({ ok: false, code: 'validation_error', status: 400 })
  for (const name of ['__proto__', 'query']) expect((await call(name)).structuredContent).toEqual({ ok: false, code: 'unknown_tool', status: 404 })
  expect(request).not.toHaveBeenCalled()
})

test('maps provisioning denials to fixed codes and never reflects arbitrary upstream errors', async () => {
  const request = vi.fn<typeof fetch>()
  const cases = [
    [409, 'owner_sign_in_required', 'owner_sign_in_required'], [409, 'account_already_assigned', 'account_already_assigned'],
    [403, token, 'internal_token_required'], [503, mailboxToken, 'internal_token_not_configured'],
    [409, 'private SQL', 'owner_sign_in_required'], [418, 'private error', 'http_error'],
  ] as const
  for (const [status, error] of cases) request.mockResolvedValueOnce(Response.json({ error, hint: `${token} ${mailboxToken}`, stack: 'private' }, { status }))
  const { call } = await connect(request, mailboxEnv)
  for (const [status, , code] of cases) {
    const result = await call('provision_organization', { name: 'Org', ownerEmail: 'a@example.test' })
    expect(result.structuredContent).toEqual({ ok: false, code, status })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/synthetic-|private/)
  }
})

test('both tokens are redacted from nested results, text, keys and all error paths', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ messages: [{ body: `${token} ${mailboxToken}`, [token]: { nested: mailboxToken } }] }))
    .mockRejectedValueOnce(new Error(`${token} ${mailboxToken}`))
    .mockResolvedValueOnce(new Response(`${token} ${mailboxToken}`))
    .mockResolvedValueOnce(Response.json([token, mailboxToken]))
    .mockResolvedValueOnce(Response.json({ error: `${token} ${mailboxToken}` }, { status: 403 }))
  const { call } = await connect(request, mailboxEnv)
  const success = await call('read_dev_mail', { recipient: 'a@example.test' })
  expect(success.isError).toBe(false)
  expect(JSON.stringify(success)).toContain('[redacted]')
  expect(JSON.stringify(success)).not.toContain(token)
  expect(JSON.stringify(success)).not.toContain(mailboxToken)
  for (const [code, status] of [['transport_error', 502], ['invalid_response', 502], ['invalid_response', 502], ['forbidden', 403]] as const) {
    const result = await call('read_dev_mail', { recipient: 'a@example.test' })
    expect(result.structuredContent).toEqual({ ok: false, code, status })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain(mailboxToken)
  }
})

test('validates both environment destinations, requires paired mailbox config and refuses non-loopback http', () => {
  expect(loadEnvironment(env)).toMatchObject(env)
  for (const extra of [
    { WORKBASE_OPS_TOKEN: undefined, WORKBASE_TOKEN: token }, { WORKBASE_OPS_TOKEN: '' }, { WORKBASE_OPS_TOKEN: 'bad\r\nheader' },
    { WORKBASE_DEV_MAILBOX_URL: mailboxEnv.WORKBASE_DEV_MAILBOX_URL }, { WORKBASE_DEV_MAILBOX_TOKEN: mailboxToken },
    { ...mailboxEnv, WORKBASE_DEV_MAILBOX_TOKEN: '' }, { ...mailboxEnv, WORKBASE_DEV_MAILBOX_TOKEN: 'bad\r\nheader' },
  ]) expect(() => loadEnvironment({ ...env, ...extra })).toThrow('Workbase request failed')
  for (const key of ['WORKBASE_BASE_URL', 'WORKBASE_DEV_MAILBOX_URL']) {
    for (const url of ['https://user:secret@example.test', 'http://example.test', 'http://192.168.1.1', 'http://0.0.0.0',
      'file:///tmp/api', 'not a URL', 'https://example.test/?token=secret', 'https://example.test/#secret']) {
      expect(() => loadEnvironment({ ...env, ...mailboxEnv, [key]: url })).toThrow('Workbase request failed')
    }
    for (const url of ['https://example.test', 'http://localhost:8997', 'http://127.0.0.1:8997', 'http://[::1]:8997']) {
      expect(() => loadEnvironment({ ...env, ...mailboxEnv, [key]: url })).not.toThrow()
    }
  }
})

test('redacts overlapping and JSON-escaped tokens from provisioning results without corrupting JSON', async () => {
  const ops = 'synthetic-ops-"quoted"-\\secret'
  const mail = `${ops}-mailbox-token-at-least-32-characters`
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'org', name: `${mail} ${ops}`, role: 'owner', replayed: false }))
  const { call } = await connect(request, { ...mailboxEnv, WORKBASE_OPS_TOKEN: ops, WORKBASE_DEV_MAILBOX_TOKEN: mail })
  const result = await call('provision_organization', { name: 'Org', ownerEmail: 'a@example.test' })
  expect(result.structuredContent).toEqual({ ok: true, data: { id: 'org', name: '[redacted] [redacted]', role: 'owner', replayed: false } })
  expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(result.structuredContent)
})

test('data server still strips accept_url from invitation results', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'invite', role: 'member', accept_url: 'https://example.test/secret-link' }))
  const { call } = await link(createDataServer({ WORKBASE_BASE_URL: env.WORKBASE_BASE_URL, WORKBASE_TOKEN: 'wb_synthetic', WORKBASE_ORG_ID: 'org' }, request))
  const result = await call('invite_from_row', { entity: 'workers', id: 'worker', email: 'a@example.test' })
  expect(result.structuredContent).toEqual({ ok: true, data: { id: 'invite', role: 'member' } })
  expect(JSON.stringify(result)).not.toMatch(/accept_url|secret-link/)
})
