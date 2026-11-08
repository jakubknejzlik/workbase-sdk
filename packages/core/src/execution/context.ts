import { copyActorProjection, loadActorProjection } from '../policies'
import { scopeOperations } from '../scope-operations'
import { operationName } from '../kernel/operation-name'
import { bindKernel } from '../kernel/registry'
import type { WorkflowRuntime } from './workflow'
// Internal adapter seam: deliberately not exported from the package entry point.
import type { InstanceConfig } from '../config'
import type { Scope } from '../identity'
import type { AtomicReader, AtomicStore, ExecutionContext } from './types'
import { PermissionRevoked } from './errors'
import { atomicPermission } from './permissions'
import type { AtomicOperation } from './types'
import { ApiError } from '../errors'
// Adapter-private capability, bound to one verified context and one declared undo.
const holdReleases = new WeakMap<ExecutionContext, AtomicOperation>()
export function holdReleaseContext(context: ExecutionContext, operation: AtomicOperation) {
  infrastructure(context)
  if (context.scope.actor.type !== 'service' || context.scope.actor.id !== 'system' || context.scope.role !== 'SYSTEM') throw new ApiError(403, 'permission_denied')
  holdReleases.set(context, operation)
  return context
}
export function authorizeAtomic(context: ExecutionContext, operation: AtomicOperation, input?: unknown, identity = operation) {
  const release = holdReleases.get(context)
  if (release) {
    if (release !== identity) throw new PermissionRevoked()
    return
  }
  atomicPermission(context.config, context.scope, operation, input)
}
const contexts = new WeakMap<ExecutionContext, { store: AtomicStore; reader: AtomicReader; workflowRuntime?: WorkflowRuntime; policyReceipt?: boolean }>()
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export function coreExecutionContext(config: InstanceConfig, scope: Scope, store: AtomicStore, reader: AtomicReader, idempotencyKey?: string, workflowRuntime?: WorkflowRuntime, options: { policyReceipt?: boolean } = {}): ExecutionContext {
  // Plugin hooks are trusted code, not cloneable execution data. The bound registry
  // retains them; execution snapshots contain only the immutable schema/config data.
  const { plugins: _plugins, ...data } = config
  const context = Object.freeze({ __proto__: null, config: freeze(structuredClone(data)), scope: Object.freeze({ ...scope, actor: Object.freeze({ ...scope.actor }) }), idempotencyKey,
    audit: Object.freeze({ instance_id: config.id, schema_version: config.revision, correlation_id: scope.correlationId }) }) as unknown as ExecutionContext
  const restriction = scopeOperations.get(scope)
  if (restriction) scopeOperations.set(context.scope, restriction)
  copyActorProjection(scope, context.scope)
  bindKernel(config, context.config)
  contexts.set(context, { store, reader, workflowRuntime, policyReceipt: options.policyReceipt })
  return context
}
export function infrastructure(context: ExecutionContext) {
  const value = contexts.get(context)
  if (!value) throw new ApiError(403, 'unverified_execution_context')
  return value
}

/** Every workflow step/retry must call this with its actual operation before effects.
 * Durable workflows use their persisted actor, independent of the browser session.
 * Membership removal, role loss, agent expiry/revocation -> non-retryable needs_attention.
 * No operation argument means preserving ALL grants of the saved role (conservative).
 */
export async function assertLivePermission(context: ExecutionContext, operation?: AtomicOperation): Promise<Scope> {
  const { reader } = infrastructure(context)
  const original = context.scope
  if (holdReleases.has(context)) {
    if (operation !== holdReleases.get(context)) throw new PermissionRevoked()
    return original
  }
  let role: string
  let operations: string[] | null = null
  if (original.actor.type === 'user') {
    const member = await reader.first<{ role: string }>({ sql: 'SELECT role FROM memberships WHERE user_id=? AND organization_id=?', bindings: [original.actor.id, original.organizationId] })
    if (!member) throw new PermissionRevoked()
    role = member.role
  } else if (original.actor.type === 'agent') {
    const token = await reader.first<{ role: string; operations: string | null }>({ sql: 'SELECT role,operations FROM access_tokens WHERE id=? AND organization_id=? AND revoked_at IS NULL AND expires_at>?', bindings: [original.actor.tokenId ?? original.actor.id, original.organizationId, new Date().toISOString()] })
    if (!token) throw new PermissionRevoked()
    role = token.role; operations = token.operations === null ? null : JSON.parse(token.operations)
  } else throw new PermissionRevoked()
  const scope = freeze({ ...original, actor: { ...original.actor }, role })
  scopeOperations.set(scope, { operations })
  await loadActorProjection(context.config, scope, (sql, bindings) => reader.first({ sql, bindings }))
  try {
    if (operation) {
      if (operations && !operations.includes(operationName(operation))) throw new PermissionRevoked()
      atomicPermission(context.config, scope, operation)
    } else {
      const previous = context.config.permissions[original.role] ?? {}
      const current = context.config.permissions[role] ?? {}
      for (const [entity, grants] of Object.entries(previous)) if (grants.some(grant => !current[entity]?.includes(grant))) throw new PermissionRevoked()
      for (const grant of context.config.organizationPermissions[original.role] ?? []) if (!context.config.organizationPermissions[role]?.includes(grant)) throw new PermissionRevoked()
      // Without an operation, a constrained agent cannot prove the step's allowlist membership.
      if (operations) throw new PermissionRevoked()
    }
    return scope
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw new PermissionRevoked()
    throw error
  }
}
