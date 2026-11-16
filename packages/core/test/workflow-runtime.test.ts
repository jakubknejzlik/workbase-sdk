import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import sample from './fixtures/sample/config'
import { setup, runtime, request, json } from '@workbasehq/test-support/helpers'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import { defineAtomicOperation, executeAtomic } from '../src/execution/atomic'
import type { WorkflowStep } from '../src/execution/workflow'
import { createWorkflowRegistry, D1WorkflowRuntime } from '../src/workflow-runtime'

const create = defineAtomicOperation({
  name: 'clients/pump_create', permission: { entity: 'clients', operation: 'create' },
  input: z.object({ id: z.string() }),
  plan: (ctx, input) => ({
    rules: [{ name: 'create', statements: [{
      sql: 'INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)',
      bindings: [input.id, ctx.scope.organizationId, input.id, ctx.now, ctx.now], expectRows: 1,
    }] }],
    result: { status: 201, body: { id: input.id } },
    event: { entity: 'clients', entityId: input.id, operation: 'client.pump_created' },
  }),
})
const remove = defineAtomicOperation({
  name: 'clients/pump_remove', permission: { entity: 'clients', operation: 'delete' },
  input: z.object({ id: z.string() }),
  plan: (ctx, input) => ({
    rules: [{ name: 'remove', statements: [{
      sql: 'DELETE FROM clients WHERE id=? AND organization_id=?',
      bindings: [input.id, ctx.scope.organizationId], expectRows: 1,
    }] }],
    result: { status: 200, body: { id: input.id } },
    event: { entity: 'clients', entityId: input.id, operation: 'client.pump_removed' },
  }),
})
const policy = { maxAttempts: 2, backoffMs: 1000, timeoutMs: 3000, deadlineMs: 60000 }
function step(id: string): WorkflowStep {
  return { id, operation: create, sideEffect: false, policy,
    run: ({ context, runId }) => executeAtomic(create, { id: `${runId}:${id}` }, context),
  }
}
const config = { ...sample, commands: [...sample.commands, create.name, remove.name] }
beforeEach(() => setup(config))
async function fixture(steps = [step('first'), step('second')], db = env.DB, key = 'pump') {
  const definitions = createWorkflowRegistry([{ name: 'clients/pump', version: '1', input: z.object({}), steps }])
  const app = createApp(config, runtime(), { workflows: definitions })
  const response = await request(app, '/workflows/clients/pump', 'POST', { idempotencyKey: key }, 'dispatcher-a')
  expect(response.status).toBe(202)
  const { id } = await json(response) as { id: string }
  const makeRuntime = (database = db) => new D1WorkflowRuntime({ ...runtime(), DB: database }, new KernelRegistry(config).config, definitions)
  return { id, pump: makeRuntime(), makeRuntime }
}
async function counts(id: string) {
  return {
    effects: await env.DB.prepare('SELECT count(*) n FROM clients').first<number>('n'),
    receipts: await env.DB.prepare('SELECT count(*) n FROM workflow_steps WHERE run_id=? AND checkpoint_json IS NOT NULL').bind(id).first<number>('n'),
    keys: await env.DB.prepare('SELECT count(*) n FROM idempotency_keys WHERE key LIKE ?').bind(`${id}:%:do`).first<number>('n'),
  }
}
const state = (id: string) => env.DB.prepare('SELECT * FROM workflow_runs WHERE id=?').bind(id).first<Record<string, any>>()

// Faults surround real D1 atomic batches; no effect or receipt is mocked.
function interceptBatches(hooks: { before?(sql: string[]): Promise<void>; after?(sql: string[]): Promise<void> }) {
  const sqls = new WeakMap<D1PreparedStatement, string>()
  return new Proxy(env.DB, { get(db, key) {
    if (key === 'prepare') return (sql: string) => new Proxy(db.prepare(sql), { get(statement, method) {
      if (method === 'bind') return (...values: unknown[]) => {
        const bound = statement.bind(...values); sqls.set(bound, sql); return bound
      }
      const value = Reflect.get(statement, method)
      return typeof value === 'function' ? value.bind(statement) : value
    } })
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      const sql = statements.map(s => sqls.get(s) ?? '')
      await hooks.before?.(sql)
      const results = await db.batch(statements)
      await hooks.after?.(sql)
      return results
    }
    const value = Reflect.get(db, key)
    return typeof value === 'function' ? value.bind(db) : value
  } })
}
const finishesStep = (sql: string[]) => sql.some(s => s.startsWith('UPDATE workflow_steps SET status=?,checkpoint_json='))

it('finishes a multi-step run and terminal checkpoint in one tick with one effect and receipt per step', async () => {
  const { id, pump } = await fixture()
  expect(await pump.tick()).toEqual({ claimed: 1, released: 0 })
  expect(await counts(id)).toEqual({ effects: 2, receipts: 2, keys: 2 })
  expect(await state(id)).toMatchObject({ status: 'completed', lease_token: null, lease_until: null })
  expect(JSON.parse((await state(id))!.result_json)).toHaveProperty('second.body.id', `${id}:second`)
  expect(await pump.continueRun(id)).toEqual({ status: 'terminal', claimed: false })
  expect(await counts(id)).toEqual({ effects: 2, receipts: 2, keys: 2 })
})

it('exhausts the step budget leaving the run due and unleased, then resumes without repeating effects', async () => {
  const { id, pump } = await fixture()
  expect(await pump.continueRun(id, { maxSteps: 1 })).toEqual({ status: 'budget_exhausted', claimed: true })
  expect(await state(id)).toMatchObject({ status: 'running', lease_token: null, lease_until: null })
  expect((await state(id))!.next_attempt_at).toBeLessThanOrEqual(Date.now())
  expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
  expect(await pump.continueRun(id)).toEqual({ status: 'terminal', claimed: true })
  expect(await counts(id)).toEqual({ effects: 2, receipts: 2, keys: 2 })
})

it('checks the elapsed wall-time budget between committed steps', async () => {
  const { id, pump } = await fixture([{
    ...step('first'), run: async args => {
      const result = await step('first').run(args)
      // Move only the pump's elapsed clock; D1 and effect timeouts stay real.
      const later = Date.now() + 1000
      vi.spyOn(Date, 'now').mockReturnValue(later)
      return result
    },
  }, step('second')])
  try {
    expect(await pump.continueRun(id, { maxDurationMs: 500 })).toEqual({ status: 'budget_exhausted', claimed: true })
    expect(await state(id)).toMatchObject({ status: 'running', lease_token: null })
    expect((await state(id))!.next_attempt_at).toBeLessThanOrEqual(Date.now())
    expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
  } finally { vi.restoreAllMocks() }
})

it('stops when a competitor claims between chained steps, without a second effect', async () => {
  let stolen = false
  const db = interceptBatches({ after: async sql => {
    if (stolen || !finishesStep(sql)) return
    stolen = true
    await env.DB.prepare("UPDATE workflow_runs SET lease_token='competitor',lease_until=?").bind(Date.now() + 60000).run()
  } })
  const { id, pump, makeRuntime } = await fixture(undefined, db)
  expect(await pump.continueRun(id)).toEqual({ status: 'lease_lost', claimed: true })
  expect(await state(id)).toMatchObject({ status: 'running', lease_token: 'competitor' })
  expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
  expect(await makeRuntime(env.DB).continueRun(id)).toEqual({ status: 'lease_lost', claimed: false })
  await env.DB.prepare('UPDATE workflow_runs SET lease_until=0 WHERE id=?').bind(id).run()
  expect(await makeRuntime(env.DB).continueRun(id)).toEqual({ status: 'terminal', claimed: true })
  expect(await counts(id)).toEqual({ effects: 2, receipts: 2, keys: 2 })
})

it('fences an old holder that loses its lease before submitting an effect batch', async () => {
  let steal = true
  const { id, pump } = await fixture([{
    ...step('first'), run: async args => {
      if (steal) {
        steal = false
        await env.DB.prepare("UPDATE workflow_runs SET lease_token='competitor',lease_until=? WHERE id=?").bind(Date.now() + 60000, args.runId).run()
      }
      return step('first').run(args)
    },
  }, step('second')])
  expect(await pump.continueRun(id)).toEqual({ status: 'lease_lost', claimed: true })
  expect(await state(id)).toMatchObject({ lease_token: 'competitor' })
  expect(await counts(id)).toEqual({ effects: 0, receipts: 0, keys: 0 })
  await env.DB.prepare('UPDATE workflow_runs SET lease_until=0 WHERE id=?').bind(id).run()
  expect(await pump.continueRun(id)).toEqual({ status: 'terminal', claimed: true })
  expect(await counts(id)).toEqual({ effects: 2, receipts: 2, keys: 2 })
})

it('recovers the private receipt after a crash between effect commit and step finalization', async () => {
  const db = interceptBatches({ before: async sql => {
    if (sql.some(s => s.startsWith('UPDATE workflow_runs SET status=?,resume_status='))) throw new Error('simulated crash before finalization')
  } })
  const { id, pump, makeRuntime } = await fixture(undefined, db)
  await expect(pump.continueRun(id)).rejects.toThrow('simulated crash before finalization')
  expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
  expect(await env.DB.prepare('SELECT status,attempts FROM workflow_steps WHERE run_id=? AND step_id=?').bind(id, 'first').first()).toEqual({ status: 'executing', attempts: 1 })
  await env.DB.prepare('UPDATE workflow_runs SET lease_until=0 WHERE id=?').bind(id).run()
  expect(await makeRuntime(env.DB).continueRun(id)).toEqual({ status: 'terminal', claimed: true })
  expect(await counts(id)).toEqual({ effects: 2, receipts: 2, keys: 2 })
  expect(await env.DB.prepare('SELECT attempts FROM workflow_steps WHERE run_id=? AND step_id=?').bind(id, 'first').first('attempts')).toBe(1)
})

it('does not execute a retry before its persisted next_attempt_at', async () => {
  const { id, pump } = await fixture([{
    ...step('first'), run: async () => { throw new Error('retry later') },
  }, step('second')])
  const result = await pump.continueRun(id)
  const dueAt = (await state(id))!.next_attempt_at as number
  expect(result).toEqual({ status: 'due_at', dueAt, claimed: true })
  expect(dueAt).toBeGreaterThan(Date.now())
  expect(await pump.continueRun(id)).toEqual({ status: 'due_at', dueAt, claimed: false })
  expect(await counts(id)).toEqual({ effects: 0, receipts: 0, keys: 0 })
  expect(await env.DB.prepare('SELECT attempts FROM workflow_steps WHERE run_id=? AND step_id=?').bind(id, 'first').first('attempts')).toBe(1)
  expect(await pump.tick()).toEqual({ claimed: 0, released: 0 })
})

it('fails an invalid checkpoint durably and advances the next due run in the same tick', async () => {
  let invalidRunId: string
  const steps: WorkflowStep[] = [{
    ...step('first'), policy: { ...policy, maxAttempts: 1 },
    run: async args => args.runId === invalidRunId ? { toJSON: () => undefined } : step('first').run(args),
  }]
  const bad = await fixture(steps)
  invalidRunId = bad.id
  const good = await fixture(steps, env.DB, 'after_invalid_checkpoint')
  const now = Date.now()
  // Ensure the invalid checkpoint is encountered before the healthy run.
  await env.DB.prepare('UPDATE workflow_runs SET next_attempt_at=? WHERE id=?').bind(now - 2, bad.id).run()
  await env.DB.prepare('UPDATE workflow_runs SET next_attempt_at=? WHERE id=?').bind(now - 1, good.id).run()

  expect(await bad.pump.tick()).toEqual({ claimed: 2, released: 0 })
  expect(await state(bad.id)).toMatchObject({ status: 'failed', last_error_code: 'workflow.step_failed', lease_token: null, lease_until: null })
  expect(await env.DB.prepare('SELECT status,attempts,last_error_code,checkpoint_json FROM workflow_steps WHERE run_id=?').bind(bad.id).first())
    .toEqual({ status: 'failed', attempts: 1, last_error_code: 'workflow.step_failed', checkpoint_json: null })
  expect(await env.DB.prepare("SELECT count(*) n FROM audit_outbox WHERE json_extract(payload,'$.entity_id')=? AND json_extract(payload,'$.operation')='workflow.step.failed' AND json_extract(payload,'$.details.code')='workflow.step_failed'").bind(bad.id).first('n')).toBe(1)
  expect(await state(good.id)).toMatchObject({ status: 'completed', lease_token: null, lease_until: null })
  expect(await counts(good.id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
})

it('pauses on live permission revocation between chained steps', async () => {
  const db = interceptBatches({ after: async sql => {
    if (finishesStep(sql)) await env.DB.prepare("DELETE FROM memberships WHERE user_id='dispatcher-a' AND organization_id='org-a'").run()
  } })
  const { id, pump } = await fixture(undefined, db)
  expect(await pump.continueRun(id)).toEqual({ status: 'paused', claimed: true })
  expect(await state(id)).toMatchObject({ status: 'needs_attention', last_error_code: 'permission_revoked', lease_token: null })
  expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
  expect(await env.DB.prepare('SELECT attempts FROM workflow_steps WHERE run_id=? AND step_id=?').bind(id, 'second').first('attempts')).toBe(0)
  expect(await pump.continueRun(id)).toEqual({ status: 'paused', claimed: false })
})

it('chains compensation and its terminal completion with stable undo receipts', async () => {
  const { id, pump } = await fixture([{
    ...step('first'), sideEffect: true,
    compensate: { operation: remove, run: ({ context, runId }) => executeAtomic(remove, { id: `${runId}:first` }, context) },
  }, {
    ...step('second'), policy: { ...policy, maxAttempts: 1 },
    run: async () => { throw new Error('permanent failure') },
  }])
  expect(await pump.tick()).toEqual({ claimed: 1, released: 0 })
  expect(await state(id)).toMatchObject({ status: 'compensated', lease_token: null })
  expect(await counts(id)).toEqual({ effects: 0, receipts: 1, keys: 1 })
  expect(await env.DB.prepare('SELECT compensation_attempts,compensation_checkpoint_json FROM workflow_steps WHERE run_id=? AND step_id=?').bind(id, 'first').first()).toMatchObject({ compensation_attempts: 1, compensation_checkpoint_json: expect.any(String) })
  expect(await env.DB.prepare('SELECT count(*) n FROM idempotency_keys WHERE key=? AND command=?').bind(`${id}:first:undo`, remove.name).first('n')).toBe(1)
  for (const operation of ['client.pump_created', 'client.pump_removed']) {
    expect(await env.DB.prepare("SELECT count(*) n FROM audit_outbox WHERE json_extract(payload,'$.operation')=?").bind(operation).first('n')).toBe(1)
  }
})

it('rechecks the definition version between chained steps', async () => {
  const db = interceptBatches({ after: async sql => {
    if (finishesStep(sql)) await env.DB.prepare("UPDATE workflow_runs SET definition_version='unavailable'").run()
  } })
  const { id, pump } = await fixture(undefined, db)
  expect(await pump.continueRun(id)).toEqual({ status: 'paused', claimed: true })
  expect(await state(id)).toMatchObject({ status: 'needs_attention', last_error_code: 'workflow.definition_mismatch', lease_token: null })
  expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
})

// Review1 probes: count each D1 request/batch once, with fixture creation outside
// the counter. Effects and their private receipts still use real atomic batches.
it('shares one pass allowance across many due runs and leaves unfinished work due', async () => {
  let queries = 0
  const db = new Proxy(env.DB, { get(database, key) {
    if (key === 'prepare') return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(st, method) {
        if (method === 'bind') return (...values: unknown[]) => wrap(st.bind(...values))
        const value = Reflect.get(st, method)
        if (['first', 'all', 'run', 'raw'].includes(String(method))) return (...args: unknown[]) => {
          queries++; return value.apply(st, args)
        }
        return typeof value === 'function' ? value.bind(st) : value
      } })
      return wrap(database.prepare(sql))
    }
    if (key === 'batch') return (statements: D1PreparedStatement[]) => { queries++; return database.batch(statements) }
    const value = Reflect.get(database, key)
    return typeof value === 'function' ? value.bind(database) : value
  } })
  const steps = Array.from({ length: 20 }, (_, i) => step(`step_${i}`))
  let pump!: D1WorkflowRuntime
  const ids: string[] = []
  for (let i = 0; i < 20; i++) {
    const f = await fixture(steps, db, `pump_${i}`)
    pump = f.pump; ids.push(f.id)
  }
  const advance = vi.spyOn(pump as any, 'advance')
  try {
    expect(await pump.tick()).toEqual({ claimed: 20, released: 0 })
    expect.soft(advance.mock.calls.length).toBe(32)
    // Leave ample headroom below 1,000 for hold sweeping and the rest of cron.
    expect.soft(queries).toBeLessThanOrEqual(400)
    expect(await env.DB.prepare('SELECT count(*) n FROM clients').first('n')).toBe(32)
    for (const id of ids) {
      expect(await state(id)).toMatchObject({ status: 'running', lease_token: null, lease_until: null })
      expect((await state(id))!.next_attempt_at).toBeLessThanOrEqual(Date.now())
    }
  } finally { vi.restoreAllMocks() }
})

it('gives every due run a quantum before any run gets another', async () => {
  let pump!: D1WorkflowRuntime
  const ids: string[] = []
  for (let i = 0; i < 10; i++) {
    const f = await fixture(undefined, env.DB, `fair_${i}`)
    pump = f.pump; ids.push(f.id)
  }
  const order: string[] = []
  const advance = (pump as any).advance.bind(pump)
  vi.spyOn(pump as any, 'advance').mockImplementation(async (...args: any[]) => {
    order.push(args[0].id)
    return advance(...args)
  })
  try {
    expect(await pump.tick()).toEqual({ claimed: 10, released: 0 })
    expect(new Set(order.slice(0, 10))).toEqual(new Set(ids))
    expect(order).toHaveLength(30) // Two effects and terminal completion per run.
    for (let offset = 0; offset < order.length; offset += 10) {
      expect(order.slice(offset, offset + 10)).toEqual(order.slice(0, 10))
    }
    for (const id of ids) expect((await state(id))!.status).toBe('completed')
  } finally { vi.restoreAllMocks() }
})

it('shares one elapsed deadline across a 100-run tick', async () => {
  let pump!: D1WorkflowRuntime
  for (let i = 0; i < 100; i++) pump = (await fixture(undefined, env.DB, `clock_${i}`)).pump
  const base = Date.now()
  let elapsed = 0
  const passes = new Map<string, number>()
  const starts: number[] = []
  vi.spyOn(Date, 'now').mockImplementation(() => base + elapsed)
  vi.spyOn(pump as any, 'advance').mockImplementation(async (...args: any[]) => {
    const run = args[0] as { id: string }
    const count = passes.get(run.id) ?? 0
    starts.push(elapsed)
    passes.set(run.id, count + 1)
    // One pass may overrun the shared deadline by its existing in-flight timeout.
    elapsed += count === 0 ? 4900 : 10000
    await env.DB.prepare('UPDATE workflow_runs SET lease_token=NULL,lease_until=NULL WHERE id=?').bind(run.id).run()
  })
  try {
    const result = await pump.tick({ limit: 100 })
    expect(elapsed).toBe(9800)
    expect(result).toEqual({ claimed: 2, released: 0 })
    expect(starts).toEqual([0, 4900])
    expect([...passes.values()]).toEqual([1, 1])
    expect(await env.DB.prepare('SELECT count(*) n FROM workflow_runs WHERE lease_token IS NULL AND next_attempt_at<=?').bind(base + elapsed).first('n')).toBe(100)
  } finally { vi.restoreAllMocks() }
})

it.each([
  ['continueRun', false], ['continueRun', true], ['tick', false], ['tick', true],
] as const)('propagates finalization storage failure after same-token expiry (%s, persistent=%s)', async (entry, persistent) => {
  const failure = new Error('storage unavailable during finalization')
  let failures = 0
  const db = interceptBatches({ before: async sql => {
    if (sql.some(s => s.startsWith('UPDATE workflow_runs SET status=?,resume_status=')) && (persistent || failures === 0)) {
      failures++
      await env.DB.prepare('UPDATE workflow_runs SET lease_until=0').run()
      throw failure
    }
  } })
  const { id, pump } = await fixture(undefined, db)
  await expect(entry === 'tick' ? pump.tick() : pump.continueRun(id)).rejects.toBe(failure)
  expect(await state(id)).toMatchObject({ status: 'running', lease_token: expect.any(String), lease_until: 0 })
  expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
  expect(await env.DB.prepare('SELECT status,attempts FROM workflow_steps WHERE run_id=? AND step_id=?').bind(id, 'first').first()).toEqual({ status: 'executing', attempts: 1 })
})

// An actual CAS fence rejection remains a normal lease loss, including when
// D1 expires the same token while the effect's receipt is already durable.
it('reports a real finalization fence rejection after same-token expiry as lease_lost', async () => {
  const db = interceptBatches({ before: async sql => {
    if (finishesStep(sql)) await env.DB.prepare('UPDATE workflow_runs SET lease_until=0').run()
  } })
  const { id, pump, makeRuntime } = await fixture(undefined, db)
  expect(await pump.continueRun(id)).toEqual({ status: 'lease_lost', claimed: true })
  expect(await counts(id)).toEqual({ effects: 1, receipts: 1, keys: 1 })
  expect(await makeRuntime(env.DB).continueRun(id)).toEqual({ status: 'terminal', claimed: true })
  expect(await counts(id)).toEqual({ effects: 2, receipts: 2, keys: 2 })
})

it.each([{}, { maxSteps: 1000, maxDurationMs: 1e9 }])('keeps standalone pass and elapsed caps bounded (%j)', async budget => {
  const { id, pump } = await fixture()
  const base = Date.now()
  let elapsed = 0
  let duration = 0
  vi.spyOn(Date, 'now').mockImplementation(() => base + elapsed)
  const advance = vi.spyOn(pump as any, 'advance').mockImplementation(async () => {
    elapsed += duration
    await env.DB.prepare('UPDATE workflow_runs SET lease_token=NULL,lease_until=NULL WHERE id=?').bind(id).run()
  })
  try {
    expect(await pump.continueRun(id, budget)).toEqual({ status: 'budget_exhausted', claimed: true })
    expect(advance).toHaveBeenCalledTimes(32)
    advance.mockClear()
    duration = 2500
    expect(await pump.continueRun(id, budget)).toEqual({ status: 'budget_exhausted', claimed: true })
    expect(advance).toHaveBeenCalledTimes(2)
    expect(elapsed).toBe(5000)
  } finally { vi.restoreAllMocks() }
})
