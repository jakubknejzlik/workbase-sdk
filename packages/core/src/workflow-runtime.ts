import { outboxInsert } from './execution/outbox'
import { kernelFor } from './kernel/registry'
import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { RuntimeEnv, Scope } from './types'
import { ApiError } from './errors'
import { makeEvent } from './audit-event'
import { requestHash } from './idempotency'
import { ulid } from './crypto'
import { coreExecutionContext, assertLivePermission, infrastructure, holdReleaseContext } from './execution/context'
import { D1AtomicStore, D1AtomicReader } from './execution/d1'
import { PermissionRevoked } from './execution/errors'
import type { ExecutionContext, GuardedStatement, AtomicStore } from './execution/types'
import type { WorkflowDefinition, WorkflowRuntime, WorkflowStatus, WorkflowStep } from './execution/workflow'
export type WorkflowRegistry = ReadonlyMap<string, WorkflowDefinition<any>>
interface Run {
  id: string; organization_id: string; actor_id: string; actor_type: 'user' | 'agent'; token_id: string | null
  definition_name: string; definition_version: string; definition_signature: string; input_json: string
  cancel_actor_id: string | null; status: WorkflowStatus; resume_status: WorkflowStatus | null; correlation_id: string; lease_token: string; last_error_code: string | null
}
interface Step {
  step_id: string; status: string; attempts: number; compensation_attempts: number; deadline_at: number | null
  compensation_deadline_at: number | null; compensation_checkpoint_json: string | null; last_error_code: string | null; checkpoint_json: string | null; next_attempt_at: number
}
function publicCheckpoint(serialized: string) {
  const value = JSON.parse(serialized)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { __workbase_policy, ...result } = value
  return result
}
const active = "'pending','running','waiting_external','compensating'"
export function createWorkflowRegistry(definitions: readonly WorkflowDefinition<any>[]): WorkflowRegistry {
  const registry = new Map<string, WorkflowDefinition<any>>()
  for (const definition of definitions) {
    if (!definition.steps?.length || definition.steps.length > 20 || !/^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)+$/.test(definition.name) || !definition.version || definition.version.length > 100 || registry.has(definition.name)) throw new Error('invalid_workflow_definition')
    const ids = new Set<string>()
    for (const step of definition.steps) {
      const p = step.policy
      if (step.id.length > 64 || !/^[a-z][a-z0-9_]*$/.test(step.id) || ids.has(step.id) || typeof step.sideEffect !== 'boolean' || (step.sideEffect && !step.compensate)
        || !Number.isInteger(p.maxAttempts) || p.maxAttempts < 1 || p.maxAttempts > 10 || p.timeoutMs < 1 || p.timeoutMs > 10000
        || ![p.timeoutMs, p.deadlineMs, p.backoffMs].every(Number.isFinite) || p.deadlineMs < p.timeoutMs || p.backoffMs < 0) throw new Error('invalid_workflow_step')
      if (step.holdsCapacity && (!step.sideEffect || !step.compensate || step.kind === 'external' || definition.steps.filter(s => s.holdsCapacity).length !== 1)) throw new Error('invalid_workflow_hold_step')
      ids.add(step.id)
    }
    registry.set(definition.name, definition)
  }
  return registry
}
export function workflowSignature(definition: WorkflowDefinition<any>) {
  // Version owners must bump for semantic code changes; this also detects incompatible structural edits.
  return JSON.stringify(definition.steps?.map(s => ({ id: s.id, operation: { name: s.operation.name, permission: s.operation.permission, additionalPermissions: s.operation.additionalPermissions }, kind: s.kind ?? 'atomic', policy: s.policy, sideEffect: !!s.sideEffect, compensation: s.compensate ? { name: s.compensate.operation.name, permission: s.compensate.operation.permission, additionalPermissions: s.compensate.operation.additionalPermissions } : null })))
}
export class D1WorkflowRuntime implements WorkflowRuntime {
  constructor(readonly env: RuntimeEnv, readonly config: InstanceConfig, readonly definitions: WorkflowRegistry) { kernelFor(config) }
  #context(scope: Scope, key?: string) {
    return coreExecutionContext(this.config, scope, new D1AtomicStore(this.env.DB, { env: this.env, config: this.config }), new D1AtomicReader(this.env.DB), key, this)
  }
  async start<S extends z.ZodType>(definition: WorkflowDefinition<S>, input: z.output<S>, context: ExecutionContext) {
    if (infrastructure(context).workflowRuntime !== this || context.config.id !== this.config.id || context.config.revision !== this.config.revision) throw new ApiError(403, 'workflow_context_mismatch')
    if (this.definitions.get(definition.name) !== definition) throw new ApiError(404, 'workflow_not_found')
    for (const step of definition.steps!) await assertLivePermission(context, step.operation)
    z.string().min(1).max(128).parse(context.idempotencyKey)
    const operation = `workflow:${definition.name}:${definition.version}`
    const hash = await requestHash(operation, input)
    const replay = async () => {
      const row = await this.env.DB.prepare('SELECT command,request_hash,response_json FROM idempotency_keys WHERE organization_id=? AND key=?').bind(context.scope.organizationId, context.idempotencyKey!).first<{ command: string; request_hash: string; response_json: string }>()
      if (!row) return null
      if (row.command !== operation || row.request_hash !== hash) throw new ApiError(422, 'idempotency_payload_mismatch')
      return JSON.parse(row.response_json) as { id: string }
    }
    const previous = await replay(); if (previous) return previous
    const id = ulid(); const now = new Date().toISOString(); const scope = context.scope
    const statements: GuardedStatement[] = [{
      sql: 'INSERT INTO workflow_runs (id,organization_id,actor_id,actor_type,token_id,definition_name,definition_version,definition_signature,input_json,status,correlation_id,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      bindings: [id, scope.organizationId, scope.actor.id, scope.actor.type, scope.actor.tokenId ?? null, definition.name, definition.version, workflowSignature(definition), JSON.stringify(input), 'pending', scope.correlationId, Date.now(), now, now], expectRows: 1,
    }, ...definition.steps!.map((s, i) => ({ sql: "INSERT INTO workflow_steps (run_id,step_id,position,status) VALUES (?,?,?,'pending')", bindings: [id, s.id, i], expectRows: 1 as const })), this.audit(scope, id, 'workflow.started'), {
      sql: 'INSERT INTO idempotency_keys (organization_id,key,command,response_json,request_hash) VALUES (?,?,?,?,?)',
      bindings: [scope.organizationId, context.idempotencyKey!, operation, JSON.stringify({ id }), hash], expectRows: 1,
    }]
    try { await this.submit(statements) } catch (error) { const winner = await replay(); if (winner) return winner; throw error }
    return { id }
  }
  private submit(statements: GuardedStatement[]) {
    return new D1AtomicStore(this.env.DB, { env: this.env, config: this.config }).run({ runId: crypto.randomUUID(), rules: [{ name: 'workflow_state', statements }] })
  }
  private audit(scope: Scope, id: string, code: string, stepId?: string, errorCode?: string): GuardedStatement {
    const event = makeEvent(this.config, scope, code, 'workflows', id, {}, {}, { run_id: id, ...(stepId ? { step_id: stepId } : {}), ...(errorCode ? { code: errorCode } : {}) })
    return outboxInsert(event)
  }
  private scope(run: Run): Scope {
    if (run.cancel_actor_id) return { organizationId: run.organization_id, actor: { type: 'user', id: run.cancel_actor_id }, role: '', correlationId: run.correlation_id }
    return { organizationId: run.organization_id, actor: { type: run.actor_type, id: run.actor_id, ...(run.token_id ? { tokenId: run.token_id } : {}) }, role: '', correlationId: run.correlation_id }
  }
  private fence(run: Run, now: number): GuardedStatement {
    // D1's clock also rejects a write delayed in transit beyond its lease.
    return { sql: `UPDATE workflow_runs SET updated_at=? WHERE id=? AND lease_token=? AND lease_until>max(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))${run.cancel_actor_id ? " AND EXISTS(SELECT 1 FROM memberships WHERE user_id=? AND organization_id=workflow_runs.organization_id AND role='owner')" : ''}`, bindings: [new Date(now).toISOString(), run.id, run.lease_token, now, ...(run.cancel_actor_id ? [run.cancel_actor_id] : [])], expectRows: 1 }
  }
  private async transition(run: Run, now: number, status: WorkflowStatus, event: string, code: string | null = null, statements: GuardedStatement[] = [], stepId?: string, nextAt = now) {
    await this.submit([this.fence(status === 'needs_attention' ? { ...run, cancel_actor_id: null } : run, now), ...statements, {
      sql: 'UPDATE workflow_runs SET status=?,resume_status=?,last_error_code=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL WHERE id=?',
      bindings: [status, status === 'needs_attention' ? (run.status === 'compensating' ? 'compensating' : 'running') : null, code, nextAt, run.id], expectRows: 1,
    }, this.audit(this.scope(run), run.id, event, stepId, code ?? undefined)])
  }
  async resume(id: string, context: ExecutionContext) {
    if (infrastructure(context).workflowRuntime !== this || context.config.id !== this.config.id || context.config.revision !== this.config.revision) throw new ApiError(403, 'workflow_context_mismatch')
    kernelFor(this.config).resourcePermission(context.scope, 'workflows.resume')
    // The resumer is an authenticated current owner, independently of the saved actor.
    const member = context.scope.actor.type === 'user' ? await this.env.DB.prepare('SELECT role FROM memberships WHERE user_id=? AND organization_id=?').bind(context.scope.actor.id, context.scope.organizationId).first<{ role: string }>() : null
    if (member?.role !== 'owner') throw new ApiError(403, 'owner_required')
    const organizationId = context.scope.organizationId
    const run = await this.env.DB.prepare('SELECT * FROM workflow_runs WHERE id=? AND organization_id=?').bind(id, organizationId).first<Run>()
    if (!run) throw new ApiError(403, 'workflow_forbidden')
    if (run.status !== 'needs_attention') throw new ApiError(409, 'workflow_not_paused')
    const definition = this.definitions.get(run.definition_name)
    if (!definition || definition.version !== run.definition_version || workflowSignature(definition) !== run.definition_signature) {
      await this.submit([{ sql: "UPDATE workflow_runs SET last_error_code='workflow.definition_mismatch' WHERE id=? AND status='needs_attention'", bindings: [id], expectRows: 1 }, this.audit(this.scope(run), id, 'workflow.needs_attention', undefined, 'workflow.definition_mismatch')])
      throw new ApiError(409, 'workflow.definition_mismatch')
    }
    const saved = (await this.env.DB.prepare('SELECT * FROM workflow_steps WHERE run_id=? ORDER BY position').bind(id).all<Step>()).results
    for (const [index, step] of definition.steps!.entries()) {
      const operation = run.resume_status === 'compensating'
        ? (['completed', 'executing', 'failed'].includes(saved[index].status) ? step.compensate?.operation : undefined)
        : (saved[index].status !== 'completed' ? step.operation : undefined)
      if (!operation) continue
      await assertLivePermission(context, operation)
      await assertLivePermission(this.#context(this.scope(run)), operation)
    }
    // Resume does not reset retry/deadline budgets. A failed compensation gets a new, explicit owner-authorized budget.
    const now = Date.now()
    await this.submit([{
      sql: "UPDATE workflow_runs SET status=coalesce(resume_status,'running'),last_error_code=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND organization_id=? AND status='needs_attention' AND (lease_until IS NULL OR lease_until<=?) AND EXISTS(SELECT 1 FROM memberships WHERE user_id=? AND organization_id=? AND role='owner')",
      bindings: [now, new Date(now).toISOString(), id, organizationId, now, context.scope.actor.id, organizationId], expectRows: 1,
    }, ...(run.resume_status === 'compensating' ? [{ sql: "UPDATE workflow_steps SET compensation_attempts=0,compensation_deadline_at=NULL,next_attempt_at=0 WHERE run_id=? AND status<>'compensated'", bindings: [id] }] : []), this.audit(context.scope, id, 'workflow.resumed')])
    return run.resume_status ?? 'running'
  }
  async cancel(id: string, context: ExecutionContext) {
    if (infrastructure(context).workflowRuntime !== this || context.config.id !== this.config.id || context.config.revision !== this.config.revision) throw new ApiError(403, 'workflow_context_mismatch')
    kernelFor(this.config).resourcePermission(context.scope, 'workflows.cancel')
    const scope = context.scope
    const member = scope.actor.type === 'user' ? await this.env.DB.prepare('SELECT role FROM memberships WHERE user_id=? AND organization_id=?').bind(scope.actor.id, scope.organizationId).first<{ role: string }>() : null
    if (member?.role !== 'owner') throw new ApiError(403, 'owner_required')
    const saved = await this.env.DB.prepare('SELECT * FROM workflow_runs WHERE id=? AND organization_id=?').bind(id, scope.organizationId).first<Run>()
    if (!saved) throw new ApiError(403, 'workflow_forbidden')
    if (saved.status === 'cancelled') return 'cancelled'
    if (['completed', 'compensated'].includes(saved.status)) throw new ApiError(409, 'workflow_terminal')
    const definition = this.definitions.get(saved.definition_name)
    if (!definition || definition.version !== saved.definition_version || workflowSignature(definition) !== saved.definition_signature) throw new ApiError(409, 'workflow.definition_mismatch')
    // Independently authorize the owner; never test or borrow the saved token.
    for (const step of definition.steps!) if (step.compensate) await assertLivePermission(context, step.compensate.operation)
    const now = Date.now()
    await this.submit([{
      sql: "UPDATE workflow_runs SET status='compensating',cancel_actor_id=?,resume_status=NULL,last_error_code=NULL,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND organization_id=? AND status NOT IN ('completed','compensated','cancelled') AND (lease_until IS NULL OR lease_until<=?) AND EXISTS(SELECT 1 FROM memberships WHERE user_id=? AND organization_id=? AND role='owner')",
      bindings: [scope.actor.id, now, id, scope.organizationId, now, scope.actor.id, scope.organizationId], expectRows: 1,
    }, { sql: "UPDATE workflow_steps SET compensation_attempts=0,compensation_deadline_at=NULL,next_attempt_at=0 WHERE run_id=? AND status<>'compensated'", bindings: [id] }, this.audit(scope, id, 'workflow.cancellation_requested')])
    // Drain a bounded reverse pass for the HTTP caller. Failed attempts retain their
    // durable budgets/backoff and the cron continues under this owner's live scope.
    for (let i = 0; i <= definition.steps!.length; i++) {
      const time = Date.now()
      const run = await this.env.DB.prepare("UPDATE workflow_runs SET lease_token=?,lease_until=? WHERE id=? AND status='compensating' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING *").bind(crypto.randomUUID(), time + 60000, id, time, time).first<Run>()
      if (!run) break
      await this.advance(run, time)
    }
    return (await this.env.DB.prepare('SELECT status FROM workflow_runs WHERE id=?').bind(id).first<string>('status'))!
  }
  private async sweepHolds(scanNow: number, limit: number) {
    const started = Date.now(); const time = () => scanNow + Date.now() - started
    const rows = await this.env.DB.prepare("SELECT r.id FROM workflow_holds h JOIN workflow_runs r ON r.id=h.run_id AND r.organization_id=h.organization_id WHERE h.status='held' AND h.expires_at<=? AND r.status IN ('needs_attention','failed','compensating') AND (r.lease_until IS NULL OR r.lease_until<=?) ORDER BY h.expires_at,r.id LIMIT ?").bind(new Date(scanNow).toISOString(), scanNow, limit).all<{ id: string }>()
    let released = 0
    for (const row of rows.results) {
      const run = await this.env.DB.prepare("UPDATE workflow_runs SET lease_token=?,lease_until=? WHERE id=? AND status IN ('needs_attention','failed','compensating') AND (lease_until IS NULL OR lease_until<=?) AND EXISTS(SELECT 1 FROM workflow_holds WHERE run_id=workflow_runs.id AND organization_id=workflow_runs.organization_id AND status='held' AND expires_at<=?) RETURNING *").bind(crypto.randomUUID(), time() + 60000, row.id, time(), new Date(time()).toISOString()).first<Run>()
      if (!run) continue
      try {
        const definition = this.definitions.get(run.definition_name)
        if (!definition || definition.version !== run.definition_version || workflowSignature(definition) !== run.definition_signature) continue
        const step = definition.steps!.find(s => s.holdsCapacity && s.kind !== 'external' && s.compensate)
        if (!step) continue
        const steps = (await this.env.DB.prepare('SELECT * FROM workflow_steps WHERE run_id=? ORDER BY position').bind(run.id).all<Step>()).results
        if (!steps.some(s => s.step_id === step.id && ['completed', 'executing', 'failed'].includes(s.status))) continue
        const scope: Scope = { organizationId: run.organization_id, actor: { type: 'service', id: 'system' }, role: 'SYSTEM', correlationId: run.correlation_id }
        const base = new D1AtomicStore(this.env.DB, { env: this.env, config: this.config })
        const store: AtomicStore = { run: plan => base.run({ ...plan, rules: [
          { name: 'expired_hold_lease', statements: [this.fence({ ...run, cancel_actor_id: null }, time()), {
            sql: "UPDATE workflow_holds SET status=status WHERE run_id=? AND organization_id=? AND status='held' AND expires_at<=?", bindings: [run.id, run.organization_id, new Date(time()).toISOString()], expectRows: 1,
          }] }, ...plan.rules, { name: 'expired_hold_audit', statements: [{
            sql: "UPDATE workflow_holds SET status=status WHERE run_id=? AND organization_id=? AND status='released'", bindings: [run.id, run.organization_id], expectRows: 1,
          }, this.audit(scope, run.id, 'workflow.hold_expired', step.id)] },
        ] }) }
        const context = holdReleaseContext(coreExecutionContext(this.config, scope, store, new D1AtomicReader(this.env.DB), `${run.id}:${step.id}:undo`), step.compensate!.operation)
        await assertLivePermission(context, step.compensate!.operation)
        let timer: ReturnType<typeof setTimeout> | undefined
        const controller = new AbortController()
        await Promise.race([step.compensate!.run(Object.freeze({ context, runId: run.id, input: JSON.parse(run.input_json), checkpoints: Object.fromEntries(steps.filter(s => s.checkpoint_json).map(s => [s.step_id, publicCheckpoint(s.checkpoint_json!)])), signal: controller.signal })), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new ApiError(408, 'workflow.external_timeout')) }, step.policy.timeoutMs)
        })]).finally(() => clearTimeout(timer))
        if (await this.env.DB.prepare("SELECT 1 FROM workflow_holds h JOIN workflow_runs r ON r.id=h.run_id WHERE h.run_id=? AND h.status='released' AND r.lease_token=?").bind(run.id, run.lease_token).first()) released++
      } catch (error) {
        const owner = await this.env.DB.prepare('SELECT lease_token FROM workflow_runs WHERE id=?').bind(run.id).first<{ lease_token: string | null }>()
        if (owner?.lease_token === run.lease_token) throw error
      } finally {
        await this.env.DB.prepare('UPDATE workflow_runs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(run.id, run.lease_token).run()
      }
    }
    return released
  }
  async tick(options: { now?: number; limit?: number } = {}) {
    const started = Date.now(); const scanNow = options.now ?? started
    const limit = Math.max(0, Math.min(Math.trunc(options.limit ?? 20), 100))
    const released = await this.sweepHolds(scanNow, limit)
    const rows = await this.env.DB.prepare(`SELECT id FROM workflow_runs WHERE status IN (${active}) AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_attempt_at,id LIMIT ?`).bind(scanNow, scanNow, limit).all<{ id: string }>()
    let claimed = 0
    for (const row of rows.results) {
      const now = scanNow + Date.now() - started
      const run = await this.env.DB.prepare(`UPDATE workflow_runs SET lease_token=?,lease_until=? WHERE id=? AND status IN (${active}) AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING *`).bind(crypto.randomUUID(), now + 60000, row.id, now, now).first<Run>()
      if (!run) continue
      claimed++
      try { await this.advance(run, scanNow + Date.now() - started) }
      catch (error) {
        // Losing a lease is an expected race. Other storage failures leave the lease
        // for crash recovery and remain visible to the caller/cron metrics.
        const owner = await this.env.DB.prepare('SELECT lease_token FROM workflow_runs WHERE id=?').bind(run.id).first<{ lease_token: string | null }>()
        if (owner?.lease_token === run.lease_token) throw error
      }
    }
    return { claimed, released }
  }
  private async advance(run: Run, now: number) {
    // Include permission/checkpoint reads in elapsed time, not only the effect.
    const started = Date.now(); const optionsNow = () => now + Date.now() - started
    const definition = this.definitions.get(run.definition_name)
    if (!definition || definition.version !== run.definition_version || workflowSignature(definition) !== run.definition_signature) {
      await this.transition(run, optionsNow(), 'needs_attention', 'workflow.needs_attention', 'workflow.definition_mismatch'); return
    }
    const rows = (await this.env.DB.prepare('SELECT * FROM workflow_steps WHERE run_id=? ORDER BY position').bind(run.id).all<Step>()).results
    if (run.cancel_actor_id) {
      const owner = await this.env.DB.prepare("SELECT 1 FROM memberships WHERE user_id=? AND organization_id=? AND role='owner'").bind(run.cancel_actor_id, run.organization_id).first()
      if (!owner) { await this.transition(run, optionsNow(), 'needs_attention', 'workflow.needs_attention', 'permission_revoked'); return }
    }
    const compensating = run.status === 'compensating'
    const index = compensating ? rows.findLastIndex(s => ['completed', 'executing', 'failed'].includes(s.status) && !!definition.steps!.find(d => d.id === s.step_id)?.compensate) : rows.findIndex(s => s.status !== 'completed')
    if (index === -1) {
      await this.transition(run, optionsNow(), compensating ? (run.cancel_actor_id ? 'cancelled' : 'compensated') : 'completed', compensating ? (run.cancel_actor_id ? 'workflow.cancelled' : 'workflow.compensated') : 'workflow.completed', compensating ? run.last_error_code : null,
        compensating ? [] : [{ sql: 'UPDATE workflow_runs SET result_json=? WHERE id=?', bindings: [JSON.stringify(Object.fromEntries(rows.map(s => [s.step_id, s.checkpoint_json ? JSON.parse(s.checkpoint_json) : null]))), run.id] }]); return
    }
    const step = definition.steps![index]; const saved = rows[index]
    const action = compensating ? step.compensate! : step
    const count = compensating ? saved.compensation_attempts : saved.attempts
    const deadline = (compensating ? saved.compensation_deadline_at : saved.deadline_at) ?? optionsNow() + step.policy.deadlineMs
    const key = `${run.id}:${step.id}:${compensating ? 'undo' : 'do'}`
    const scope = this.scope(run)
    // Fence every executeAtomic batch supplied to a step, even if its runner outlives its lease.
    const base = new D1AtomicStore(this.env.DB, { env: this.env, config: this.config })
    const store: AtomicStore = { run: plan => base.run({ ...plan, rules: [
      { name: 'workflow_lease', statements: [this.fence(run, optionsNow())] }, ...plan.rules,
      // The public idempotency table accepts caller-chosen keys. Only this fenced
      // effect batch can create the private receipt used for workflow crash recovery.
      { name: 'workflow_effect_receipt', statements: [{
        sql: `UPDATE workflow_steps SET ${compensating ? 'compensation_checkpoint_json' : 'checkpoint_json'}=(SELECT response_json FROM idempotency_keys WHERE organization_id=? AND key=? AND command=?) WHERE run_id=? AND step_id=? AND EXISTS(SELECT 1 FROM idempotency_keys WHERE organization_id=? AND key=? AND command=?)`,
        bindings: [scope.organizationId, key, action.operation.name, run.id, step.id, scope.organizationId, key, action.operation.name], expectRows: 1,
      }] },
    ] }) }
    // Use elapsed real time relative to the tick clock, allowing deterministic local tests.
    let context = coreExecutionContext(this.config, scope, store, new D1AtomicReader(this.env.DB), key, undefined, { policyReceipt: !compensating })
    try {
      const live = await assertLivePermission(context, action.operation)
      context = coreExecutionContext(this.config, live, store, new D1AtomicReader(this.env.DB), key, undefined, { policyReceipt: !compensating })
      // If an atomic effect committed before a crash, recover its receipt without repeating it or spending another attempt.
      const receipt = compensating ? saved.compensation_checkpoint_json : saved.checkpoint_json
      if (receipt) { await this.finishStep(run, optionsNow(), step, compensating, JSON.parse(receipt)); return }
      if (optionsNow() >= deadline) throw new ApiError(408, 'workflow.deadline_exceeded')
      if (count >= step.policy.maxAttempts && !compensating && step.kind === 'external' && step.recover) {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([step.recover(Object.freeze({ context, runId: run.id, input: JSON.parse(run.input_json), checkpoints: Object.fromEntries(rows.filter(s => s.checkpoint_json).map(s => [s.step_id, publicCheckpoint(s.checkpoint_json!)])), signal: controller.signal })), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new ApiError(408, 'workflow.external_timeout')) }, Math.min(step.policy.timeoutMs, deadline - optionsNow()))
        })]).finally(() => clearTimeout(timer))
        if (result !== null && optionsNow() < deadline) { await this.finishStep(run, optionsNow(), step, false, result); return }
      }
      if (count >= step.policy.maxAttempts) throw new ApiError(408, 'workflow.attempts_exhausted')
      await this.submit([this.fence(run, optionsNow()), {
        sql: `UPDATE workflow_steps SET ${compensating ? 'compensation_attempts' : 'attempts'}=${compensating ? 'compensation_attempts' : 'attempts'}+1,${compensating ? 'compensation_deadline_at' : 'deadline_at'}=?,status=? WHERE run_id=? AND step_id=?`,
        bindings: [deadline, compensating ? saved.status : 'executing', run.id, step.id], expectRows: 1,
      }, { sql: 'UPDATE workflow_runs SET status=? WHERE id=?', bindings: [compensating ? 'compensating' : step.kind === 'external' ? 'waiting_external' : 'running', run.id], expectRows: 1 }])
      const remaining = deadline - optionsNow()
      if (remaining <= 0) throw new ApiError(408, 'workflow.deadline_exceeded')
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([action.run(Object.freeze({ context, runId: run.id, input: JSON.parse(run.input_json), checkpoints: Object.fromEntries(rows.filter(s => s.checkpoint_json).map(s => [s.step_id, publicCheckpoint(s.checkpoint_json!)])), signal: controller.signal })), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ApiError(408, 'workflow.external_timeout')) }, Math.min(step.policy.timeoutMs, remaining))
      })]).finally(() => clearTimeout(timer))
      // No late response can checkpoint after the deadline or a newer runner's lease.
      if (optionsNow() >= deadline) throw new ApiError(408, 'workflow.deadline_exceeded')
      await this.finishStep(run, optionsNow(), step, compensating, result ?? null)
    } catch (error) {
      const time = optionsNow()
      if (error instanceof PermissionRevoked) { await this.transition(run, time, 'needs_attention', 'workflow.needs_attention', 'permission_revoked'); return }
      let code = error instanceof ApiError && ['workflow.external_timeout', 'workflow.deadline_exceeded', 'workflow.attempts_exhausted', 'rule_failed', 'workflow.external_not_configured', 'workflow.external_transport_failed', 'workflow.external_forbidden', 'workflow.external_rejected', 'workflow.external_invalid_receipt'].includes(error.code) ? error.code : 'workflow.step_failed'
      const uncertainCodes = ['workflow.external_timeout', 'workflow.external_transport_failed']
      const waitForDeadline = !compensating && step.kind === 'external' && time < deadline
        && count + 1 >= step.policy.maxAttempts
        && (count >= step.policy.maxAttempts || uncertainCodes.includes(code))
      if (waitForDeadline && count >= step.policy.maxAttempts) code = 'workflow.external_uncertain'
      // A missing response is not a rejection. Once the bounded delivery budget is
      // spent, retain the uncertainty until the deadline before cancelling it.
      const exhausted = !waitForDeadline && (count + 1 >= step.policy.maxAttempts || time >= deadline)
      const hasCompensation = definition.steps!.some((s, i) => s.compensate && (i === index || ['completed', 'executing'].includes(rows[i].status)))
      const status = compensating ? (exhausted ? 'needs_attention' : 'compensating') : exhausted ? (hasCompensation ? 'compensating' : 'failed') : step.kind === 'external' ? 'waiting_external' : 'running'
      const next = waitForDeadline ? (step.recover ? Math.min(deadline, time + Math.max(10000, step.policy.backoffMs)) : deadline) : Math.min(deadline, time + step.policy.backoffMs * 2 ** Math.min(count, 8))
      await this.transition({ ...run, status: compensating ? 'compensating' : run.status }, time, status, exhausted && compensating ? 'workflow.needs_attention' : 'workflow.step.failed', code, [
        { sql: 'UPDATE workflow_steps SET status=?,last_error_code=?,next_attempt_at=? WHERE run_id=? AND step_id=?', bindings: [!compensating && exhausted ? 'failed' : compensating ? saved.status : 'executing', code, next, run.id, step.id], expectRows: 1 },
        ...(exhausted && compensating ? [this.audit(scope, run.id, 'workflow.step.failed', step.id, code)] : []),
        ...(exhausted && !compensating ? [this.audit(scope, run.id, 'workflow.failed', step.id, code)] : []),
      ], step.id, exhausted ? time : next)
    }
  }
  private finishStep(run: Run, now: number, step: WorkflowStep, undo: boolean, result: unknown) {
    const checkpoint = undo ? 'compensation_checkpoint_json' : 'checkpoint_json'
    return this.transition(run, now, undo ? 'compensating' : 'running', undo ? 'workflow.step.compensated' : 'workflow.step.completed', undo ? run.last_error_code : null, [{
      // Keep the execution-owned policy receipt committed with an atomic effect.
      // The public return value has already stripped the affected-row metadata.
      sql: `UPDATE workflow_steps SET status=?,${checkpoint}=COALESCE(${checkpoint},?),last_error_code=NULL,next_attempt_at=0 WHERE run_id=? AND step_id=?`,
      bindings: [undo ? 'compensated' : 'completed', JSON.stringify(result), run.id, step.id], expectRows: 1,
    }], step.id)
  }
}
export async function runWorkflows(env: RuntimeEnv, config: InstanceConfig, definitions: WorkflowRegistry, options: { now?: number; limit?: number } = {}) {
  return new D1WorkflowRuntime(env, config, definitions).tick(options)
}
