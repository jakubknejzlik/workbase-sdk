import { rbacRoles } from './policies'
import type { InstanceConfig, OrganizationAction } from './config'
import { canGrantRole } from './execution/permissions'
import type { Scope } from './identity'
import type { AtomicRule, SqlStatement } from './execution/types'
import { clearAccountLinks } from './user-links'

export function issuerGuard(config: InstanceConfig, scope: Scope, action: OrganizationAction | undefined, grantRole?: string, roleFilter: (role: string) => boolean = () => true) {
  const roles = config.roles.filter(role => action === undefined || config.organizationPermissions[role]?.includes(action))
    .filter(role => grantRole === undefined || canGrantRole(config, role, grantRole))
    .filter(roleFilter)
  if (scope.actor.type === 'agent') {
    return { sql: `EXISTS (SELECT 1 FROM access_tokens credential JOIN memberships issuer ON issuer.organization_id=credential.organization_id AND issuer.user_id=credential.issuer_id
      WHERE credential.id=? AND credential.organization_id=? AND credential.role=? AND credential.revoked_at IS NULL AND credential.expires_at>?
        AND issuer.role=? AND issuer.role IN (${roles.map(() => '?').join(',') || 'NULL'}))`,
      values: [scope.actor.tokenId ?? scope.actor.id, scope.organizationId, scope.role, new Date().toISOString(), rbacRoles(scope).at(-1)!, ...roles] }
  }
  return { sql: `EXISTS (SELECT 1 FROM memberships issuer WHERE issuer.organization_id=? AND issuer.user_id=? AND issuer.role IN (${roles.map(() => '?').join(',') || 'NULL'}))`, values: [scope.organizationId, scope.actor.id, ...roles] }
}
/** Each gate raises an SQL assertion before any later membership, email or audit write. */
export function organizationRule(name: string, ...statements: SqlStatement[]): AtomicRule {
  return { name, statements: statements.map(statement => ({ ...statement, expectRows: 1 })) }
}
export function memberMutationRule(config: InstanceConfig, scope: Scope, userId: string, role: string | null, remove: boolean, leave: boolean): AtomicRule {
  const guard = leave ? { sql: '1', values: [] } : issuerGuard(config, scope, remove ? 'members.remove' : 'members.update', remove ? undefined : role!)
  const predicate = `organization_id=? AND user_id=? AND (role<>? OR ?=? OR (SELECT count(*) FROM memberships owners WHERE owners.organization_id=? AND owners.role=?)>1) AND ${guard.sql}`
  const values = [scope.organizationId, userId, config.organizationOwnerRole, role, config.organizationOwnerRole, scope.organizationId, config.organizationOwnerRole, ...guard.values]
  return { name: 'last_owner', statements: [{
    sql: remove ? `DELETE FROM memberships WHERE ${predicate}` : `UPDATE memberships SET role=? WHERE ${predicate}`,
    bindings: remove ? values : [role, ...values], expectRows: 1,
    diagnose: { sql: `SELECT EXISTS (SELECT 1 FROM memberships WHERE ${predicate}) AS ok`, bindings: values },
  }, ...(remove ? clearAccountLinks(config, scope, userId) : [])] }
}
