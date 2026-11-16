import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { setup, runtime, request, json } from '@workbasehq/test-support/helpers'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import { createWorkflowRegistry, D1WorkflowRuntime } from '../src/workflow-runtime'
import { defineAtomicOperation } from '../src/execution/atomic'
import { dispatchWebhooks } from '../src/relay'
import { makeEvent } from '../src/audit-event'
import { recordRelayRun } from '../src/ops'

const poison = 'secret=synthetic-token https://example.test/invitations/accept?token=synthetic-acceptance'
const operation = defineAtomicOperation({ name: 'clients/evidence', permission: { entity: 'clients', operation: 'create' }, input: z.object({}), plan: () => { throw new Error('unused') } })
const config = { ...sample, commands: [...sample.commands, operation.name] }
const path = '/audit/operations'
beforeEach(() => setup(config))
const app = () => createApp(config, runtime())
const evidence = async (query = '') => {
  const response = await request(app(), path + query)
  expect(response.status).toBe(200)
  return (await json(response)).data as Record<string, any>[]
}
async function webhook(id: string, attempts = 0) {
  await env.DB.prepare("INSERT INTO webhook_deliveries (event_id,organization_id,payload,next_attempt_at,attempts) VALUES (?,'org-a',?,'2000-01-01',?)").bind(id, poison, attempts).run()
}
async function auditRow(id = 'audit-evidence') {
  const kernel = new KernelRegistry(config)
  const event = makeEvent(kernel.config, { organizationId: 'org-a', actor: { type: 'user', id: 'owner-a' }, role: 'owner', correlationId: 'evidence' }, 'test.created', 'clients', id)
  event.event_id = id
  await env.DB.prepare("INSERT INTO audit_outbox (event_id,organization_id,payload,created_at) VALUES (?,'org-a',?,'2000-01-01T00:00:00.000Z')").bind(id, JSON.stringify(event)).run()
  return { kernel, row: { event_id: id, organization_id: 'org-a', payload: JSON.stringify(event) } }
}
function checkSafe(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const forbidden of ['synthetic-token', 'synthetic-acceptance', 'https://', 'accept?', 'secret=', 'delivery_text', 'delivery_html']) expect(serialized).not.toContain(forbidden)
}
it('persists timestamped webhook failures, terminal and interrupted attempts, and retains history on success', async () => {
  await webhook('retry'); await webhook('terminal', 4); await webhook('interrupted', 5)
  const now = Date.now()
  await dispatchWebhooks({ ...runtime(), WEBHOOK_URL: 'https://example.test', WEBHOOK_ALLOWED_HOSTS: 'example.test' }, { now, fetcher: async () => { throw new Error(poison) } })
  await dispatchWebhooks({ ...runtime(), WEBHOOK_URL: 'https://example.test', WEBHOOK_ALLOWED_HOSTS: 'example.test' }, { now: now + 10000, fetcher: async () => new Response(null, { status: 204 }) })
  const records = await evidence('?source=webhook')
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ source_id: 'retry', state: 'pending', error_code: 'delivery_failed', attempts: 1 }),
    expect.objectContaining({ source_id: 'terminal', state: 'failed', error_code: 'delivery_failed', attempts: 5 }),
    expect.objectContaining({ source_id: 'interrupted', state: 'failed', error_code: 'delivery_interrupted', attempts: 5 }),
  ]))
  expect(await env.DB.prepare("SELECT state,last_error FROM webhook_deliveries WHERE event_id='retry'").first()).toEqual({ state: 'delivered', last_error: null })
  for (const row of records) { expect(row.organization_id).toBe('org-a'); expect(Date.parse(row.occurred_at)).toBeGreaterThan(0); expect(Date.parse(row.created_at)).toBeGreaterThan(0); expect(row.age_seconds).toBeGreaterThanOrEqual(0) }
  checkSafe(records)
  await checkStoredErrors()
})
it('persists failed mail and retains evidence after an invitation-bearing payload succeeds', async () => {
  const kernel = new KernelRegistry(config)
  const intent = kernel.mailOutbox.intent({ id: 'mail-evidence', organizationId: 'org-a', recipient: 'synthetic@example.test', subject: 'Synthetic', body: poison, text: poison, html: poison, expiresAt: new Date(Date.now() + 60000).toISOString() })
  await env.DB.prepare(intent.sql).bind(...intent.bindings!).run()
  const send = vi.fn().mockRejectedValueOnce(new Error(poison)).mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'synthetic@example.test' }
  await kernel.mailOutbox.deliver(settings, kernel.config, 'mail-evidence', async () => true)
  await kernel.mailOutbox.retry(settings, kernel.config, 'mail-evidence', async () => true)
  expect(await evidence('?source=mail')).toEqual(expect.arrayContaining([expect.objectContaining({ organization_id: 'org-a', source_id: 'mail-evidence', state: 'failed', error_code: 'email_send_failed', attempts: 1 })]))
  expect(await kernel.mailOutbox.status(env.DB, 'mail-evidence')).toMatchObject({ delivery_status: 'sent', last_error: null, attempts: 2 })
  checkSafe(await evidence('?source=mail'))
  await checkStoredErrors()
})
it('records unprocessed audit backlog and delivery failures, retaining both past cleanup', async () => {
  const { kernel, row } = await auditRow()
  await expect(kernel.audit!.deliver(runtime(), row, { sink: { insert: async () => { throw new Error(poison) } } })).rejects.toThrow('audit_delivery_failed')
  expect(await evidence('?source=audit&source_id=' + row.event_id)).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'pending', error_code: 'backlog_pending', attempts: 0 })]))
  await kernel.audit!.relay(runtime(), { sweep: true })
  await kernel.audit!.deliver(runtime(), row)
  await kernel.audit!.relay(runtime(), { now: Date.now() + 8 * 86400000 })
  const records = await evidence('?source=audit')
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ source_id: row.event_id, state: 'pending', error_code: 'backlog_pending' }),
    expect.objectContaining({ source_id: row.event_id, state: 'failed', error_code: 'audit_delivery_failed', attempts: 1 }),
  ]))
  checkSafe(records)
  await checkStoredErrors()
})
it('enriches workflow failure/attention audit events and preserves them after resume, success and cleanup', async () => {
  let failed = true
  const definitions = createWorkflowRegistry([{ name: 'clients/evidence', version: '1', input: z.object({}), steps: [{ id: 'effect', operation, sideEffect: false, policy: { maxAttempts: 2, backoffMs: 0, timeoutMs: 1000, deadlineMs: 60000 }, run: async () => { if (failed) throw new Error(poison); return {} } }] }])
  const worker = createApp(config, runtime(), { workflows: definitions })
  const { id } = await json(await request(worker, '/workflows/clients/evidence', 'POST', { idempotencyKey: 'evidence' }, 'dispatcher-a'))
  const pump = new D1WorkflowRuntime(runtime(), new KernelRegistry(config).config, definitions)
  await pump.continueRun(id, { maxSteps: 1 })
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='dispatcher-a' AND organization_id='org-a'").run()
  await pump.continueRun(id)
  expect(await env.DB.prepare('SELECT status FROM workflow_runs WHERE id=?').bind(id).first('status')).toBe('needs_attention')
  await env.DB.prepare("INSERT INTO memberships VALUES ('dispatcher-a','org-a','dispatcher')").run()
  expect((await request(worker, `/workflows/${id}/resume`, 'POST', {})).status).toBe(202)
  failed = false; await pump.continueRun(id)
  expect(await env.DB.prepare('SELECT status FROM workflow_runs WHERE id=?').bind(id).first('status')).toBe('completed')
  const kernel = new KernelRegistry(config)
  expect((await kernel.audit!.relay(runtime())).errors).toBe(0)
  const activity = await json(await request(app(), `/audit/events?entity=workflows&entity_id=${id}`))
  expect(activity.data).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'workflow.step.failed', details: expect.objectContaining({ state: 'running', attempts: 1, step_id: 'effect' }) })]))
  await kernel.audit!.relay(runtime(), { now: Date.now() + 8 * 86400000 })
  const records = await evidence('?source=workflow')
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ source_id: id, step_id: 'effect', state: 'running', error_code: 'workflow.step_failed', attempts: 1 }),
    expect.objectContaining({ source_id: id, state: 'needs_attention', error_code: 'permission_revoked', attempts: 1 }),
  ]))
  checkSafe(records)
  await checkStoredErrors()
})
it('retains relay snapshot history exclusively behind the ops token', async () => {
  const opsEnv = { ...runtime(), OPS_TOKEN: 'synthetic-only-ops-token' }
  const opsApp = createApp(config, opsEnv)
  const metrics = { backlog: 2, oldestAgeSeconds: 30, failed: 1, delivered: 0, webhookDelivered: 0, errors: 1 }
  await recordRelayRun(runtime(), metrics); await recordRelayRun(runtime(), { ...metrics, backlog: 0, failed: 0, errors: 0 })
  expect((await request(app(), '/internal/ops')).status).toBe(403)
  const response = await request(opsApp, '/internal/ops', 'GET', undefined, 'owner-a', 'org-a', { 'X-Internal-Token': opsEnv.OPS_TOKEN })
  expect((await request(opsApp, '/internal/ops', 'GET', undefined, 'owner-a', 'org-a', { 'X-Internal-Token': runtime().INTERNAL_TOKEN })).status).toBe(403)
  const result = await json(response)
  expect(result.lastRun.history).toHaveLength(2)
  expect(result.lastRun.history[0]).toMatchObject({ backlog: 2, failed: 1 })
  expect(result.lastRun.history[1]).toMatchObject({ backlog: 0, failed: 0 })
  checkSafe(result.lastRun)
})
it('denies foreign organizations and missing permissions, ignoring tenant query overrides', async () => {
  await webhook('org-a-private')
  await env.DB.prepare("INSERT INTO webhook_deliveries (event_id,organization_id,payload,next_attempt_at) VALUES ('org-b-private','org-b',?,'2000-01-01')").bind(poison).run()
  expect((await request(app(), path, 'GET', undefined, 'owner-a', 'org-b')).status).toBe(403)
  expect((await request(app(), path, 'GET', undefined, 'viewer-a')).status).toBe(403)
  const token = await json(await request(app(), '/orgs/org-a/tokens', 'POST', { name: 'evidence reader', role: 'owner', operations: ['clients/read'] }))
  expect((await request(app(), path, 'GET', undefined, 'owner-a', 'org-a', { Authorization: `Bearer ${token.token}` })).status).toBe(403)
  const other = await json(await request(app(), path + '?organization_id=org-a&org=org-a', 'GET', undefined, 'owner-b', 'org-b'))
  expect(other.data).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: 'org-b-private', organization_id: 'org-b' })]))
  expect(other.data.every((row: any) => row.organization_id === 'org-b')).toBe(true)
  expect(await evidence('?source_id=org-b-private')).toEqual([])
  checkSafe(await evidence())
})
it('validates filters and bounds pages without exposing source payloads', async () => {
  for (const query of ['?limit=0', '?limit=101', '?source=security_log', '?offset=-1']) expect((await request(app(), path + query)).status).toBe(400)
  await webhook('first'); await webhook('second')
  const one = await evidence('?limit=1')
  const two = await evidence('?limit=1&offset=1')
  expect(one).toHaveLength(1); expect(two).toHaveLength(1)
  expect(one[0].source_id).not.toBe(two[0].source_id)
})

async function checkStoredErrors() {
  for (const table of ['webhook_deliveries', 'email_outbox', 'audit_outbox']) {
    checkSafe((await env.DB.prepare(`SELECT last_error,operational_history FROM ${table}`).all()).results)
  }
  checkSafe((await env.DB.prepare('SELECT last_error_code FROM workflow_runs UNION ALL SELECT last_error_code FROM workflow_steps').all()).results)
  checkSafe((await env.DB.prepare("SELECT json_extract(payload,'$.details') AS details FROM audit_outbox WHERE json_extract(payload,'$.operation') IN ('workflow.step.failed','workflow.failed','workflow.needs_attention')").all()).results)
}
it('commits source transitions and histories atomically, preserving the old history on rollback', async () => {
  await webhook('atomic')
  const prior = await env.DB.prepare("SELECT state,operational_history FROM webhook_deliveries WHERE event_id='atomic'").first()
  await expect(env.DB.batch([
    env.DB.prepare("UPDATE webhook_deliveries SET state='failed',last_error='delivery_failed',attempts=5 WHERE event_id='atomic'"),
    env.DB.prepare("INSERT INTO organizations(id,name) VALUES ('org-a','duplicate')"),
  ])).rejects.toThrow()
  expect(await env.DB.prepare("SELECT state,operational_history FROM webhook_deliveries WHERE event_id='atomic'").first()).toEqual(prior)
})
it('grants an audit.read owner token access and omits uninstalled mail evidence', async () => {
  await webhook('permissioned')
  const token = await json(await request(app(), '/orgs/org-a/tokens', 'POST', { name: 'evidence reader', role: 'owner', operations: ['audit.read'] }))
  const response = await request(app(), path, 'GET', undefined, 'owner-a', 'org-a', { Authorization: `Bearer ${token.token}` })
  expect(response.status).toBe(200)
  expect((await json(response)).data).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: 'permissioned' })]))
  const noMail = createApp({ ...config, plugins: config.plugins!.filter(plugin => plugin.name !== 'mail-outbox') }, runtime())
  expect(await json(await request(noMail, path + '?source=mail'))).toEqual({ data: [], next_offset: null })
})
it('records a terminal workflow failure with its exact spent attempt budget', async () => {
  const definitions = createWorkflowRegistry([{ name: 'clients/terminal', version: '1', input: z.object({}), steps: [{ id: 'effect', operation, sideEffect: false, policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 1000, deadlineMs: 60000 }, run: async () => { throw new Error(poison) } }] }])
  const worker = createApp(config, runtime(), { workflows: definitions })
  const { id } = await json(await request(worker, '/workflows/clients/terminal', 'POST', { idempotencyKey: 'terminal' }))
  await new D1WorkflowRuntime(runtime(), new KernelRegistry(config).config, definitions).continueRun(id)
  expect(await env.DB.prepare('SELECT status FROM workflow_runs WHERE id=?').bind(id).first('status')).toBe('failed')
  const records = await evidence('?source=workflow')
  expect(records.filter(row => row.source_id === id)).toHaveLength(2)
  for (const row of records) expect(row).toMatchObject({ source_id: id, step_id: 'effect', state: 'failed', error_code: 'workflow.step_failed', attempts: 1, compensation_attempts: 0 })
  await checkStoredErrors()
})

it('preserves failed compensation budgets when owner resume resets the live budget', async () => {
  let compensateFails = true
  const policy = { maxAttempts: 1, backoffMs: 0, timeoutMs: 1000, deadlineMs: 60000 }
  const definitions = createWorkflowRegistry([{ name: 'clients/compensation', version: '1', input: z.object({}), steps: [
    { id: 'effect', operation, sideEffect: true, policy, run: async () => ({}), compensate: { operation, run: async () => { if (compensateFails) throw new Error(poison); return {} } } },
    { id: 'fail', operation, sideEffect: false, policy, run: async () => { throw new Error(poison) } },
  ] }])
  const worker = createApp(config, runtime(), { workflows: definitions })
  const { id } = await json(await request(worker, '/workflows/clients/compensation', 'POST', { idempotencyKey: 'compensation' }))
  const pump = new D1WorkflowRuntime(runtime(), new KernelRegistry(config).config, definitions)
  await pump.continueRun(id)
  expect(await env.DB.prepare('SELECT status FROM workflow_runs WHERE id=?').bind(id).first('status')).toBe('needs_attention')
  expect(await evidence('?source=workflow')).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: id, step_id: 'effect', state: 'needs_attention', attempts: 1, compensation_attempts: 1 })]))
  compensateFails = false
  expect((await request(worker, `/workflows/${id}/resume`, 'POST', {})).status).toBe(202)
  await pump.continueRun(id)
  expect(await env.DB.prepare('SELECT status FROM workflow_runs WHERE id=?').bind(id).first('status')).toBe('compensated')
  expect(await evidence('?source=workflow')).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: id, step_id: 'effect', state: 'needs_attention', current_state: 'compensated', compensation_attempts: 1 })]))
  await checkStoredErrors()
})
