import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, runtime, policyGraph, roles } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { queryClient } from '../../mcp/test/data/query-client'
import { queryMetrics, recordQuery, emptyQueryLog, QUERY_DURATION_SAMPLES } from '../src/query/observability'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
const input = (entity: string, extra = {}) => ({ entity, limit: 10, ...extra })
async function connect(role: string) {
  return queryClient(((url: string, init: RequestInit) => { const { redirect: _redirect, ...local } = init; return app.request(url, local) }) as typeof fetch, `synthetic-${role}`)
}
async function parity(client: Awaited<ReturnType<typeof queryClient>>['client'], role: string, query: any) {
  const http = await request(app, '/query', 'POST', query, role)
  const text = await http.text()
  const mcp = await client.callTool({ name: 'query', arguments: query })
  expect(mcp.content).toEqual([{ type: 'text', text }])
  expect(mcp.isError).toBe(!http.ok)
  expect(JSON.stringify(mcp.structuredContent)).toBe(text)
  return JSON.parse(text)
}
it.each(['reviewer', 'coordinator'])('MCP/HTTP byte parity matrix under %s policies', async role => {
  const { client, close } = await connect(role)
  try {
    for (const query of [
      input('records'), input('jobs', { select: ['id', 'title'] }),
      input('records', { where: { name: { contains: 'own' } }, orderBy: [{ field: 'name', dir: 'desc' }] }),
      input('records', { include: { jobs: { select: ['id', 'title'], limit: 2 } } }),
      input('records', { where: { jobs: { none: { title: { eq: 'CANARY_ROW' } } } } }),
      input('records', { include: { team: { select: ['id', 'name'] } } }),
      input('jobs', { select: ['internal_files_ids'] }), input('work_logs'), input('reports'),
      null, [], {}, input('\ud800'), input({} as any),
      input('missing'), input('records', { limit: 101 }), input('records', { cursor: 'invalid' }),
      input('records', { where: { UNKNOWN_CANARY: { eq: 'PRIVATE_VALUE_CANARY' } } }),
      input('records', { include: { team: { select: ['id'], include: { team_users: { include: { team: {} } } } } } }),
    ]) await parity(client, role, query)
    const page = await parity(client, role, input('records', { select: ['id'], limit: 1 }))
    expect(page.next_cursor).toBeTruthy()
    await parity(client, role, input('records', { select: ['id'], limit: 1, cursor: page.next_cursor }))
    const discovery = await client.callTool({ name: 'describe_schema', arguments: {} })
    expect((discovery.structuredContent as any).data.schema).toEqual(await json(await app.request('http://localhost/schema')))
  } finally { await close() }
})
it.each([...roles, 'unknown'])('MCP canary oracle and forbidden/none/unknown-role parity for %s', async role => {
  // Exercise a live membership role absent from roles, permissions and policies.
  if (role === 'unknown') await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='unknown'").run()
  const counts: Record<string, number[]> = {
    administrator: [10, 2, 3, 3, 3, 2], coordinator: [10, 2, 3, 3, 0, 403],
    operator: [10, 2, 3, 3, 0, 1], reviewer: [9, 1, 2, 2, 1, 403], team_user: [9, 1, 2, 2, 2, 403], unknown: [0, 0, 0, 0, 0, 0],
  }
  const { client, close } = await connect(role)
  try {
    for (const [i, entity] of Object.keys(policyGraph.entities).entries()) {
      const body = await parity(client, role, input(entity, { select: ['id'], limit: 100 }))
      if (counts[role][i] === 403) expect(body).toEqual({ error: 'policy_violation', path: [] })
      else { expect(body.data).toHaveLength(counts[role][i]); expect(body.next_cursor).toBeNull() }
      expect(JSON.stringify(body)).not.toContain('CANARY_ORG')
      if (['reviewer', 'team_user', 'unknown'].includes(role) && entity !== 'users') expect(JSON.stringify(body)).not.toMatch(/CANARY_(?:ROW|ACCOUNT)|SECRET_FILES_CANARY/)
    }
    if (role === 'reviewer') {
      const page = await parity(client, role, input('records', { select: ['id'], limit: 1 }))
      const payload = atob(page.next_cursor.split('.')[0].replaceAll('-', '+').replaceAll('_', '/'))
      expect(payload).not.toMatch(/CANARY_(?:ROW|ORG|ACCOUNT)|SECRET_FILES_CANARY/)
      const err = await parity(client, role, input('jobs', { where: { internal_files_ids: { contains: 'SECRET_FILES_CANARY' } } }))
      expect(err.error).toBe('field_forbidden'); expect(JSON.stringify(err)).not.toContain('SECRET_FILES_CANARY')
    }
  } finally { await close() }
})
it('facade masks fields and expansions, preserves hidden/missing 404, and shares include caps', async () => {
  const query = await json(await request(app, '/query', 'POST', input('jobs', { include: { record: {} } }), 'reviewer'))
  const list = await json(await request(app, '/api/jobs?limit=10&expand=record', 'GET', undefined, 'reviewer'))
  expect(list).toEqual(query)
  expect(list.data.every((row: any) => !Object.hasOwn(row, 'internal_files_ids'))).toBe(true)
  const detail = await json(await request(app, '/api/jobs/job-own?expand=record', 'GET', undefined, 'reviewer'))
  expect(detail).toEqual(list.data.find((row: any) => row.id === 'job-own'))
  const hidden = await request(app, '/api/jobs/job-CANARY_ROW', 'GET', undefined, 'reviewer')
  const missing = await request(app, '/api/jobs/missing', 'GET', undefined, 'reviewer')
  expect(hidden.status).toBe(404); expect(missing.status).toBe(404); expect(await hidden.text()).toBe(await missing.text())
  expect((await request(app, '/api/jobs?expand=record,record,record,record,record,record', 'GET', undefined, 'reviewer')).status).toBe(400)
})
it('surface logs have safe shape/cost/counts and ops accounts for successes and every rejection once', async () => {
  const capture = vi.spyOn(console, 'log').mockImplementation(() => {})
  const start = queryMetrics(env.DB).queries
  const { client, close } = await connect('reviewer')
  try {
    await request(app, '/query', 'POST', input('records', { select: ['id'], where: { name: { eq: 'LOG_VALUE_CANARY' } }, include: { jobs: { select: ['id'] } } }), 'reviewer')
    await client.callTool({ name: 'query', arguments: input('records', { select: ['id'] }) })
    await request(app, '/api/jobs?expand=record', 'GET', undefined, 'reviewer')
    await request(app, '/api/jobs/missing', 'GET', undefined, 'reviewer')
    await request(app, '/api/jobs?limit=1000', 'GET', undefined, 'reviewer')
    await request(app, '/query', 'POST', input('jobs', { select: ['internal_files_ids'] }), 'reviewer')
    await app.request('http://localhost/query', { method: 'POST', headers: { Authorization: 'Bearer synthetic-reviewer', 'X-Organization-Id': 'org-a' }, body: '{MALFORMED_LOG_CANARY' })
    const logs = capture.mock.calls.map(([line]) => { try { return JSON.parse(line) } catch { return {} } }).filter(log => log.event === 'query')
    expect(logs).toHaveLength(7)
    expect(logs[0]).toMatchObject({ queryHash: expect.stringMatching(/^[a-f0-9]{64}$/), actorKind: 'user', tokenId: null, organizationId: 'org-a', shape: { entity: 'records', depth: 1, relationCount: 1, selectCount: 2, includeCount: 1 }, statementCount: 1, resultRows: 0, errorCode: null })
    for (const log of logs) { expect(log.durationMs).toBeGreaterThanOrEqual(0); expect(log.bindingCount).toBeGreaterThanOrEqual(log.bindingHighWaterMark) }
    expect(JSON.stringify(logs)).not.toMatch(/LOG_VALUE_CANARY|MALFORMED_LOG_CANARY|SECRET_FILES_CANARY|synthetic-reviewer|\$actor|team-a|SELECT|WHERE|predicate|"bindings"|"actor"|"id":"reviewer"/)
    expect(logs.slice(-4).map(log => log.errorCode)).toEqual(['not_found', 'invalid_limit', 'field_forbidden', 'query_invalid'])
    const ops = await json(await request(app, '/internal/ops', 'GET', undefined, 'reviewer', 'org-a', { 'X-Internal-Token': runtime().INTERNAL_TOKEN }))
    expect(ops.queries.queries).toBe(start + 7)
    expect(ops.queries.errors).toMatchObject({ not_found: expect.any(Number), invalid_limit: expect.any(Number), field_forbidden: expect.any(Number), query_invalid: expect.any(Number) })
    expect(ops.queries.durationMs.p95).toBeGreaterThanOrEqual(ops.queries.durationMs.p50)
  } finally { capture.mockRestore(); await close() }
})
it('duration ring remains bounded while lifetime counters retain every query and error', () => {
  const db = {} as D1Database
  const capture = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    for (let i = 0; i < QUERY_DURATION_SAMPLES + 10; i++) recordQuery(db, { ...emptyQueryLog({ organizationId: 'org-a', actor: { type: 'agent', id: 'PRIVATE_ACTOR_CANARY', tokenId: 'token-id' }, role: 'reviewer', correlationId: 'test' }, 'hash'), durationMs: i, errorCode: i % 2 ? 'query_invalid' : null })
    expect(queryMetrics(db)).toEqual({ queries: 266, errors: { query_invalid: 133 }, durationMs: { samples: 256, capacity: 256, p50: 137, p95: 253 } })
    expect(JSON.stringify(capture.mock.calls)).not.toContain('PRIVATE_ACTOR_CANARY')
  } finally { capture.mockRestore() }
})

it('MCP agent telemetry uses live token metadata and excludes issuer/account attributes and token secrets', async () => {
  const { sha256 } = await import('../src/crypto')
  const token = 'wb_QUERY_TOKEN_SECRET_CANARY'
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind('query-agent-id', 'org-a', 'reviewer', 'Query agent', await sha256(token), 'wb_QUERY', 'reviewer', '2099-01-01T00:00:00.000Z', 'now').run()
  const { client, close } = await queryClient(((url: string, init: RequestInit) => { const { redirect: _redirect, ...local } = init; return app.request(url, local) }) as typeof fetch, token)
  const capture = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const result = await client.callTool({ name: 'query', arguments: input('records', { select: ['id'] }) })
    expect(result.isError).toBe(false)
    const logs = capture.mock.calls.map(([line]) => JSON.parse(line)).filter(log => log.event === 'query')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ actorKind: 'agent', tokenId: 'query-agent-id', organizationId: 'org-a', resultRows: 2, errorCode: null })
    expect(JSON.stringify(logs)).not.toMatch(/QUERY_TOKEN_SECRET_CANARY|\$actor|team-a|"reviewer"|SELECT|WHERE|predicate|"bindings"/)
  } finally { capture.mockRestore(); await close() }
})
