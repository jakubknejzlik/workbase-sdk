import type { EffectiveAccessPolicy, EffectiveEntityPolicy } from './access'
import type { Operation } from './config'

/** Held-role grants form a union; an explicit `deny` for any held role wins.
 * `none` contributes no grant. Unknown roles fail closed. Credential operation
 * allowlists remain an independent check in the kernel authorization port.
 */
export function effectiveEntityGrants(policy: EffectiveAccessPolicy, roles: string[], entity: string, operation: Operation): EffectiveEntityPolicy[] {
  if (roles.some(role => !policy.roles.includes(role))) return []
  const rules = policy.entities.filter(rule => rule.entity === entity && rule.operation === operation && roles.includes(rule.role))
  return rules.some(rule => rule.decision === 'deny') ? [] : rules.filter(rule => rule.decision === 'allow')
}
const systemTargets: Record<string, string> = {
  members: 'memberships', invitations: 'invitations', tokens: 'access_tokens', organizations: 'organizations',
  audit: 'audit_events', workflows: 'workflow_runs',
}
export function effectiveSystemGrant(policy: EffectiveAccessPolicy, roles: string[], action: string): boolean {
  if (roles.some(role => !policy.roles.includes(role))) return false
  const rules = policy.system.filter(rule => roles.includes(rule.role) && rule.action === action)
  if (rules.some(rule => rule.decision === 'deny') || !rules.some(rule => rule.decision === 'allow')) return false
  return rules.some(rule => effectiveEntityGrants(policy, roles, rule.target.entity, rule.target.operation).length > 0)
}
export function systemAccessTarget(action: string): { entity: string; operation: Operation } {
  const [resource, verb] = action.split('.')
  const target = systemTargets[resource]
  const operation: Operation = ['create', 'accept'].includes(verb) ? 'create' : ['remove', 'revoke', 'leave'].includes(verb) ? 'delete' : verb === 'read' ? 'read' : 'update'
  return { entity: target, operation }
}
