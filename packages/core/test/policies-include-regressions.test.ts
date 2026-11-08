import { beforeEach, expect, it } from 'vitest'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { createApi } from '../../mcp/src/data/client'

let app: ReturnType<typeof createApp>
beforeEach(async () => {
  await setup()
  const config = defineInstance({ ...policyGraph, entities: { ...policyGraph.entities, users: { ...policyGraph.entities.users, relations: { ...policyGraph.entities.users.relations, logs: { entity: 'work_logs', field: 'operator_user_id', many: true } } } } })
  app = createApp(config, runtime())
})
it.each([false, true])('forbidden include denies even when the parent set is empty=%s', async empty => {
  const response = await request(app, '/query', 'POST', { entity: 'users', select: ['id'], limit: 20, ...(empty ? { where: { id: { eq: 'absent' } } } : {}), include: { logs: { select: ['id'] } } }, 'coordinator')
  expect(response.status).toBe(403)
  expect(await json(response)).toMatchObject({ error: 'policy_violation', path: ['include', 'logs'] })
})
it('nested forbidden include reports its complete selection path', async () => {
  const response = await request(app, '/query', 'POST', { entity: 'teams', select: ['id'], limit: 10, include: { team_users: { select: ['id'], include: { logs: { select: ['id'] } } } } }, 'coordinator')
  expect(response.status).toBe(403)
  expect(await json(response)).toMatchObject({ error: 'policy_violation', path: ['include', 'team_users', 'include', 'logs'] })
})
it('data MCP list expansion propagates forbidden includes', async () => {
  const api = createApi({ WORKBASE_BASE_URL: 'http://localhost', WORKBASE_TOKEN: 'synthetic-coordinator', WORKBASE_ORG_ID: 'org-a' }, ((url: any, init: any) => {
    const { redirect, signal, ...rest } = init
    return app.request(url, rest)
  }) as any)
  await expect(api.call('list_records', { entity: 'users', filters: { expand: 'logs' } })).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
})
