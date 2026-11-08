/** Pure authoring layer. All imports are erased; the kernel validates the expanded input. */
import type { InstanceInput, Operation } from './config'

type EntityInput = InstanceInput['entities'][string]
type FieldInput = EntityInput['fields'][string]
type RelationInput = NonNullable<EntityInput['relations']>[string]
type CanonicalPolicy = NonNullable<InstanceInput['policies']>[string][string]
type ScalarToken = 'string' | 'text' | 'int' | 'float' | 'bool' | 'datetime'
export type FieldShorthand = ScalarToken | `${ScalarToken}!` | `ref:${string}` | `enum:${string}`
export type RelationShorthand = `${string}@${string}`
export type ShorthandEntity = Omit<EntityInput, 'fields' | 'relations' | 'displayField'> & {
  displayField?: EntityInput['displayField'] | false
  fields: Record<string, FieldInput | FieldShorthand>
  relations?: Record<string, RelationInput | RelationShorthand>
}
export type OperationShorthand = Operation[] | 'all' | 'read' | '*'
export interface PermissionDeclaration { role: string; entity: string; operations: OperationShorthand }
export type PermissionShorthand = Record<string, Record<string, OperationShorthand>> | PermissionDeclaration[]
export interface PolicyScope { name: string; where: Record<string, unknown> }
export type PolicyShorthand = CanonicalPolicy | `scope:${string}` | { scope: string; deny?: 'empty' | 'forbidden'; fields?: string[] }
export type ShorthandInput = Omit<InstanceInput, 'entities' | 'permissions' | 'policies'> & {
  entities: Record<string, ShorthandEntity>
  permissions: PermissionShorthand
  policies?: Record<string, Record<string, PolicyShorthand>>
  enums?: Record<string, readonly string[]>
  policyScopes?: PolicyScope[]
}
const all: Operation[] = ['read', 'create', 'update', 'delete']
const identifier = /^[a-z][a-z0-9_]*$/
const own = (object: object, key: string) => Object.hasOwn(object, key)

/** Same Boolean constant rules as policies.constantPredicate, on the filter grammar.
 * Relation existence is never inferred from database state. Canonical schema validation
 * still validates the complete filter after expansion; this only rejects certain truths.
 * Entity context follows nested relation targets; declarations without it stay conservative.
 */
export function constantFilter(filter: Record<string, unknown>, relations: Record<string, unknown>, entities: Record<string, { relations?: Record<string, unknown> }> = {}): boolean | undefined {
  const values = Object.entries(filter).map(([key, value]): boolean | undefined => {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(value)) return undefined
      const children = value.map(child => child && typeof child === 'object' && !Array.isArray(child) ? constantFilter(child, relations, entities) : undefined)
      return key === 'and'
        ? children.includes(false) ? false : children.every(child => child === true) ? true : undefined
        : children.includes(true) ? true : children.every(child => child === false) ? false : undefined
    }
    if (key === 'not' && value && typeof value === 'object' && !Array.isArray(value)) {
      const child = constantFilter(value as Record<string, unknown>, relations, entities)
      return child === undefined ? undefined : !child
    }
    if (own(relations, key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const relation = relations[key] as RelationInput
      const childRelations = entities[relation.entity]?.relations ?? {}
      const none = !!relation.many && own(value, 'none')
      const child = relation.many ? (value as Record<string, unknown>)[none ? 'none' : 'some'] : value
      if (!child || typeof child !== 'object' || Array.isArray(child)) return undefined
      // To-one also renders as EXISTS: missing parents make it false, even for a true child.
      return constantQuantifier(none, constantFilter(child as Record<string, unknown>, childRelations, entities))
    }
    if (!own(relations, key) && value && typeof value === 'object' && 'in' in value && Array.isArray(value.in) && !value.in.length) return false
    return undefined
  })
  return values.includes(false) ? false : values.every(value => value === true) ? true : undefined
}

/** Canonical input is an identity transform. Sugar is removed before schema validation. */
export function expand(input: ShorthandInput): InstanceInput {
  let sugar = input.enums !== undefined || input.policyScopes !== undefined || Array.isArray(input.permissions)
  sugar ||= Object.values(input.entities ?? {}).some(entity => entity.displayField === false || Object.values(entity.fields ?? {}).some(field => typeof field === 'string') || Object.values(entity.relations ?? {}).some(relation => typeof relation === 'string'))
  sugar ||= Object.entries(input.permissions ?? {}).some(([role, grants]) => role === '*' || Object.entries(grants).some(([entity, operations]) => entity === '*' || typeof operations === 'string'))
  sugar ||= Object.entries(input.policies ?? {}).some(([entity, roles]) => entity === '*' || Object.entries(roles).some(([role, policy]) => role === '*' || typeof policy === 'string' && policy.startsWith('scope:') || typeof policy === 'object' && policy !== null && 'scope' in policy))
  if (!sugar) return input as InstanceInput
  for (const [name, values] of Object.entries(input.enums ?? {})) {
    if (!Array.isArray(values)) throw new Error(`Invalid enum ${name}: not an array`)
    if (!values.length) throw new Error(`Invalid enum ${name}: empty`)
    if (values.some(value => typeof value !== 'string')) throw new Error(`Invalid enum ${name}: non-string value`)
    if (values.some(value => !value.trim())) throw new Error(`Invalid enum ${name}: empty value`)
    if (new Set(values).size !== values.length) throw new Error(`Invalid enum ${name}: duplicate value`)
  }
  const entities: InstanceInput['entities'] = Object.fromEntries(Object.entries(input.entities).map(([name, entity]) => {
    let entitySugar = false
    const fields: EntityInput['fields'] = Object.fromEntries(Object.entries(entity.fields).map(([key, field]) => {
      if (typeof field !== 'string') return [key, field]
      sugar = entitySugar = true
      const match = /^(string|text|int|float|bool|datetime|ref:[a-z][a-z0-9_]*|enum:[a-z][a-z0-9_]*)(!)?$/.exec(field)
      if (!match) throw new Error(`Unknown field shorthand: ${name}.${key}: ${field}`)
      const token = match[1]; const required = match[2] ? { required: true } : {}
      if (token.startsWith('ref:')) {
        const target = token.slice(4)
        if (!own(input.entities, target)) throw new Error(`Unknown reference: ${name}.${key} -> ${target}`)
        return [key, { type: 'ref', entity: target, ...required }]
      }
      if (token.startsWith('enum:')) {
        const enumName = token.slice(5)
        if (!input.enums || !own(input.enums, enumName)) throw new Error(`Unknown enum: ${name}.${key} -> ${enumName}`)
        return [key, { type: 'enum', values: [...input.enums[enumName]], ...required }]
      }
      return [key, { type: token as ScalarToken, ...required }]
    }))
    const relations: NonNullable<EntityInput['relations']> = Object.fromEntries(Object.entries(entity.relations ?? {}).map(([key, relation]) => {
      if (typeof relation !== 'string') return [key, relation]
      sugar = entitySugar = true
      const match = /^([a-z][a-z0-9_]*)@([a-z][a-z0-9_]*)(\[\])?$/.exec(relation)
      if (!match) throw new Error(`Invalid relation shorthand: ${name}.${key}: ${relation}`)
      const [, target, field, many] = match
      return [key, { entity: target, field, ...(many ? { many: true } : {}) }]
    }))
    const displayField = entity.displayField ?? (entitySugar ? ['name', 'title'].find(key => own(fields, key)) : undefined)
    const { fields: _fields, relations: _relations, displayField: _display, ...options } = entity
    return [name, { ...options, fields, ...(entity.relations ? { relations } : {}), ...(displayField ? { displayField } : {}) }]
  }))
  // Validate sugar references after all field tokens have expanded (including reverse FKs).
  for (const [name, entity] of Object.entries(input.entities)) for (const [key, relation] of Object.entries(entity.relations ?? {})) {
    if (typeof relation !== 'string') continue
    const expanded = entities[name].relations![key]
    const field = expanded.many ? entities[expanded.entity]?.fields[expanded.field] : entities[name].fields[expanded.field]
    if (!field || field.type !== 'ref' || field.entity !== (expanded.many ? name : expanded.entity) || !own(entities, expanded.entity)) throw new Error(`Invalid relation reference: ${name}.${key} (${expanded.entity}.${expanded.field})`)
  }

  const declarations = Array.isArray(input.permissions) ? input.permissions : Object.entries(input.permissions).flatMap(([role, grants]) => Object.entries(grants).map(([entity, operations]) => ({ role, entity, operations })))
  const explicit = new Map<string, Operation[]>()
  const wildcard = new Map<string, Operation[]>()
  const permissions: InstanceInput['permissions'] = {}
  for (const declaration of declarations) {
    if (!declaration || typeof declaration !== 'object' || Object.keys(declaration).some(key => !['role', 'entity', 'operations'].includes(key)) || typeof declaration.role !== 'string' || typeof declaration.entity !== 'string') throw new Error('Invalid permission declaration: expected role, entity and operations')
    const { role, entity, operations } = declaration
    const isWildcard = role === '*' || entity === '*'
    if (isWildcard || typeof operations === 'string') sugar = true
    if (role !== '*' && !input.roles.includes(role)) throw new Error(`Unknown permission role: ${role} (${entity})`)
    if (entity !== '*' && !own(entities, entity)) throw new Error(`Unknown permission entity: ${role}.${entity}`)
    const ops = operations === 'all' || operations === '*' ? [...all] : operations === 'read' ? ['read'] as Operation[] : operations
    if (!Array.isArray(ops) || ops.some(operation => !all.includes(operation))) throw new Error(`Unknown permission operation: ${role}.${entity}`)
    for (const r of role === '*' ? input.roles : [role]) for (const e of entity === '*' ? Object.keys(entities) : [entity]) {
      const key = `${r}.${e}`; const target = isWildcard ? wildcard : explicit
      if (target.has(key)) throw new Error(`Duplicate permission declaration: ${r}.${e}`)
      target.set(key, [...ops])
    }
  }
  for (const role of input.roles) {
    const grants: Record<string, Operation[]> = {}
    for (const entity of Object.keys(entities)) {
      const key = `${role}.${entity}`; const ops = explicit.get(key) ?? wildcard.get(key)
      if (ops) grants[entity] = ops
    }
    if (Object.keys(grants).length || !Array.isArray(input.permissions) && own(input.permissions, role)) permissions[role] = grants
  }

  const scopes = new Map<string, Record<string, unknown>>()
  for (const scope of input.policyScopes ?? []) {
    if (!scope || typeof scope !== 'object') throw new Error('Invalid policy scope declaration')
    for (const key of Object.keys(scope)) if (!['name', 'where'].includes(key)) throw new Error(`Invalid policy scope ${scope.name}: unknown option ${key}`)
    if (typeof scope.name !== 'string' || !identifier.test(scope.name)) throw new Error(`Invalid policy scope name: ${scope.name}`)
    if (scopes.has(scope.name)) throw new Error(`Duplicate policy scope: ${scope.name}`)
    if (!scope.where || !Object.keys(scope.where).length) throw new Error(`Empty policy scope: ${scope.name}`)
    if (constantFilter(scope.where, {}) === true) throw new Error(`Empty policy scope (always true): ${scope.name}`)
    scopes.set(scope.name, scope.where)
  }
  const usedScopes = new Set<string>()
  const policies: NonNullable<InstanceInput['policies']> = {}
  for (const [entity, roles] of Object.entries(input.policies ?? {})) {
    if (entity !== '*' && !own(entities, entity)) throw new Error(`Unknown policy entity: ${entity}`)
    for (const [role, policy] of Object.entries(roles)) {
      if (role !== '*' && !input.roles.includes(role)) throw new Error(`Unknown policy role: ${entity}.${role}`)
      if (entity === '*' || role === '*') {
        sugar = true
        if (policy !== 'none') throw new Error(`Policy wildcard must be none: ${entity}.${role}`)
        continue // Totalization below fills every otherwise missing pair with none.
      }
      let value: CanonicalPolicy
      if (typeof policy === 'string' && policy.startsWith('scope:') || typeof policy === 'object' && policy !== null && 'scope' in policy) {
        sugar = true
        if (typeof policy === 'object') for (const key of Object.keys(policy)) if (!['scope', 'deny', 'fields'].includes(key)) throw new Error(`Unknown policy scope option: ${entity}.${role}.${key}`)
        if (typeof policy === 'object') {
          if (typeof policy.scope !== 'string' || !identifier.test(policy.scope)) throw new Error(`Invalid policy ${entity}.${role}: scope must be an identifier`)
          if (own(policy, 'deny') && !['empty', 'forbidden'].includes(policy.deny!)) throw new Error(`Invalid policy ${entity}.${role}: deny must be empty or forbidden`)
          if (own(policy, 'fields') && (!Array.isArray(policy.fields) || policy.fields.some(field => typeof field !== 'string' || !['id', 'organization_id', 'created_at', 'updated_at', 'version'].includes(field) && !own(entities[entity].fields, field)))) throw new Error(`Invalid policy ${entity}.${role}: fields must be an array of known field names`)
        }
        const name = typeof policy === 'string' ? policy.slice(6) : policy.scope
        if (!identifier.test(name)) throw new Error(`Invalid policy ${entity}.${role}: scope must be an identifier`)
        const where = scopes.get(name)
        if (!where) throw new Error(`Unknown policy scope: ${entity}.${role} -> ${name}`)
        if (constantFilter(where, entities[entity].relations ?? {}, entities) === true) throw new Error(`Empty policy scope (always true): ${name}`)
        usedScopes.add(name)
        value = typeof policy === 'string' ? { where } : { where, ...(policy.deny ? { deny: policy.deny } : {}), ...(policy.fields ? { fields: [...policy.fields] } : {}) }
      } else value = policy as CanonicalPolicy
      if (!own(policies, entity)) policies[entity] = {}
      policies[entity][role] = value
    }
  }
  for (const name of scopes.keys()) if (!usedScopes.has(name)) throw new Error(`Unused policy scope: ${name}`)
  if (!sugar) return input as InstanceInput
  const { enums: _enums, policyScopes: _scopes, ...canonical } = input
  return { ...canonical, entities, permissions, policies: Object.fromEntries(Object.keys(entities).map(entity => [entity, Object.fromEntries(input.roles.map(role => [role, policies[entity]?.[role] ?? 'none']))])) }
}

/** EXISTS/NOT EXISTS over false is constant; over true still depends on related rows.
 * Shared with the compiled predicate fold; no database state is assumed.
 */
export function constantQuantifier(negated: boolean, child: boolean | undefined): boolean | undefined {
  return child === false ? negated : undefined
}
