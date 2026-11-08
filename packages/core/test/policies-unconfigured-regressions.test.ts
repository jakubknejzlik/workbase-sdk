import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { createApi } from '../../mcp/src/data/client'
import { sha256 } from '../src/crypto'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => {
  app = await setup()
  await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='reviewer'").run()
})
it.each(['records', 'jobs', 'reports', 'users', 'teams', 'work_logs'])('unconfigured viewer gets empty REST and data MCP list/detail for %s', async entity => {
  const ids: Record<string, string> = { records: 'record-own', jobs: 'job-own', reports: 'report-own', users: 'reviewer', teams: 'team-a', work_logs: 'log-operator' }
  const response = await request(app, `/api/${entity}`, 'GET', undefined, 'reviewer')
  expect(response.status).toBe(200)
  expect(await json(response)).toEqual({ data: [], next_cursor: null })
  expect((await request(app, `/api/${entity}/${ids[entity]}`, 'GET', undefined, 'reviewer')).status).toBe(404)
  const api = createApi({ WORKBASE_BASE_URL: 'http://localhost', WORKBASE_TOKEN: 'synthetic-reviewer', WORKBASE_ORG_ID: 'org-a' }, ((url: any, init: any) => {
    const { redirect, signal, ...rest } = init
    return app.request(url, rest)
  }) as any)
  await expect(api.call('list_records', { entity })).resolves.toEqual({ data: [], next_cursor: null })
  await expect(api.call('get_record', { entity, id: ids[entity] })).rejects.toMatchObject({ status: 404, code: 'not_found' })
})
it('unconfigured viewer cannot write and a token read allowlist remains enforced', async () => {
  for (const [method, path, body] of [
    ['POST', '/api/records', { name: 'Denied', team_id: 'team-a' }],
    ['PATCH', '/api/records/record-own', { name: 'Denied', version: 1 }],
    ['DELETE', '/api/records/record-own', undefined],
  ] as const) expect((await request(app, path, method, body, 'reviewer')).status).toBe(403)
  const token = 'wb_synthetic_unconfigured_viewer'
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,operations,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('viewer-token', 'org-a', 'reviewer', 'Viewer', await sha256(token), 'wb_synthetic', 'viewer', JSON.stringify(['records.read']), '2099-01-01T00:00:00.000Z', 'now').run()
  const headers = { Authorization: `Bearer ${token}` }
  const records = await request(app, '/api/records', 'GET', undefined, 'reviewer', 'org-a', headers)
  expect(records.status).toBe(200); expect((await json(records)).data).toEqual([])
  const jobs = await request(app, '/api/jobs', 'GET', undefined, 'reviewer', 'org-a', headers)
  expect(jobs.status).toBe(403); expect((await json(jobs)).error).toBe('operation_forbidden')
})
