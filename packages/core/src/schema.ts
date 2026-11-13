import { effectiveSystemGrant } from './access-evaluator'
import { entityAccessSchema, compileAccess, defineAccess, type AccessInput } from './access'
import { validatePolicies } from './policies'
export { defineAccess, compileAccess, accessEntities, accessOperations, accessSystemActions, ACCESS_EXPANSION_LIMITS } from './access'
export type { AccessInput, EntityAccess, EffectiveAccessPolicy } from './access'
import { z } from 'zod'
import { fieldSchema, serializedExpressionSchema, normalizeInstance, organizationActions, type InstanceConfig, type InstanceInput } from './config'

import { DeclarationError, schemaConfigs as configs, type DeclarationPath } from './schema/declaration'
export { DeclarationError, type DeclarationPath } from './schema/declaration'
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/)
const relationSchema = z.strictObject({
  field: identifier, entity: identifier, many: z.boolean().optional(),
  through: z.strictObject({ entity: identifier, field: identifier, createCommand: z.string().min(1), deleteCommand: z.string().min(1) }).optional(),
})
// Field validation and normalized field types are shared with the kernel.
// Strict objects prevent inline labels and plugin lifecycle hooks from being silently stripped.
const declarationSchema = z.strictObject({
  fields: z.record(identifier, fieldSchema.strict()),
  relations: z.record(identifier, relationSchema).optional(),
  displayField: z.union([serializedExpressionSchema, z.literal(false)]).optional(),
  checks: z.array(z.strictObject({ left: identifier, op: z.enum(['<=', '>=']), right: identifier })).optional(),
  commandsOnly: z.boolean().optional(),
  access: entityAccessSchema.optional(),
})
export type EntityInput = z.input<typeof declarationSchema>
declare const entityBrand: unique symbol
export type EntityDeclaration<T extends EntityInput = EntityInput> = T & { readonly [entityBrand]: true }
const entities = new WeakSet<object>()

function parse<T>(schema: z.ZodType<T>, input: unknown, prefix: DeclarationPath = []): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw new DeclarationError([...prefix, ...issue.path.map(key => typeof key === 'symbol' ? String(key) : key)], `${[...prefix, ...issue.path].join('.')}: ${issue.message}`)
}

type LiteralFields<T extends EntityInput> = {
  [K in keyof T['fields']]: T['fields'][K] & Record<Exclude<keyof T['fields'][K], keyof EntityInput['fields'][string]>, never>
}
/** Data declaration only. loadConfig additionally enforces the literal source boundary. */
export function defineEntity<const T extends EntityInput>(input: T & Record<Exclude<keyof T, keyof EntityInput>, never> & { fields: LiteralFields<T> }): EntityDeclaration<T> {
  const entity = parse(declarationSchema, input)
  const relations = { ...entity.relations }
  for (const [name, field] of Object.entries(entity.fields)) {
    if (!field.userLink) continue
    if (name !== 'user' || field.type !== 'ref' || field.entity !== 'users' || field.required || field.computed
      || field.default != null || field.backfillFrom || field.renameFrom) throw new DeclarationError(['fields', name], 'Invalid protected account link')
    if (relations.user_account && (relations.user_account.field !== 'user' || relations.user_account.entity !== 'users' || relations.user_account.many || relations.user_account.through)) throw new DeclarationError(['relations', 'user_account'], 'Invalid user_account relation')
    field.readOnly = true
    relations.user_account = { field: 'user', entity: 'users' }
  }
  const normalized = { ...entity, relations }
  entities.add(normalized)
  return normalized as EntityDeclaration<T>
}

/** The sole allowed call inside an entity literal; generic writes cannot set this ref. */
export function accountLink() {
  return { type: 'ref', entity: 'users', userLink: true, readOnly: true } as const
}

export type ConfigInput = Omit<InstanceInput, 'entities' | 'roles' | 'organizationOwnerRole' | 'permissions' | 'account' | 'languages' | 'enumLabels' | 'locale'> & {
  entities: Record<string, EntityDeclaration>
  roles: string[]
  organizationOwnerRole: string
  languages: string[]
  permissions?: InstanceInput['permissions']
  access?: AccessInput
}
export type SchemaConfig = InstanceConfig & { languages: string[] }

const languageList = z.array(z.string().min(1).refine(value => {
  try { return Intl.getCanonicalLocales(value).length === 1 } catch { return false }
}, 'Invalid language tag')).min(1).refine(values => {
  try { return new Set(Intl.getCanonicalLocales(values)).size === values.length } catch { return false }
}, 'Duplicate languages')

/** Minimal Model B account descriptor; physical DDL belongs to the SDK baseline. */
function accountEntity(roles: string[]): InstanceInput['entities'][string] {
  return { fields: {
    name: { type: 'string', required: true },
    role: { type: 'enum', values: [...roles], required: true },
  }, displayField: 'name' }
}

/** Explicit application roles and SDK accounts; no domain plugin or inline labels. */
export function defineConfig(input: ConfigInput): SchemaConfig {
  const languages = parse(languageList, input.languages, ['languages'])
  const roles = parse(z.array(identifier).min(1).refine(value => new Set(value).size === value.length, 'Duplicate roles'), input.roles, ['roles'])
  if (!roles.includes(input.organizationOwnerRole)) throw new DeclarationError(['organizationOwnerRole'], 'organizationOwnerRole must be in roles')
  if ('account' in input || 'enumLabels' in input) throw new DeclarationError([], 'Account ownership and labels are SDK/dictionary concerns')
  const domain: InstanceInput['entities'] = {}
  for (const [name, entity] of Object.entries(input.entities)) {
    if (name === 'users') throw new DeclarationError(['entities', name], 'users is SDK-owned; use accountLink()')
    if (!entities.has(entity)) throw new DeclarationError(['entities', name], 'Expected a defineEntity declaration imported from schema/<entity>.ts')
    // Copy through core input types; displayField:false suppresses inference in expand().
    domain[name] = entity as InstanceInput['entities'][string]
  }
  const known = new Set(['users', ...Object.keys(domain)])
  for (const [name, entity] of Object.entries(domain)) {
    for (const [key, field] of Object.entries(entity.fields)) if (field.type === 'ref' && !known.has(field.entity!)) throw new DeclarationError(['entities', name, 'fields', key, 'entity'], `Unknown reference: ${field.entity}`)
    for (const [key, relation] of Object.entries(entity.relations ?? {})) {
      if (!known.has(relation.entity)) throw new DeclarationError(['entities', name, 'relations', key, 'entity'], `Unknown relation target: ${relation.entity}`)
      if (relation.through && !known.has(relation.through.entity)) throw new DeclarationError(['entities', name, 'relations', key, 'through', 'entity'], `Unknown relation target: ${relation.through.entity}`)
    }
  }
  for (const plugin of input.plugins ?? []) {
    if (Object.keys(plugin.model?.entities ?? {}).length || Object.keys(plugin.entities ?? {}).length || plugin.model?.account) throw new DeclarationError(['plugins'], `Plugin ${plugin.name}: new-era domain entities must be imported explicitly`)
  }
  let config: SchemaConfig
  try {
    config = normalizeInstance({ ...input, roles, languages,
      entities: { ...domain, users: accountEntity(roles) }, account: { entity: 'users' },
      permissions: input.permissions ?? {},
    }, true, (error, path) => { throw new DeclarationError(path, error instanceof Error ? error.message : String(error)) }) as SchemaConfig
  } catch (error) {
    if (error instanceof DeclarationError) throw error
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]
      throw new DeclarationError(issue.path.map(key => typeof key === 'symbol' ? String(key) : key), issue.message)
    }
    // Kernel expression/display diagnostics already identify their owning entity.
    if (error instanceof Error && 'errors' in error && Array.isArray(error.errors)) {
      const issue = error.errors[0] as { entity?: string; field?: string }
      if (issue?.entity) throw new DeclarationError(['entities', issue.entity, ...(issue.field && domain[issue.entity]?.fields[issue.field] ? ['fields', issue.field, 'computed'] : ['displayField'])], error.message)
    }
    throw error
  }
  if (input.access || Object.values(input.entities).some(entity => entity.access)) {
    if (!input.access) throw new DeclarationError(['access'], 'Expected shared access.ts declaration')
    if (input.permissions || input.policies || input.organizationPermissions) throw new DeclarationError(['access'], 'Authored access replaces permissions, policies and organizationPermissions')
    const declarations = Object.fromEntries(Object.entries(input.entities).map(([name, entity]) => [name, entity.access]))
    const policy = compileAccess(config, declarations, defineAccess(input.access))
    config.effectiveAccess = policy
    // Derived compatibility projections feed existing SQL issuer guards and metadata.
    // Authorization always evaluates the normalized policy, including explicit denials.
    config.permissions = Object.fromEntries(config.roles.map(role => [role,
      Object.fromEntries(Object.keys(config.entities).map(entity => [entity, policy.entities
        .filter(rule => rule.role === role && rule.entity === entity && rule.decision === 'allow').map(rule => rule.operation)])),
    ]))
    config.organizationPermissions = Object.fromEntries(config.roles.map(role => [role,
      organizationActions.filter(action => effectiveSystemGrant(policy, [role], action)),
    ]))
    validatePolicies(config)
  }
  configs.add(config)
  return config
}

/** Loader guard: a new-era module must export the result of defineConfig. */
export function isSchemaConfig(value: unknown): value is SchemaConfig {
  return typeof value === 'object' && value !== null && configs.has(value)
}
