import { needsPolicyReceipt, receiptIdentity, receiptExpression, authorizeReplay } from './policy-receipts'
import { kernelFor } from '../kernel/registry'
import { loadActorProjection } from '../policies'
import { enforcePlan } from './policies'
import { z } from 'zod'
import { ApiError } from '../errors'
import { makeEvent } from '../audit-event'
import { outboxInsert } from './outbox'
import { requestHash } from '../idempotency'
import { infrastructure, authorizeAtomic } from './context'
import { memberManagementMode } from '../organizations'
import { validatePlan, compile } from './compiler'
import { RuleFailed } from './errors'
import type { AtomicOperation, AtomicResult, ExecutionContext, StorePlan } from './types'

export function defineAtomicOperation<S extends z.ZodType, P = undefined>(operation: AtomicOperation<S, P>): AtomicOperation<S, P> {
  if (!/^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)+$/.test(operation.name)) throw new Error('Invalid command name')
  return operation
}
export async function executeAtomic<S extends z.ZodType>(operation: AtomicOperation<S>, input: unknown, context: ExecutionContext): Promise<AtomicResult> {
  // Bind route authority and permission to this request before any await or
  // command callback. Later mutations of the caller's operation cannot upgrade it.
  const identity = operation
  const memberMode = memberManagementMode(context, identity)
  operation = Object.freeze({ ...operation, permission: Object.freeze({ ...operation.permission }),
    additionalPermissions: operation.additionalPermissions && Object.freeze(operation.additionalPermissions.map(grant => Object.freeze({ ...grant }))) })
  const { store, reader, policyReceipt } = infrastructure(context)
  const { config, scope, idempotencyKey: key } = context
  await loadActorProjection(config, scope, (sql, bindings) => reader.first({ sql, bindings }))
  authorizeAtomic(context, operation, input, identity)
  const kernel = kernelFor(config)
  const policyIdentity = policyReceipt || needsPolicyReceipt(kernel) ? await receiptIdentity(config, scope) : undefined
  const keySchema = operation.idempotency === 'required' ? z.string().min(1).max(128) : z.string().min(1).max(128).optional()
  keySchema.parse(key)
  const body = operation.input.parse(input)
  const hash = key ? await requestHash(operation.name, body) : undefined
  async function replay(): Promise<AtomicResult | null> {
    if (!key) return null
    const row = await reader.first<{ command: string; request_hash: string | null; response_json: string }>({ sql: 'SELECT command,request_hash,response_json FROM idempotency_keys WHERE organization_id=? AND key=?', bindings: [scope.organizationId, key] })
    if (!row) return null
    if (row.command !== operation.name || row.request_hash !== hash) throw new ApiError(422, 'idempotency_payload_mismatch')
    return authorizeReplay(kernel, scope, reader, row.response_json, policyIdentity)
  }
  const prior = await replay()
  if (prior) return prior
  let conflict: string | undefined
  try {
    const prepared = await operation.prepare?.(Object.freeze({ __proto__: null, ...context, reader: Object.freeze({ __proto__: null, first: <T>(query: Parameters<typeof reader.first>[0]) => reader.first<T>(query) }) }), body)
    const rawPlan = operation.plan(Object.freeze({ __proto__: null, ...context, prepared, now: new Date().toISOString(), newId: crypto.randomUUID() }), body)
    validatePlan(rawPlan)
    const plan = enforcePlan(kernelFor(config), scope, rawPlan, memberMode)
    conflict = plan.conflict
    const event = makeEvent(config, scope, plan.event.operation, plan.event.entity, plan.event.entityId, plan.event.before, plan.event.after, plan.event.details)
    const runId = crypto.randomUUID()
    const response = policyIdentity ? receiptExpression(config, plan.rules, runId, plan.result, policyIdentity) : { sql: '?', bindings: [JSON.stringify(plan.result)] }
    const submission: StorePlan = { runId, rules: [...plan.rules,
      { name: 'audit_outbox', statements: [outboxInsert(event, { sql: 'NOT EXISTS (SELECT 1 FROM atomic_assert WHERE run_id=? AND ok<>1)', bindings: [runId] })] },
      ...(key ? [{ name: 'idempotency_key', statements: [{ sql: `INSERT INTO idempotency_keys (organization_id,key,command,response_json,request_hash) SELECT ?,?,?,${response.sql},? WHERE changes()=1`, bindings: [scope.organizationId, key, operation.name, ...(response.bindings ?? []), hash!], expectRows: 1 as const }] }] : []),
    ] }
    // Validate for every adapter, including capability markers and SQL shape.
    compile(submission)
    await store.run(submission)
    return plan.result
  } catch (error) {
    const winner = await replay()
    if (winner) return winner
    if (error instanceof RuleFailed && conflict) throw new RuleFailed(error.rule, conflict)
    throw error
  }
}
