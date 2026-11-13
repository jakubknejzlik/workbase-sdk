import { effectiveAuthority } from './access-evaluator'
import { constantQuantifier } from './config-shorthand'
import { z } from 'zod'
import { baseFields, type Field, type InstanceConfig } from './config'
import { fieldsFor, fieldType, filterSchema, type Filter } from './query/schema'
import type { Predicate, PredicateActorLink, PredicateOperators, TableFilter } from './kernel/plugin'
import type { Scope } from './types'
import { ApiError } from './errors'
import { roleNamePrivileges } from './organization-permissions'
import { quote } from './migrations/schema'
import { kernelFor } from './kernel/registry'

type ActorRow = Record<string, string | number | boolean | null>
export interface ActorMembership { user_id: string; organization_id: string; role: string }
const projections = new WeakMap<Scope, Readonly<ActorRow>>()
const protectedByConfig = new WeakMap<InstanceConfig, ReadonlySet<string>>()
export function actorFields(config: InstanceConfig): Record<string, Field['type']> {
  return { ...Object.fromEntries(config.account ? fieldsFor(config, config.account.entity).filter(name => !config.entities[config.account!.entity].fields[name]?.computed).map(name => [name, fieldType(config, config.account!.entity, name)]) : []), id: 'string', role: 'string', organization_id: 'string' }
}
export function validatePolicies(config: InstanceConfig) {
  const fields = actorFields(config); const protectedFields = new Set<string>(config.account?.assignments ?? [])
  const actorValue = (type: Field['type']) => z.string().refine(value => {
    if (!value.startsWith('$actor.')) return false
    const field = value.slice(7)
    return Object.hasOwn(fields, field) && (fields[field] === type || (['string', 'ref', 'enum', 'text', 'datetime'].includes(type) && ['string', 'ref', 'enum', 'text', 'datetime'].includes(fields[field])))
  }, 'Unknown or incompatible $actor field')
  function visit(value: unknown, depth = 0) {
    if (depth > 32) throw new Error('Policy depth exceeds budget')
    if (typeof value === 'string' && value.startsWith('$actor.')) {
      const name = value.slice(7)
      if (!Object.hasOwn(fields, name)) throw new Error(`Unknown $actor field: ${name}`)
      protectedFields.add(name)
    } else if (value && typeof value === 'object') Object.values(value).forEach(child => visit(child, depth + 1))
  }
  function storedPolicyFields(entity: string, where: Record<string, unknown>): void {
    for (const [field, operand] of Object.entries(where)) {
      if (field === 'and' || field === 'or') { if (Array.isArray(operand)) operand.forEach(child => storedPolicyFields(entity, child)); continue }
      if (field === 'not') { if (operand && typeof operand === 'object') storedPolicyFields(entity, operand as Record<string, unknown>); continue }
      const relation = config.entities[entity].relations[field]
      if (relation && operand && typeof operand === 'object') {
        const source = relation.many ? relation.entity : entity
        if (config.entities[source].fields[relation.field]?.computed) throw new Error(`Row policy cannot traverse computed ref: ${source}.${relation.field}. Fix: use a stored ref to establish row access.`)
        const child = relation.many ? Object.values(operand)[0] : operand
        if (child && typeof child === 'object') storedPolicyFields(relation.entity, child as Record<string, unknown>)
      } else if (config.entities[entity].fields[field]?.computed) throw new Error(`Row policy cannot depend on computed field: ${entity}.${field}. Fix: use stored fields to establish row access before computing values.`)
    }
  }
  const policies: (readonly [string, InstanceConfig['policies'][string]])[] = config.effectiveAccess ? config.effectiveAccess.entities.filter(rule => config.entities[rule.entity] && rule.decision === 'allow').map(rule => [rule.entity, { [rule.role]: { where: rule.where, fields: rule.fields ?? undefined } }] as const) : Object.entries(config.policies)
  if (config.effectiveAccess) policies.push(...config.effectiveAccess.actions.flatMap(action => action.conditions.map(condition => [action.entity, { [config.roles[0]]: { where: condition.when, fields: undefined } }] as const)))
  for (const [entity, roles] of policies) {
    if (!Object.hasOwn(config.entities, entity)) throw new Error(`Unknown policy entity: ${entity}`)
    for (const [role, policy] of Object.entries(roles)) {
      if (!config.roles.includes(role)) throw new Error(`Unknown policy role: ${role}`)
      if (typeof policy === 'string') continue
      visit(policy.where)
      storedPolicyFields(entity, policy.where)
      // Validate references separately: a string operand must not accept an unknown actor name as a literal.
      filterSchema(config, false, 4, actorValue)(entity, 0).parse(policy.where)
      if (policy.fields?.some((field: string) => !fieldsFor(config, entity).includes(field))) throw new Error(`Unknown policy field: ${entity}`)
    }
  }
  protectedByConfig.set(config, protectedFields)
}
export function protectedActorFields(config: InstanceConfig): ReadonlySet<string> {
  if (!protectedByConfig.has(config)) validatePolicies(config)
  return protectedByConfig.get(config)!
}
/** Only server adapters call this. Scope resolution may pass its freshly verified
 * membership; executions without that projection always reload live authority. */
export async function loadActorProjection(config: InstanceConfig, scope: Scope, first: <T>(sql: string, bindings: (string | number | null)[]) => Promise<T | null>, membership?: Readonly<ActorMembership>) {
  projections.delete(scope)
  if (scope.actor.type === 'service') return
  let accountId = scope.actor.id
  if (scope.actor.type === 'agent') {
    const token = await first<{ issuer_id: string }>('SELECT issuer_id FROM access_tokens WHERE id=? AND organization_id=? AND revoked_at IS NULL AND expires_at>?', [scope.actor.tokenId ?? scope.actor.id, scope.organizationId, new Date().toISOString()])
    if (!token) return
    accountId = token.issuer_id
  }
  const member = scope.actor.type === 'user' && membership?.user_id === accountId && membership.organization_id === scope.organizationId
    ? membership : await first<ActorMembership>('SELECT * FROM memberships WHERE user_id=? AND organization_id=?', [accountId, scope.organizationId])
  if (!member) return
  const extension = config.account ? await first<ActorRow>(`SELECT ${fieldsFor(config, config.account.entity).filter(name => !config.entities[config.account!.entity].fields[name]?.computed).map(quote).join(',')} FROM ${quote(config.account.entity)} WHERE id=? AND organization_id=?`, [accountId, scope.organizationId]) : {}
  if (!extension) return // Unmapped accounts are deny-all, even for a named membership role.
  const row: ActorRow = { ...extension, id: accountId, role: member.role, organization_id: scope.organizationId }
  for (const [field, definition] of Object.entries(config.account ? config.entities[config.account.entity].fields : {})) if (definition.type === 'bool' && row[field] !== null) row[field] = Boolean(row[field])
  // Extension role is application data; memberships remain the authority for the active role.
  projections.set(scope, Object.freeze(row))
}
export function actorAccountId(scope: Scope): string { return String(projections.get(scope)?.id ?? scope.actor.id) }
export function copyActorProjection(source: Scope, target: Scope) { const row = projections.get(source); if (row) projections.set(target, row) }
function actorLinkProjection(scope: Scope): Omit<PredicateActorLink, 'entity'> | undefined {
  const actor = projections.get(scope)
  return actor ? {
    organizationId: scope.organizationId, accountId: String(actor.id), membershipRole: String(actor.role),
    ...(scope.actor.type === 'agent' ? { token: { id: scope.actor.tokenId ?? scope.actor.id, role: scope.role } } : {}),
  } : undefined
}
/** Constant folding and missing operands must not erase authority reachable via
 * a related policy: that FALSE source can itself be used beneath none/not. */
function policyGraphUsesActorLinks(config: InstanceConfig, entity: string, roles: string[]): boolean {
  const visited = new Set<string>()
  function policy(name: string): boolean {
    if (visited.has(name)) return false
    visited.add(name)
    return roles.some(role => {
      const entry = config.policies[name]?.[role]
      return typeof entry === 'object' && filter(name, entry.where)
    })
  }
  function filter(name: string, where: Filter): boolean {
    return Object.entries(where).some(([key, value]) => {
      if (key === 'actorLinkedIn') return true
      if (key === 'and' || key === 'or') return (value as Filter[]).some(child => filter(name, child))
      if (key === 'not') return filter(name, value as Filter)
      const relation = config.entities[name].relations[key]
      return !!relation && (policy(relation.entity) || filter(relation.entity, (relation.many ? Object.values(value as Record<string, Filter>)[0] : value) as Filter))
    })
  }
  return policy(entity)
}
export function rolePolicyFilter(config: InstanceConfig, entity: string, scope: Scope, role: string, authored?: InstanceConfig['policies'][string][string]): TableFilter {
  if (scope.actor.type === 'service' && scope.role === 'SYSTEM') return { kind: 'all' }
  const actor = projections.get(scope)
  if ((config.account || scope.actor.type === 'agent') && !actor) return { kind: 'none' }
  const policy = authored ?? config.policies[entity]?.[role] ?? 'none'
  if (policy === 'all') return { kind: 'all' }
  if (policy === 'none') return { kind: 'none' }
  if (!Object.keys(policy.where).length && policy.deny !== 'forbidden') return { kind: 'all' }
  if (!actor && JSON.stringify(policy.where).includes('$actor.')) return { kind: 'none' }
  function missingOperand(value: unknown): boolean {
    if (typeof value === 'string' && value.startsWith('$actor.')) return actor?.[value.slice(7)] == null
    return !!value && typeof value === 'object' && Object.values(value).some(missingOperand)
  }
  // Deny the complete policy before Boolean composition: replacing one comparison
  // by FALSE would become TRUE under NOT / none and could widen an OR branch.
  // Keep a predicate so writes assert the same FALSE pre/post-image in the batch.
  if (missingOperand(policy.where)) return { kind: 'where', predicate: { any: [] }, ...(policy.deny === 'forbidden' ? { deny: 'forbidden' as const } : {}) }
  function substitute(value: unknown): any {
    if (typeof value === 'string' && value.startsWith('$actor.')) return actor![value.slice(7)] ?? null
    return Array.isArray(value) ? value.map(substitute) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child)])) : value
  }
  const predicate = compilePolicyPredicate(config, entity, policy.where, substitute, actorLinkProjection(scope))
  if (constantPredicate(predicate) === false) return { kind: 'none', ...(policy.deny === 'forbidden' ? { deny: 'forbidden' as const } : {}) }
  return { kind: 'where', predicate, ...(policy.deny === 'forbidden' ? { deny: 'forbidden' as const } : {}) }
}
function compilePolicyPredicate(config: InstanceConfig, name: string, filter: Filter, substitute: (value: unknown) => unknown, actorLink?: Omit<PredicateActorLink, 'entity'>): Predicate {
  function compile(name: string, filter: Filter): Predicate {
    return { all: Object.entries(filter).map(([key, value]): Predicate => {
      if (key === 'and' || key === 'or') return { [key === 'and' ? 'all' : 'any']: (value as Filter[]).map(child => compile(name, child)) } as Predicate
      if (key === 'not') return { not: compile(name, value as Filter) }
      if (key === 'actorLinkedIn') {
        if (!actorLink) throw new Error('actorLinkedIn requires a live actor projection')
        return { actorLinkedIn: { ...actorLink, entity: value as string } }
      }
      const relation = config.entities[name].relations[key]
      if (relation) {
        const none = relation.many && Object.hasOwn(value as object, 'none')
        return { [none ? 'notExists' : 'exists']: { entity: relation.entity, field: relation.many ? relation.field : 'id', parentField: relation.many ? 'id' : relation.field,
          predicate: compile(relation.entity, (relation.many ? (value as Record<string, Filter>)[none ? 'none' : 'some'] : value) as Filter) } } as Predicate
      }
      const operators = substitute(value) as PredicateOperators
      return { [key]: operators }
    }) }
  }
  return compile(name, filter)
}
/** Fold only Boolean constants; no database state is inferred by capability metadata. */
function constantPredicate(node: Predicate): boolean | undefined {
  const entries = Object.entries(node)
  if (entries.length === 1 && ['all', 'any'].includes(entries[0][0]) && Array.isArray(entries[0][1])) {
    const [key, children] = entries[0] as ['all' | 'any', Predicate[]]
    const values = children.map(constantPredicate)
    if (key === 'all') return values.includes(false) ? false : values.every(value => value === true) ? true : undefined
    return values.includes(true) ? true : values.every(value => value === false) ? false : undefined
  }
  if (entries.length === 1 && entries[0][0] === 'not') {
    const value = constantPredicate(entries[0][1] as Predicate)
    return value === undefined ? undefined : !value
  }
  if (entries.length === 1 && (entries[0][0] === 'exists' || entries[0][0] === 'notExists')) {
    return constantQuantifier(entries[0][0] === 'notExists', constantPredicate(entries[0][1].predicate))
  }
  if (entries.some(([, operators]) => operators && Array.isArray(operators.in) && !operators.in.length)) return false
  return undefined
}
/** A token's live role caps its issuer's live membership; it cannot outlive a role loss. */
export const hasActorProjection = (scope: Scope) => projections.has(scope)
export const actorMembershipRole = (scope: Scope): string | undefined => {
  const role = projections.get(scope)?.role
  return role === undefined ? undefined : String(role)
}
export function rbacRoles(scope: Scope): string[] {
  const principal = projections.get(scope)?.role
  return principal && principal !== scope.role ? [scope.role, String(principal)] : [scope.role]
}
/** System audit access requires an owner credential and a live owner issuer. */
export function hasOwnerRole(scope: Scope, config?: InstanceConfig): boolean {
  if (config?.effectiveAccess) return (scope.actor.type !== 'agent' || projections.has(scope)) && effectiveAuthority(config.effectiveAccess, scope).permits({ system: 'audit.read' })
  return (scope.actor.type !== 'agent' || projections.has(scope)) && rbacRoles(scope).every(role => roleNamePrivileges(role).has('audit.read'))
}
export function policyFilter(config: InstanceConfig, entity: string, scope: Scope, operation: import('./config').Operation = 'read'): TableFilter {
  if (config.effectiveAccess) {
    if (scope.actor.type === 'service' && scope.role === 'SYSTEM') return { kind: 'all' }
    const filter = effectiveAuthority(config.effectiveAccess, scope).filter(entity, operation,
      rule => rolePolicyFilter(config, entity, scope, rule.role, { where: rule.where }))
    const authority = actorLinkProjection(scope)
    return { ...filter, actorAuthorities: authority ? [authority] : [] }
  }
  const roles = rbacRoles(scope)
  const filters = roles.map(role => rolePolicyFilter(config, entity, scope, role))
  const where = filters.filter((filter): filter is Extract<TableFilter, { kind: 'where' }> => filter.kind === 'where')
  const result: TableFilter = filters.some(filter => filter.kind === 'none')
    ? { kind: 'none', ...(filters.some(filter => 'deny' in filter && filter.deny === 'forbidden') ? { deny: 'forbidden' as const } : {}) }
    : where.length ? { kind: 'where', predicate: { all: where.map(filter => filter.predicate) }, ...(where.some(filter => filter.deny === 'forbidden') ? { deny: 'forbidden' as const } : {}) } : { kind: 'all' }
  const authority = actorLinkProjection(scope)
  // Collect from the complete configured graph before Boolean folding, operand
  // denial or the role intersection can erase a related source. All requirements
  // use this request's organization and principal, so hoisting is row-independent
  // even beneath none/not/every and across different effective roles.
  return authority && policyGraphUsesActorLinks(config, entity, roles) ? { ...result, actorAuthorities: [authority] } : result
}
export function readableFields(config: InstanceConfig, entity: string, scope: Scope): string[] {
  if (config.effectiveAccess) return effectiveAuthority(config.effectiveAccess, scope).fields(entity)
  return [...baseFields, ...Object.keys(config.entities[entity].fields)].filter(field => rbacRoles(scope).every(role => {
    const policy = config.policies[entity]?.[role]
    const allow = typeof policy === 'object' ? policy.fields : undefined
    // Stable cursors and relation assembly require id whenever a role grants fields.
    return (!allow || allow.includes(field) || (field === 'id' && allow.length > 0)) && (!config.entities[entity].fields[field]?.sensitive || role === 'owner' || role === 'administrator' || !!allow?.includes(field))
  }))
}
/** Declared account assignments only; this never grants membership-management authority. */
export function canManageAccountAssignments(config: InstanceConfig, scope: Scope, fields: string[]): boolean {
  const actor = projections.get(scope)
  return kernelFor(config).permissionsActive && scope.actor.type === 'user'
    && actor?.id === scope.actor.id && actor.organization_id === scope.organizationId && actor.role === scope.role
    && !!config.account?.managedBy?.includes(scope.role)
    && fields.every(field => config.account?.assignments?.includes(field))
}
export function assertActorFields(config: InstanceConfig, scope: Scope, entity: string, fields: string[], targetId?: string) {
  if (scope.actor.type === 'service' || entity !== config.account?.entity) return
  const assigned = fields.filter(field => protectedActorFields(config).has(field))
  if (!assigned.length) return
  // Account assignments only; authoritative membership changes retain the private owner path.
  if (canManageAccountAssignments(config, scope, assigned) && targetId !== undefined && targetId !== actorAccountId(scope)) return
  throw new ApiError(403, 'field_forbidden')
}
/** Private receipt identity; callers hash it, never serialize it into a surface. */
export function actorPolicyIdentity(config: InstanceConfig, scope: Scope) {
  const actor = projections.get(scope)
  return { principal: actorAccountId(scope), credential: scope.actor, role: scope.role, organization: scope.organizationId,
    attributes: Object.fromEntries([...protectedActorFields(config)].map(field => [field, actor?.[field] ?? null])) }
}
/** Conservative entity-level write metadata; row ownership still gates each mutation. */
export function writableFields(config: InstanceConfig, entity: string, scope: Scope): string[] {
  return Object.entries(config.entities[entity].fields).filter(([field, definition]) => !definition.readOnly &&
    !(entity === config.account?.entity && protectedActorFields(config).has(field))).map(([field]) => field)
}

/** Internal differential-test seam: uses the production compiler without actor substitution. */
export const policyFoldTest = {
  compile: (config: InstanceConfig, entity: string, filter: Filter): Predicate => compilePolicyPredicate(config, entity, filter, value => value),
  constantPredicate,
}
