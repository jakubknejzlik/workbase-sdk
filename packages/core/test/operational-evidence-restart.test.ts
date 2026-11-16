import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { setup, runtime, request, json } from '@workbasehq/test-support/helpers'
import sample from './fixtures/sample/config'
import { KernelRegistry } from '../src/kernel/registry'
import { createApp } from '../src/app'
import { defineAtomicOperation } from '../src/execution/atomic'
import { createWorkflowRegistry, D1WorkflowRuntime } from '../src/workflow-runtime'
import { dispatchWebhooks } from '../src/relay'
import { makeEvent } from '../src/audit-event'
import { recordRelayRun } from '../src/ops'

declare global { namespace Cloudflare { interface Env { EVIDENCE_BEFORE: Fetcher; EVIDENCE_AFTER: Fetcher } } }
const poison = 'https://example.test/invitations/accept?token=restart-secret'
it('reads all signals from a fresh Worker isolate against the same D1 after recovery', async () => {
  const operation = defineAtomicOperation({ name: 'clients/restart', permission: { entity: 'clients', operation: 'create' }, input: z.object({}), plan: () => { throw new Error('unused') } })
  const config = { ...sample, commands: [...sample.commands, operation.name] }
  await setup(config)
  let recovered = false
  const definitions = createWorkflowRegistry([{ name: 'clients/restart', version: '1', input: z.object({}), steps: [{ id: 'effect', operation, sideEffect: false, policy: { maxAttempts: 2, backoffMs: 0, timeoutMs: 1000, deadlineMs: 60000 }, run: async () => { if (!recovered) throw new Error(poison); return {} } }] }])
  const app = createApp(config, runtime(), { workflows: definitions })
  const kernel = new KernelRegistry(config)
  const pump = new D1WorkflowRuntime(runtime(), kernel.config, definitions)
  const { id } = await json(await request(app, '/workflows/clients/restart', 'POST', { idempotencyKey: 'restart' }, 'dispatcher-a'))
  await pump.continueRun(id, { maxSteps: 1 })
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='dispatcher-a' AND organization_id='org-a'").run()
  await pump.continueRun(id)
  await env.DB.prepare("INSERT INTO webhook_deliveries (event_id,organization_id,payload,attempts,next_attempt_at) VALUES ('restart-webhook','org-a',?,4,'2000-01-01')").bind(poison).run()
  await dispatchWebhooks(runtime())
  const mail = kernel.mailOutbox.intent({ id: 'restart-mail', organizationId: 'org-a', recipient: 'test@example.test', subject: 'Synthetic', body: poison, text: poison, html: poison, expiresAt: new Date(Date.now() + 60000).toISOString() })
  await env.DB.prepare(mail.sql).bind(...mail.bindings!).run()
  const settings = { ...runtime(), EMAIL_FROM: 'test@example.test', EMAIL: { send: async () => { if (!recovered) throw new Error(poison); return { messageId: 'synthetic-restart' } } } }
  await kernel.mailOutbox.deliver(settings, kernel.config, 'restart-mail', async () => true)
  const event = makeEvent(kernel.config, { organizationId: 'org-a', actor: { type: 'user', id: 'owner-a' }, role: 'owner', correlationId: 'restart' }, 'test.created', 'clients', 'restart-audit')
  await env.DB.prepare("INSERT INTO audit_outbox(event_id,organization_id,payload,created_at) VALUES (?,'org-a',?,'2000-01-01T00:00:00.000Z')").bind(event.event_id, JSON.stringify(event)).run()
  await kernel.audit!.relay(runtime(), { sweep: true })
  const read = (worker: Fetcher, org = 'org-a') => worker.fetch('http://localhost/audit/operations', { headers: { Authorization: 'Bearer synthetic-owner-a', 'X-Organization-Id': org } })
  await recordRelayRun(runtime(), { backlog: 1, oldestAgeSeconds: 30, failed: 2, delivered: 0, webhookDelivered: 0, errors: 1 })
  const before = await read(env.EVIDENCE_BEFORE)
  expect(before.status).toBe(200); expect(before.headers.get('X-Evidence-Requests')).toBe('1')
  const initial = (await json(before)).data
  for (const code of ['workflow.step_failed', 'permission_revoked', 'delivery_failed', 'email_send_failed', 'backlog_pending']) expect(initial.some((row: any) => row.error_code === code)).toBe(true)
  recovered = true
  await env.DB.prepare("INSERT INTO memberships VALUES ('dispatcher-a','org-a','dispatcher')").run()
  await request(app, `/workflows/${id}/resume`, 'POST', {})
  await pump.continueRun(id)
  await kernel.mailOutbox.retry(settings, kernel.config, 'restart-mail', async () => true)
  await kernel.audit!.relay(runtime())
  await kernel.audit!.relay(runtime(), { now: Date.now() + 8 * 86400000 })
  // This second service has never been called. Its module globals and application
  // objects are new; its D1 database ID is identical to the writer and first reader.
  await recordRelayRun(runtime(), { backlog: 0, oldestAgeSeconds: null, failed: 1, delivered: 1, webhookDelivered: 0, errors: 0 })
  const after = await read(env.EVIDENCE_AFTER)
  expect(after.status).toBe(200); expect(after.headers.get('X-Evidence-Requests')).toBe('1')
  expect(after.headers.get('X-Evidence-Isolate')).not.toBe(before.headers.get('X-Evidence-Isolate'))
  const final = (await json(after)).data
  for (const { age_seconds: _age, current_state: _current, ...row } of initial) expect(final).toEqual(expect.arrayContaining([expect.objectContaining(row)]))
  expect(JSON.stringify(final)).not.toContain(poison)
  const snapshots = await json(await env.EVIDENCE_AFTER.fetch('http://localhost/internal/ops', { headers: { 'X-Internal-Token': runtime().INTERNAL_TOKEN } }))
  expect(snapshots.lastRun.history).toHaveLength(2)
  expect(snapshots.lastRun.history[0]).toMatchObject({ backlog: 1, errors: 1 })
  expect(snapshots.lastRun.history[1]).toMatchObject({ backlog: 0, errors: 0 })
  expect((await read(env.EVIDENCE_AFTER, 'org-b')).status).toBe(403)
})
