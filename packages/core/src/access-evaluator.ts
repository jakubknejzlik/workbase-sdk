import type { EffectiveAccessPolicy, EffectiveEntityPolicy } from './access'
import type { Operation } from './config'
import type { Scope } from './types'
import type { TableFilter } from './kernel/plugin'
import { actorMembershipRole } from './policies'

/** Held-role grants form a union; an explicit `deny` for any held role wins.
 * `none` contributes no grant. Unknown roles fail closed. This union applies
 * only WITHIN one authority layer; credential and issuer layers intersect below.
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

/** Build authority once for every compiled-policy consumer. A session has one
 * layer; a credential and its live issuer have independent layers, even when
 * their role names match. A missing issuer contributes an empty, denying layer.
 * Operation-name allowlists remain an additional kernel check.
 */
export function effectiveAuthority(policy: EffectiveAccessPolicy, scope: Scope) {
  const principal = actorMembershipRole(scope)
  return effectiveAuthorityLayers(policy, scope.actor.type === 'agent'
    ? [[scope.role], principal ? [principal] : []] : [[scope.role]])
}
/** Each layer unions its held-role grants (explicit deny wins); every layer must
 * allow. Keep row, field, command and system composition on this same boundary.
 */
export function effectiveAuthorityLayers(policy: EffectiveAccessPolicy, layers: string[][]) {
  const grants = (entity: string, operation: Operation) => layers.map(roles => effectiveEntityGrants(policy, roles, entity, operation))
  const entityAllowed = (entity: string, operation: Operation) => layers.length > 0 && grants(entity, operation).every(rules => rules.length > 0)
  const systemAllowed = (action: string) => layers.length > 0 && layers.every(roles => effectiveSystemGrant(policy, roles, action))
  return {
    permits: (grant: { system: string } | { entity: string; operation: Operation }) => 'system' in grant
      ? systemAllowed(grant.system) : entityAllowed(grant.entity, grant.operation),
    fields(entity: string): string[] {
      const masks = grants(entity, 'read').map(rules => new Set(rules.flatMap(rule => rule.fields ?? [])))
      return [...(masks[0] ?? [])].filter(field => masks.every(mask => mask.has(field))).sort()
    },
    filter(entity: string, operation: Operation, compile: (rule: EffectiveEntityPolicy) => TableFilter): TableFilter {
      const filters = grants(entity, operation).map(rules => {
        const allowed = rules.map(compile)
        if (allowed.some(filter => filter.kind === 'all')) return { kind: 'all' } as const
        const predicates = allowed.flatMap(filter => filter.kind === 'where' ? [filter.predicate] : [])
        return predicates.length ? { kind: 'where', predicate: { any: predicates } } as const : { kind: 'none' } as const
      })
      if (!filters.length || filters.some(filter => filter.kind === 'none')) return { kind: 'none' }
      const predicates = filters.flatMap(filter => filter.kind === 'where' ? [filter.predicate] : [])
      return predicates.length ? { kind: 'where', predicate: { all: predicates } } : { kind: 'all' }
    },
  }
}
