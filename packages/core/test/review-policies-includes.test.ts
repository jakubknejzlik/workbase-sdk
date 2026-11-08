// Ported from the independent FIX FIRST review (2026-10-24).
import { createApi } from '../../mcp/src/data/client'
import { beforeEach, expect, it } from 'vitest'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup(); })
it('review: forbidden include must return 403', async () => {
    const config = defineInstance({ ...policyGraph, entities: { ...policyGraph.entities, users: { ...policyGraph.entities.users, relations: { ...policyGraph.entities.users.relations, logs: { entity: 'work_logs', field: 'operator_user_id', many: true } } } } })
    const a = createApp(config, runtime())
    const r = await request(a, '/query', 'POST', { entity: 'users', select: ['id'], limit: 20, include: { logs: { select: ['id'] } } }, 'coordinator')
    expect({ status: r.status, body: await json(r) }).toMatchObject({ status: 403, body: { error: 'policy_violation' } })
})
it.each(['list_records', 'get_record'])('review: data MCP propagates forbidden %s', async (tool) => {
    const api = createApi({ WORKBASE_BASE_URL: 'http://localhost', WORKBASE_TOKEN: 'synthetic-coordinator', WORKBASE_ORG_ID: 'org-a' }, ((url: any, init: any) => { const { redirect, signal, ...rest } = init; return app.request(url, rest); }) as any)
    await expect(api.call(tool as any, { entity: 'work_logs', id: 'log-operator' })).rejects.toMatchObject({ code: 'policy_violation', status: 403 })
})
