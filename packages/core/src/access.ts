import { accountActions, type AccountCondition } from './account-action-conditions'
import { workerAccessCommands } from './worker-access-actions'
import { accessGuards } from './access-guards'
import { userLinks } from './user-link-fields'
import { userLinkCommands } from './user-links'
import type { AtomicOperation } from './execution/types'
import { systemAccessTarget } from './access-evaluator'
import { z } from 'zod'
import { baseFields, organizationActions, reservedEntities, type InstanceConfig, type Operation } from './config'
import { DeclarationError } from './schema/declaration'
import { validatePolicies } from './policies'
import type { Filter } from './query/schema'

export const accessOperations = ['read', 'create', 'update', 'delete'] as const
export const accessEntities = [...reservedEntities, 'atomic_assert', 'workflow_runs', 'workflow_steps', 'workflow_holds', '_ops_relay_run', '_migrations', 'identity_profiles', 'organization_scopes'].sort()
export const accessSystemActions = [...organizationActions, 'audit.read', 'workflows.read', 'workflows.resume', 'workflows.cancel',
  'organizations.create', 'members.leave', 'invitations.accept'].sort()
const decision = z.enum(['allow', 'none', 'deny'])
const grant = z.union([decision, z.strictObject({ where: z.record(z.string(), z.unknown()), fields: z.array(z.string()).optional() })])
export const entityAccessSchema = z.record(z.string(), z.union([z.literal('deny'), z.literal('none'), z.strictObject({
  read: grant, create: grant, update: grant, delete: grant,
})]))
const sharedSchema = z.strictObject({
  roles: z.record(z.string(), z.strictObject({ system: z.record(z.string(), decision) })),
  entities: z.record(z.string(), entityAccessSchema),
  predicates: z.record(z.string(), z.record(z.string(), z.unknown())),
  accountLinks: z.record(z.string(), z.strictObject({ invitationRole: z.string() })).optional(),
})
export type EntityAccess = z.input<typeof entityAccessSchema>
export type AccessInput = z.input<typeof sharedSchema>
export function defineAccess(input: AccessInput): AccessInput {
  const result = sharedSchema.safeParse(input)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new DeclarationError(issue.path.map(String), issue.message)
  }
  return result.data
}
export interface EffectiveEntityPolicy {
  entity: string
  role: string
  operation: Operation
  decision: 'allow' | 'none' | 'deny'
  where: Filter
  /** Read projection; null for mutations and SDK resources without a schema. */
  fields: string[] | null
  predicates: string[]
  dependencies: string[]
  /** Stable source-map key; loadConfig returns its file:line location separately. */
  source: string
}
/** Normalized grants shared by execution and audit; other runtime/config inputs
 * are audited separately as enforcementInputs. Execution consumes these exact rules.
 * Arrays and object keys are canonical; no functions, implicit grants or host paths.
 */
export interface EffectiveRecordAction {
  entity: string; name: string; command: string
  conditions: ({ when: Filter; reason: string } | AccountCondition)[]
  dependencies: string[]
  source: string
}
export interface EffectiveAccessPolicy {
  version: 1
  roles: string[]
  accountLinks?: Record<string, { invitationRole: string }>
  actions: EffectiveRecordAction[]
  entities: EffectiveEntityPolicy[]
  guards: { name: string; permission: AtomicOperation['permission'] | null; additionalPermissions: AtomicOperation['permission'][]; opaque: true }[]
  opaqueHooks: string[]
  system: { role: string; action: string; decision: 'allow' | 'none' | 'deny'; target: { entity: string; operation: Operation }; source: string }[]
}
const sorted = (values: Iterable<string>) => [...new Set(values)].sort()
function canonical(value: unknown): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value
}
export const ACCESS_EXPANSION_LIMITS = { depth: 16, size: 512 } as const
export function compileAccess(config: InstanceConfig, declarations: Record<string, EntityAccess | undefined>, input: AccessInput): EffectiveAccessPolicy {
  const roles = sorted(config.roles)
  const error = (source: string, message: string): never => { throw new DeclarationError(source.split('.'), message) }
  const known = sorted([...accessEntities, ...Object.keys(config.entities)])
  for (const role of Object.keys(input.roles)) if (!roles.includes(role)) error(`access.roles.${role}`, `Unknown access role: ${role}`)
  for (const entity of Object.keys(input.entities)) if (!accessEntities.includes(entity)) error(`access.entities.${entity}`, `Entity ${entity} must declare access in schema/${entity}.ts`)
  const result: EffectiveAccessPolicy = { version: 1, roles, actions: [], entities: [], system: [], guards: [], opaqueHooks: [] }
  function expand(value: unknown, source: string, names: Set<string>, stack: string[] = [], depth = 0, budget = { size: 0 }): any {
    if (depth > ACCESS_EXPANSION_LIMITS.depth || ++budget.size > ACCESS_EXPANSION_LIMITS.size) error(source, 'Predicate expansion exceeds depth/size budget')
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'use')) {
      const name = (value as { use: unknown }).use
      if (typeof name !== 'string' || !Object.hasOwn(input.predicates, name)) error(source, `Unknown predicate: ${String(name)}`)
      if (Object.keys(value).length !== 1) error(source, 'A predicate use must be its own literal object')
      if (stack.includes(name as string)) error(`access.predicates.${name}`, `Predicate cycle: ${[...stack, name].join(' -> ')}`)
      names.add(name as string)
      return expand(input.predicates[name as string], `access.predicates.${name}`, names, [...stack, name as string], depth + 1, budget)
    }
    if (Array.isArray(value)) return value.map(child => expand(child, source, names, stack, depth + 1, budget))
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, source, names, stack, depth + 1, budget)])) : value
  }
  // Unused named predicates are still authored data, so unknown names/cycles/size fail.
  for (const name of sorted(Object.keys(input.predicates))) expand({ use: name }, `access.predicates.${name}`, new Set())
  for (const entity of known) {
    const system = accessEntities.includes(entity)
    const source = system ? `access.entities.${entity}` : `entities.${entity}.access`
    const matrix = system ? input.entities[entity] : declarations[entity]
    for (const role of Object.keys(matrix ?? {})) if (!roles.includes(role)) error(`${source}.${role}`, `Unknown access role: ${role}`)
    for (const role of roles) {
      if (!matrix || !Object.hasOwn(matrix, role)) error(source, `Missing access entry for role ${role}, entity ${entity}`)
      for (const operation of accessOperations) {
        const entry = matrix![role]
        const authored = typeof entry === 'string' ? entry : entry[operation]
        if (operation !== 'read' && typeof authored === 'object' && authored.fields) error(`${source}.${role}.${operation}`, 'Field masks must be declared on read')
        const names = new Set<string>()
        const path = `${source}.${role}${typeof entry === 'string' ? '' : `.${operation}`}`
        const where = typeof authored === 'object' ? expand(authored.where, path, names) : {}
        const fields = config.entities[entity] ? [...baseFields, ...Object.keys(config.entities[entity].fields).filter(field => !config.entities[entity].fields[field].sensitive)] : [...baseFields]
        const mask = sorted(typeof authored === 'object' && authored.fields ? authored.fields : fields)
        if (mask.length && !mask.includes('id')) mask.push('id')
        const rule: EffectiveEntityPolicy = { entity, role, operation, decision: typeof authored === 'string' ? authored : 'allow',
          where: canonical(where), fields: operation !== 'read' || !config.entities[entity] ? null : typeof authored === 'string' && authored !== 'allow' ? [] : sorted(mask), predicates: sorted(names), dependencies: [], source: path }
        if (config.entities[entity] && rule.decision === 'allow') {
          try { validatePolicies({ ...config, effectiveAccess: undefined, policies: { [entity]: { [role]: { where, fields: rule.fields ?? undefined } } } }) }
          catch (cause) { error(path, cause instanceof Error ? cause.message : String(cause)) }
        } else if (Object.keys(where).length || typeof authored === 'object' && authored.fields) error(path, `Row predicates and masks require a schema entity: ${entity}`)
        function dependencies(name: string, filter: Filter) {
          for (const [key, value] of Object.entries(filter)) {
            if (key === 'actorLinkedIn') rule.dependencies.push(value as string)
            else if (key === 'and' || key === 'or') (value as Filter[]).forEach(child => dependencies(name, child))
            else if (key === 'not') dependencies(name, value as Filter)
            else {
              const relation = config.entities[name]?.relations[key]
              if (relation) { rule.dependencies.push(relation.entity); dependencies(relation.entity, (relation.many ? Object.values(value as object)[0] : value) as Filter) }
            }
          }
        }
        dependencies(entity, where)
        rule.dependencies = sorted(rule.dependencies)
        result.entities.push(rule)
      }
    }
  }
  // Dependencies of a relation include its target's effective policy for the same operation.
  for (const operation of accessOperations) {
    const graph = new Map(known.map(entity => [entity, sorted(result.entities.filter(rule => rule.entity === entity && rule.operation === operation).flatMap(rule => rule.dependencies))]))
    const done = new Set<string>()
    function visit(entity: string, stack: string[], owner?: EffectiveEntityPolicy) {
      if (stack.includes(entity)) error(owner!.source, `Relation policy cycle: ${[...stack, entity].join(' -> ')}`)
      if (done.has(entity)) return
      for (const target of graph.get(entity) ?? []) visit(target, [...stack, entity], owner ?? result.entities.find(rule => rule.entity === entity && rule.operation === operation && rule.dependencies.includes(target)))
      done.add(entity)
    }
    for (const entity of known) visit(entity, [])
  }
  for (const role of roles) {
    const system = input.roles[role]?.system
    if (!system) error(`access.roles`, `Missing system grants for role ${role}`)
    for (const action of Object.keys(system!)) if (!accessSystemActions.includes(action)) error(`access.roles.${role}.system.${action}`, `Unknown system action: ${action}`)
    for (const action of accessSystemActions) {
      const source = `access.roles.${role}.system.${action}`
      if (!Object.hasOwn(system!, action)) error(`access.roles.${role}.system`, `Missing explicit system action ${action} for role ${role}`)
      result.system.push({ role, action, decision: system![action], target: systemAccessTarget(action), source })
    }
  }
  for (const entity of Object.keys(config.entities).sort()) for (const name of Object.keys(config.entities[entity].actions ?? {}).sort()) {
    const action = config.entities[entity].actions![name]
    const source = `entities.${entity}.actions.${name}`
    const dependencies = new Set<string>()
    function fields(target: string, filter: Filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (key === 'and' || key === 'or') (value as Filter[]).forEach(child => fields(target, child))
        else if (key === 'not') fields(target, value as Filter)
        else if (key === 'actorLinkedIn') dependencies.add(`${value}.user`)
        else {
          const relation = config.entities[target].relations[key]
          if (relation) {
            dependencies.add(`${target}.${relation.many ? 'id' : relation.field}`)
            dependencies.add(`${relation.entity}.${relation.many ? relation.field : 'id'}`)
            fields(relation.entity, (relation.many ? Object.values(value as object)[0] : value) as Filter)
          } else dependencies.add(`${target}.${key}`)
        }
      }
    }
    const conditions = (action.available ?? []).map((condition, i) => {
      const path = `${source}.available.${i}.when`
      const when = canonical(expand(condition.when, path, new Set()))
      try { validatePolicies({ ...config, effectiveAccess: undefined, policies: { [entity]: { [roles[0]]: { where: when } } } }) }
      catch (cause) { error(path, cause instanceof Error ? cause.message : String(cause)) }
      fields(entity, when)
      return { when, reason: condition.reason }
    })
    result.actions.push({ entity, name, command: action.command, conditions, dependencies: sorted(dependencies), source })
  }
  for (const [entity, mapping] of Object.entries(input.accountLinks ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const source = `access.accountLinks.${entity}.invitationRole`
    if (!userLinks(config).some(link => link.entity === entity)) error(source, `Account link required: ${entity}`)
    if (!roles.includes(mapping.invitationRole)) error(source, `Unknown invitation role: ${mapping.invitationRole}`)
    if (mapping.invitationRole === config.organizationOwnerRole) error(source, 'Invitation role cannot be organizationOwnerRole')
    if (!result.entities.some(rule => rule.entity === entity && rule.role === mapping.invitationRole && rule.operation === 'read' && rule.decision === 'allow')) error(source, `Invitation role requires read on ${entity}`)
    ;(result.accountLinks ??= {})[entity] = { ...mapping }
  }
  const reservedCommands = Object.keys(result.accountLinks ?? {}).flatMap(entity => accountActions(entity).map(action => action.command))
  for (const action of result.actions) if (reservedCommands.includes(action.command)) error(action.source, 'Account commands require their core registered action')
  for (const entity of Object.keys(result.accountLinks ?? {})) {
    for (const action of accountActions(entity)) {
      if (result.actions.some(existing => existing.entity === entity && existing.name === action.name)) error(action.source, `Reserved account action: ${action.name}`)
      result.actions.push(action)
    }
  }
  const builtins = workerAccessCommands({ ...config, effectiveAccess: result })
  return accessGuards(result, [...config.commands, ...builtins.map(command => command.name)], [...(config.plugins ?? []).flatMap(plugin => [...(plugin.commands ?? [])]), ...userLinkCommands(config), ...builtins], config.plugins ?? [])
}
