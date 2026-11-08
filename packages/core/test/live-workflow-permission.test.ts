import { KernelRegistry } from '../src/kernel/registry'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import sample from './fixtures/sample/config'
import { setup, runtime, request, json } from '@workbasehq/test-support/helpers'
import { createApp } from '../src/app'
import { coreExecutionContext, assertLivePermission } from '../src/execution/context'
import { D1AtomicStore, D1AtomicReader } from '../src/execution/d1'
import type { ExecutionContext, AtomicOperation } from '../src/execution/types'
import { PermissionRevoked } from '../src/execution/errors'
const step: AtomicOperation = { name: 'bookings/create', permission: { entity: 'bookings', operation: 'create' }, input: z.object({}), plan: () => { throw new Error('Permission-only fixture') } }
let app: Awaited<ReturnType<typeof setup>>
let saved: ExecutionContext | undefined
let state: 'running' | 'needs_attention'
beforeEach(async () => {
  await setup(); state = 'running'; saved = undefined
  app = createApp(sample, runtime(), { extend(app, config) {
    app.post('/api/workflow-test/start', async c => {
      saved = coreExecutionContext(config, c.get('scope'), new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
      await assertLivePermission(saved, step)
      return c.json({ state })
    })
    app.post('/api/workflow-test/step', async c => {
      try { const scope = await assertLivePermission(saved!, step); return c.json({ state, role: scope.role }) }
      catch (error) { if (error instanceof PermissionRevoked) state = error.workflowStatus; throw error }
    })
  } })
})
it('workflow REST path stops the next step with permission_revoked after live membership removal', async () => {
  expect((await request(app, '/api/workflow-test/start', 'POST', {}, 'dispatcher-a')).status).toBe(200)
  expect((await request(app, '/orgs/org-a/members/dispatcher-a', 'DELETE')).status).toBe(204)
  // Owner invokes the test runtime's continuation, which uses the saved actor, never the resumer's role.
  const response = await request(app, '/api/workflow-test/step', 'POST', {})
  expect(response.status).toBe(403); expect(await json(response)).toEqual({ error: 'permission_revoked' })
  expect(state).toBe('needs_attention')
})
it('workflow REST path rechecks the actual operation after demotion and does not retain the saved role', async () => {
  await request(app, '/api/workflow-test/start', 'POST', {}, 'dispatcher-a')
  expect((await request(app, '/orgs/org-a/members/dispatcher-a', 'PATCH', { role: 'viewer' })).status).toBe(200)
  expect((await request(app, '/api/workflow-test/step', 'POST', {})).status).toBe(403)
  expect(state).toBe('needs_attention')
  await expect(assertLivePermission(saved!)).rejects.toMatchObject({ code: 'permission_revoked', retryable: false })
})
it('workflow uses live membership after restart and is independent of an expired/revoked initiating browser session', async () => {
  await request(app, '/api/workflow-test/start', 'POST', {}, 'dispatcher-a')
  await env.DB.prepare("DELETE FROM sessions WHERE user_id='dispatcher-a'").run()
  expect((await request(app, '/api/workflow-test/step', 'POST', {})).status).toBe(200)
  const rehydrated = coreExecutionContext(new KernelRegistry(sample).config, saved!.scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))
  expect((await assertLivePermission(rehydrated, step)).role).toBe('dispatcher')
  await request(app, '/orgs/org-a/members/dispatcher-a', 'DELETE')
  await expect(assertLivePermission(rehydrated, step)).rejects.toMatchObject({ code: 'permission_revoked' })
})
it('workflow agent expiry/revocation and operation allowlists stay live', async () => {
  const issued = await json(await request(app, '/orgs/org-a/tokens', 'POST', { name: 'workflow agent', role: 'dispatcher', operations: ['bookings/create'] }))
  expect((await request(app, '/api/workflow-test/start', 'POST', {}, 'owner-a', 'org-a', { Authorization: `Bearer ${issued.token}` })).status).toBe(200)
  expect((await assertLivePermission(saved!, step)).role).toBe('dispatcher')
  const disallowed = { ...step, name: 'stock/consume', permission: { entity: 'stock_items', operation: 'update' as const } }
  await expect(assertLivePermission(saved!, disallowed)).rejects.toMatchObject({ code: 'permission_revoked' })
  expect((await request(app, `/orgs/org-a/tokens/${issued.id}`, 'DELETE')).status).toBe(204)
  const response = await request(app, '/api/workflow-test/step', 'POST', {})
  expect(response.status).toBe(403); expect(state).toBe('needs_attention')
})
