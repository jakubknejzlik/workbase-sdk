import type { z } from 'zod'
import type { InstanceConfig, Operation, OrganizationAction } from '../config'
import type { Scope } from '../identity'
import type { AuditEvent } from '../audit-event'

export type SqlValue = string | number | null
export interface SqlStatement { sql: string; bindings?: readonly SqlValue[] }
/** Generated only by the execution policy pass; retained by serializing adapters. */
export interface PolicyWriteGuard {
  entity: string; where?: SqlStatement; filter: SqlStatement; operation: string
  protected?: SqlStatement; id?: SqlValue; requireRow?: boolean; mutation?: SqlStatement
}
export interface GuardedStatement extends SqlStatement {
  /** Outbox event committed by this statement; used only after batch success. */
  outboxEvent?: AuditEvent
  readonly policyGuard?: PolicyWriteGuard
  expectRows?: 1 | '>=1'
  /** Optional read-only diagnosis after rollback; never decides whether to commit. */
  diagnose?: SqlStatement
  /** Compatibility error when this statement's read-only diagnosis fails. */
  failureCode?: string
  database?: string
}
export interface AtomicRule { name: string; statements: readonly GuardedStatement[] }
export interface AtomicResult { status: number; body: Record<string, any> }
export interface EventDescription {
  operation: string; entity: string; entityId: string
  before?: Record<string, unknown>; after?: Record<string, unknown>
  /** Redacted effect receipt for operations spanning several rows. */
  details?: Record<string, unknown>
}
export interface AtomicPlan {
  rules: readonly AtomicRule[]
  result: AtomicResult
  event: EventDescription
  /** Only the adapter's primary database is supported. */
  databases?: readonly string[]
  remoteCall?: boolean
  dependsOnPriorWrite?: boolean
  /** Compatibility for existing HTTP rejection bodies. New operations use rule_failed. */
  conflict?: string
}
export interface StorePlan { runId: string; rules: readonly AtomicRule[] }
export interface RawOutcome { changes: readonly number[] }
/** One indivisible submission. No transaction handle or between-statement callbacks. */
export interface AtomicStore { run(plan: StorePlan): Promise<RawOutcome> }
export interface AtomicReader { first<T>(query: SqlStatement): Promise<T | null> }
declare const verifiedContext: unique symbol
/** Core adapters alone construct this after authentication and live membership resolution. */
export interface ExecutionContext {
  readonly [verifiedContext]: true
  readonly scope: Readonly<Scope>
  readonly config: InstanceConfig
  readonly idempotencyKey?: string
  readonly audit: Readonly<Pick<AuditEvent, 'instance_id' | 'schema_version' | 'correlation_id'>>
}
export interface PreparationContext extends ExecutionContext { readonly reader: AtomicReader }
export interface PlanningContext<Prepared = undefined> extends ExecutionContext {
  readonly prepared: Prepared
  readonly now: string
  readonly newId: string
}
/** Reusable rule functions have no store, promises or commit capability. */
export type Rule<Input, Prepared = undefined> = (ctx: PlanningContext<Prepared>, input: Input) => AtomicRule
export interface AtomicOperation<Schema extends z.ZodType = z.ZodType, Prepared = any> {
  name: string
  /** Public presentation only; never grants authority or changes execution. */
  ui?: { placement?: { entity: string; action: 'create' }; labelKey?: string; label?: string | { en: string; cs: string }; replacesCrud?: 'create' | 'update' | 'delete' }
  permission: { entity: string; operation: Operation } | { system: OrganizationAction | 'organizations.create' | 'members.leave' | 'invitations.accept' | 'identity.write' }
  additionalPermissions?: readonly { entity: string; operation: Operation }[]
  input: Schema
  idempotency?: 'required' | 'optional'
  /** Reads only, before planning. Every correctness dependency must be rechecked in SQL. */
  prepare?(ctx: PreparationContext, input: z.output<Schema>): Promise<Prepared>
  plan(ctx: PlanningContext<Prepared>, input: z.output<Schema>): AtomicPlan
}
