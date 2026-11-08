import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { z } from 'zod'
import sample from './fixtures/sample/config'
import { setup, request, json, runtime } from '@workbasehq/test-support/helpers'
import { createApp } from '../src/app'
import { sha256 } from '../src/crypto'
import { defineAtomicOperation, executeAtomic } from '../src/execution/atomic'
import { createWorkflowRegistry } from '../src/workflow-runtime'

it('workflow results recheck all/none policies, read grants, field masks and deleted rows', async () => {
  await setup(sample)
  const operation = defineAtomicOperation({
    name: 'clients/rename', permission: { entity: 'clients', operation: 'update' }, input: z.object({ id: z.string() }),
    plan: (ctx, input) => ({
      rules: [{ name: 'rename', statements: [{ sql: 'UPDATE clients SET name=? WHERE id=? AND organization_id=?', bindings: ['Renamed', input.id, ctx.scope.organizationId], expectRows: 1 }] }],
      result: { status: 200, body: { id: input.id } }, event: { entity: 'clients', entityId: input.id, operation: 'client.renamed' },
    }),
  })
  const workflows = createWorkflowRegistry([{ name: 'clients/rename', version: '1', input: operation.input, steps: [{
    id: 'rename', operation, sideEffect: false, policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 3000, deadlineMs: 60000 },
    run: ({ context, input }) => executeAtomic(operation, input, context),
  }] }])
  const config = { ...sample, commands: [...sample.commands, operation.name] }
  const app = createApp(config, runtime(), { workflows })
  const now = new Date().toISOString()
  await env.DB.prepare('INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('workflow-client', 'org-a', 'Client', now, now).run()
  const started = await request(app, '/workflows/clients/rename', 'POST', { id: 'workflow-client', idempotencyKey: 'workflow-client' }, 'dispatcher-a')
  expect(started.status).toBe(202)
  const run = await json(started)
  for (let i = 0; i < 2; i++) expect((await app.request('http://localhost/internal/workflows/run', { method: 'POST', headers: { 'X-Internal-Token': 'synthetic-test-internal' } })).status).toBe(200)
  const result = async (reader = app) => (await json(await request(reader, `/workflows/${run.id}`, 'GET', undefined, 'dispatcher-a'))).result
  expect((await result()).rename.body.id).toBe('workflow-client')
  expect(JSON.stringify(await result())).not.toContain('__workbase_policy')

  for (const policy of ['none' as const, { where: {}, fields: [] }]) {
    const restricted = createApp({ ...config, policies: { ...config.policies, clients: { ...config.policies.clients, dispatcher: policy } } }, runtime(), { workflows })
    const response = await request(restricted, `/workflows/${run.id}`, 'GET', undefined, 'dispatcher-a')
    expect(response.status).toBe(policy === 'none' ? 403 : 200)
    const body = await json(response)
    if (response.status === 200) expect(body.result).toBeNull()
    expect(JSON.stringify(body)).not.toContain('workflow-client')
  }
  const noRead = createApp({ ...config, permissions: { ...config.permissions, dispatcher: { ...config.permissions.dispatcher, clients: ['update'] } } }, runtime(), { workflows })
  expect(await result(noRead)).toBeNull()

  await env.DB.prepare('DELETE FROM clients WHERE id=?').bind('workflow-client').run()
  expect(await result()).toBeNull()
  await env.DB.prepare('UPDATE workflow_runs SET result_json=? WHERE id=?').bind(JSON.stringify({ rename: { status: 200, body: { id: 'workflow-client' }, __workbase_policy: { rows: [] } } }), run.id).run()
  expect(await result()).toBeNull()
})
