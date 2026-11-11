import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import { policyFilter, readableFields, rbacRoles, hasOwnerRole } from '@workbasehq/core/policies'
import { allowed, type InstanceConfig, type Operation } from '@workbasehq/core/config'
import { ApiError } from '../../../core/src/errors'
import { organizationPermission, roleNamePrivileges } from './roles'
import type { KernelCommand, WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import type { Scope } from '../../../core/src/types'

/** Existing role decisions, kept together behind the authorization port. */
function check(config: InstanceConfig, scope: Scope, command: KernelCommand) {
  const permitted = (grant: { entity: string; operation: Operation }) => rbacRoles(scope).every(role => allowed(config, role, grant.entity, grant.operation))
  const grants = ['system' in command.permission ? undefined : command.permission, ...(command.additionalPermissions ?? [])].filter(Boolean) as { entity: string; operation: string }[]
  if (grants.some(grant => grant.operation !== 'read' && policyFilter(config, grant.entity, scope).kind === 'none')) throw new ApiError(403, 'permission_denied')
  if (command.kind === 'entity') {
    // Readers compile this deny-all predicate on every source. Missing grants
    // therefore mean an empty result, even for a live role absent from config.
    // Kernel credential/operation restrictions have already been checked.
    if (!('system' in command.permission) && command.permission.operation === 'read' && policyFilter(config, command.permission.entity, scope).kind === 'none') return
    if ('system' in command.permission || !permitted(command.permission)) throw new ApiError(403, 'permission_denied')
    return
  }
  if ('system' in command.permission) {
    const action = command.permission.system
    if (action === 'audit.read') {
      if (!hasOwnerRole(scope)) throw new ApiError(403, 'owner_required')
      return
    }
    if (action === 'workflows.read') return // Per-definition visibility is an additional reader check.
    if (action === 'workflows.resume' || action === 'workflows.cancel') {
      if (scope.actor.type !== 'user' || !roleNamePrivileges(scope.role).has(action)) throw new ApiError(403, 'owner_required')
      return
    }
    if (action === 'identity.write') {
      if (scope.actor.type !== 'service') throw new ApiError(403, 'permission_denied')
      return
    }
    if (scope.actor.type !== 'user' && !(scope.actor.type === 'agent' && ['invitations.create', 'invitations.read', 'invitations.revoke'].includes(action))) throw new ApiError(403, 'user_required')
    if (action !== 'organizations.create' && action !== 'members.leave' && action !== 'invitations.accept') organizationPermission(config, scope, action)
  } else {
    if (!config.commands.includes(command.name)) throw new ApiError(405, 'unsupported_command')
    if (!permitted(command.permission)) throw new ApiError(403, 'permission_denied')
  }
  for (const grant of command.additionalPermissions ?? []) {
    if (!permitted(grant)) throw new ApiError(403, 'permission_denied')
  }
}
/** Hooks are bound by the kernel to its complete, validated configuration. */
export const legacyPermissions: WorkbasePlugin = builtinPlugin({
  name: 'rbac', version: '0.1.0', provides: { permissions: '1.x' }, authorization: true,
  policyInConfig: true,
  tableFilter(entity, scope) { return policyFilter(this.config, entity, scope) },
  fieldMask(entity, scope) { return readableFields(this.config, entity, scope) },
  commandGuard(command, scope) {
    try { check(this.config, scope, command); return { allow: true } }
    catch (error) { if (error instanceof ApiError && error.status === 403) return { allow: false, code: error.code }; throw error }
  },
})
