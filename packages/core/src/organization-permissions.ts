import { rbacRoles, hasActorProjection } from './policies'
import type { InstanceConfig, OrganizationAction } from './config'
import type { Scope } from './types'
import { ApiError } from './errors'

export const isOrganizationAdministrator = (config: InstanceConfig, role: string) => role === 'owner' || role === config.organizationOwnerRole
/** Shared by resource authorization, live token projection and role granting. */
export function roleNamePrivileges(role: string): ReadonlySet<string> {
  return new Set(role === 'owner' ? ['audit.read', 'workflows.resume', 'workflows.cancel'] : [])
}
/** Role-level authority; row policies, field masks and credential restrictions
 * are enforced separately. Prefixes keep entity and system grants disjoint.
 */
export function effectiveRolePrivileges(config: InstanceConfig, role: string): ReadonlySet<string> {
  if (!config.roles.includes(role)) return new Set()
  const privileges = new Set([
    ...roleNamePrivileges(role), ...(config.organizationPermissions[role] ?? []),
    // These resource operations are available to every configured membership role.
    'members.read', 'invitations.read', 'organizations.create', 'members.leave', 'invitations.accept', 'workflows.read',
  ].map(action => `system:${action}`))
  for (const [entity, operations] of Object.entries(config.permissions[role] ?? {})) {
    for (const operation of operations) privileges.add(`entity:${entity}:${operation}`)
  }
  return privileges
}
/** A grant may contain only effective privileges held by the issuer.
 * Policies and field masks remain independently enforced at execution time. Unknown
 * roles never authorize a grant, including an otherwise empty target role.
 */
export function canGrantRole(config: InstanceConfig, actorRole: string, targetRole: string): boolean {
  if (!config.roles.includes(actorRole) || !config.roles.includes(targetRole)) return false
  const issuer = effectiveRolePrivileges(config, actorRole)
  return [...effectiveRolePrivileges(config, targetRole)].every(privilege => issuer.has(privilege))
}
export function organizationPermission(config: InstanceConfig, scope: Scope, action: OrganizationAction) {
  if (scope.actor.type !== 'user' && !(scope.actor.type === 'agent' && ['invitations.create', 'invitations.read', 'invitations.revoke'].includes(action))) throw new ApiError(403, 'user_required')
  if (scope.actor.type === 'agent' && (!hasActorProjection(scope) || rbacRoles(scope).some(role => !config.roles.includes(role) || action !== 'invitations.read' && !config.organizationPermissions[role]?.includes(action)))) throw new ApiError(403, 'permission_denied')
  if ((action === 'members.read' || action === 'invitations.read') && config.roles.includes(scope.role)) return
  if (!Object.hasOwn(config.organizationPermissions, scope.role) || !config.organizationPermissions[scope.role].includes(action)) throw new ApiError(403, 'permission_denied')
}

/** Exactly the normalized authored and built-in roles; SQL has no fixed role enum. */
export function validateRole(config: Pick<InstanceConfig, 'roles'>, role: string, code = 'unknown_role', status: 400 | 403 = 400): string {
  if (!config.roles.includes(role)) throw new ApiError(status, code)
  return role
}
