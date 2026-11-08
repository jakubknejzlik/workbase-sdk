// Ported from the independent FIX FIRST review (2026-10-24).
import { createApi } from '../../mcp/src/data/client'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup(); })
it.each(['records', 'jobs', 'reports', 'users', 'teams', 'work_logs'])('review: truly unknown membership role reads no %s rows without error', async (entity) => {
    await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='reviewer'").run()
    const r = await request(app, '/query', 'POST', { entity, select: ['id'], limit: 10 }, 'reviewer')
    expect({ status: r.status, body: await json(r) }).toEqual({ status: 200, body: { data: [], next_cursor: null } })
})
it.each(['list_records', 'get_record'] as const)('review: data MCP truly unknown role returns deny-empty semantics for %s', async (tool) => {
    await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='reviewer'").run()
    const api = createApi({ WORKBASE_BASE_URL: 'http://localhost', WORKBASE_TOKEN: 'synthetic-reviewer', WORKBASE_ORG_ID: 'org-a' }, ((url: any, init: any) => { const { redirect, signal, ...rest } = init; return app.request(url, rest); }) as any)
    if (tool === 'list_records')
        await expect(api.call(tool, { entity: 'records' })).resolves.toEqual({ data: [], next_cursor: null })
    else
        await expect(api.call(tool, { entity: 'records', id: 'record-own' })).rejects.toMatchObject({ code: 'not_found', status: 404 })
})
