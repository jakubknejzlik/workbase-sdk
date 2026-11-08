import { ApiError } from '../errors'
export class UnsupportedAtomicOperation extends ApiError {
  constructor(reason: string) { super(422, 'unsupported_atomic_operation', reason); this.name = 'UnsupportedAtomicOperation' }
}
export class RuleFailed extends ApiError {
  readonly diagnosis = 'best_effort' as const
  constructor(public rule: string, compatibilityCode?: string) {
    super(409, compatibilityCode ?? 'rule_failed')
    this.name = 'RuleFailed'
  }
}
export class WorkflowRuntimeNotConfigured extends ApiError {
  constructor() { super(503, 'workflow_runtime_not_configured'); this.name = 'WorkflowRuntimeNotConfigured' }
}

/** Durable engines must stop ordinary retries and persist this disposition. */
export class PermissionRevoked extends ApiError {
  readonly workflowStatus = 'needs_attention' as const
  readonly retryable = false
  constructor() { super(403, 'permission_revoked'); this.name = 'PermissionRevoked' }
}
