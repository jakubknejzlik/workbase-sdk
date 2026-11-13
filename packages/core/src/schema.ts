import { z } from 'zod'
import { fieldSchema, serializedExpressionSchema, normalizeInstance, type InstanceConfig, type InstanceInput } from './config'

export type DeclarationPath = (string | number)[]
/** Paths are mapped to source positions by the build-time loader. */
export class DeclarationError extends Error {
  constructor(readonly path: DeclarationPath, message: string) { super(message); this.name = 'DeclarationError' }
}
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
})
export type EntityInput = z.input<typeof declarationSchema>
declare const entityBrand: unique symbol
export type EntityDeclaration<T extends EntityInput = EntityInput> = T & { readonly [entityBrand]: true }
const entities = new WeakSet<object>()
const configs = new WeakSet<object>()

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
}
export type SchemaConfig = InstanceConfig & { languages: string[] }

const languageList = z.array(z.string().min(1).refine(value => {
  try { return Intl.getCanonicalLocales(value).length === 1 } catch { return false }
}, 'Invalid language tag')).min(1).refine(values => {
  try { return new Set(Intl.getCanonicalLocales(values)).size === values.length } catch { return false }
}, 'Duplicate languages')

/** Minimal Model B account projection. SDK DDL ownership changes in a later slice. */
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
  const config = normalizeInstance({ ...input, roles, languages,
    entities: { ...domain, users: accountEntity(roles) }, account: { entity: 'users' },
    permissions: input.permissions ?? {},
  }, true) as SchemaConfig
  configs.add(config)
  return config
}

/** Loader guard: a new-era module must export the result of defineConfig. */
export function isSchemaConfig(value: unknown): value is SchemaConfig {
  return typeof value === 'object' && value !== null && configs.has(value)
}
