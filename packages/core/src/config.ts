import { coreEnums, type CoreRole } from './query/enum-values'
import { z } from 'zod'
import { calendarViewsSchema, validateCalendarViews } from './calendar-display'
import { Q, Fn as LibraryFn, Cond, type ISequelizable, type ISerializable } from '@jakub.knejzlik/ts-query'
import { DISPLAY_VALUE, isExpression, validateComputedExpressions, expressionError } from './query/expressions'
import { validateLabelExpressions } from './query/labels'
import type { WorkbasePlugin } from './kernel/plugin'
import { resolvePlugins } from './kernel/composition'
import { expand, type ShorthandInput } from './config-shorthand'
import { validatePolicies } from './policies'
import { filterSchema } from './query/schema'
import { formDisplaySchema, formSectionsSchema, validateFormDisplay } from './form-display'
import { detailDisplaySchema, validateDetailDisplay } from './detail-display'
import { validateDisplayFields, isDisplayFieldError } from './display-field'
export { DisplayFieldError, isDisplayFieldError, displayFieldErrors, suggestedDisplayField, validateDisplayFields } from './display-field'

export { Q, Cond }
/** SQLite date formatting with column operands; values use the library wire encoding. */
export const Fn = { ...LibraryFn, strftime: (format: string, date: string) => Q.expr(`FN(${JSON.stringify(['STRFTIME', Q.value(format).serialize(), Q.expr(date).serialize()])})`) }

export const CORE_VERSION = '0.2.15'
const navigationIconSchema = z.enum(['LayoutDashboard', 'Users', 'MapPin', 'Coins', 'Wallet', 'ArrowLeftRight', 'Settings', 'Building2', 'Activity', 'Workflow', 'Database', 'Folder'])
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/)
export const serializedExpressionSchema = z.union([z.string().min(1).max(32000), z.record(z.string(), z.unknown()).transform(value => JSON.stringify(value))])
export const fieldSchema = z.object({
  computed: serializedExpressionSchema.optional(),
  type: z.enum(['string', 'text', 'int', 'float', 'bool', 'datetime', 'enum', 'ref']),
  required: z.boolean().default(false), values: z.array(z.string()).optional(), entity: identifier.optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  min: z.number().optional(), readOnly: z.boolean().optional(), sensitive: z.boolean().optional(),
  userLink: z.boolean().optional(),
  ui: z.strictObject({
    hidden: z.boolean().optional(),
    format: z.enum(['identifier']).optional(),
    kind: z.enum(['input', 'textarea', 'select', 'boolean', 'number', 'date', 'datetime', 'time', 'colour']).optional(),
    span: z.enum(['half', 'full']).optional(), section: z.string().min(1).optional(),
    signedBy: z.strictObject({ field: identifier, negativeValue: z.string() }).optional(),
  }).optional(),
  renameFrom: identifier.optional(),
  backfillFrom: z.object({ refField: identifier, valueField: identifier }).optional(),
}).superRefine((f, ctx) => {
  if (f.type === 'enum' && !f.values?.length) ctx.addIssue({ code: 'custom', message: 'enum requires values' })
  if (f.type === 'ref' && !f.entity) ctx.addIssue({ code: 'custom', message: 'ref requires entity' })
})
const operations = z.array(z.enum(['read', 'create', 'update', 'delete']))
export const organizationActions = ['organizations.update', 'members.read', 'members.update', 'members.remove', 'invitations.create', 'invitations.read', 'invitations.revoke', 'tokens.create', 'tokens.read', 'tokens.revoke'] as const
export type OrganizationAction = typeof organizationActions[number]
// Every built-in role must make an explicit runtime grant decision. Undefined
// preserves the absence of a default entry for instance-configured roles.
const coreOrganizationPermissions: Record<CoreRole, OrganizationAction[] | undefined> = {
  owner: [...organizationActions],
  dispatcher: ['invitations.create', 'invitations.read', 'invitations.revoke'],
  viewer: [],
  administrator: undefined,
  unknown: undefined,
}
export const defaultOrganizationPermissions: Record<string, OrganizationAction[]> = Object.fromEntries(
  coreEnums.role.flatMap(role => {
    const grants = coreOrganizationPermissions[role]
    return grants === undefined ? [] : [[role, grants]]
  }),
)
const filterKind = z.enum(['text', 'enum', 'relation', 'number', 'date', 'boolean'])
const listHints = z.strictObject({
  columns: z.array(identifier).optional(),
  relatedColumns: z.record(identifier, z.strictObject({ via: identifier, field: identifier })).optional(),
  compact: z.boolean().optional(), mobileCards: z.boolean().optional(),
  defaultSort: z.strictObject({ key: identifier, direction: z.enum(['asc', 'desc']) }).optional(),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(50), z.literal(100)]).optional(),
  search: z.array(identifier).optional(),
  filter: z.record(identifier, z.union([z.literal(false), filterKind])).optional(),
  views: z.array(z.strictObject({ id: identifier, label: z.string().min(1), where: z.record(z.string(), z.unknown()), default: z.boolean().optional() })).optional(),
  sort: z.record(identifier, z.union([z.literal(false), z.strictObject({ fields: z.array(identifier).min(1).max(4) })])).optional(),
})
const schema = z.object({
  plugins: z.array(z.custom<WorkbasePlugin>()).readonly().optional(),
  interactive: z.boolean().optional(),
  ui: z.strictObject({
    defaultLanguage: z.enum(['en', 'cs']).optional(),
    entities: z.record(identifier, z.strictObject({ views: calendarViewsSchema.optional(), form: formDisplaySchema.optional(), sections: formSectionsSchema.optional(), list: listHints.optional(), lookup: z.boolean().optional(),
      detail: detailDisplaySchema.optional(),
    })),
    navigation: z.strictObject({
      // Route IDs are their staticData.title keys; overrides remain presentation only.
      routes: z.array(z.strictObject({ id: z.string().min(1), icon: navigationIconSchema.optional(), order: z.number().int().optional() })).optional(),
      groups: z.array(z.strictObject({ id: identifier, label: z.string().min(1), icon: navigationIconSchema.optional(), order: z.number().int().optional() })),
      items: z.array(z.strictObject({ id: identifier, entity: identifier, label: z.string().min(1).optional(), icon: navigationIconSchema.optional(), group: identifier.optional(), order: z.number().int().optional(), roles: z.array(identifier).min(1).optional(), view: identifier.optional(), hidden: z.boolean().optional() })),
    }).optional(),
  }).optional(),
  pluginConfig: z.record(z.string(), z.unknown()).optional(),
  languages: z.array(z.string()).optional(),
  baseline: z.literal('workbase-sdk').optional(),
  locale: z.enum(['en', 'cs']).default('en'),
  timeZone: z.string().default('UTC'),
  enumLabels: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  registration: z.enum(['open', 'invite-only']).default('open'),
  organizationOwnerRole: identifier.default('owner'),
  displayName: z.string().trim().min(1).optional(),
  id: identifier, revision: z.number().int().positive(),
  entities: z.record(identifier, z.object({
    fields: z.record(identifier, fieldSchema),
    relations: z.record(identifier, z.object({ field: identifier, entity: identifier, many: z.boolean().optional(), through: z.strictObject({ entity: identifier, field: identifier, createCommand: z.string().min(1), deleteCommand: z.string().min(1) }).optional() })).default({}),
    commandsOnly: z.boolean().optional(),
    displayField: serializedExpressionSchema.optional(),
    displayExpression: z.string().optional(),
    // Trusted server AST. displayField is the projected result key, not a stored label.
    label: z.union([
      z.custom<ISequelizable & ISerializable>(value => !!value && typeof (value as ISequelizable).toSQL === 'function' && typeof (value as ISerializable).serialize === 'function'),
      z.string().transform(value => Q.expr(value)),
    ]).optional(),
    checks: z.array(z.object({ left: identifier, op: z.enum(['<=', '>=']), right: identifier })).default([]),
  })),
  roles: z.array(identifier).min(1),
  account: z.object({ entity: identifier, managedBy: z.array(identifier).optional(), assignments: z.array(identifier).optional() }).optional(),
  policies: z.record(identifier, z.record(identifier, z.union([z.literal('all'), z.literal('none'), z.strictObject({ where: z.record(z.string(), z.unknown()), deny: z.enum(['empty', 'forbidden']).optional(), fields: z.array(identifier).optional() })]))).default({}),
  permissions: z.record(z.string(), z.record(identifier, operations)),
  commands: z.array(z.string()).default([]),
  organizationPermissions: z.record(z.string(), z.array(z.enum(organizationActions))).optional().transform(value => value ?? {}),
}).superRefine((config, ctx) => {
  if (config.plugins?.length && typeof config.interactive !== 'boolean') ctx.addIssue({ code: 'custom', path: ['interactive'], message: 'interactive must be an explicit boolean when plugins are installed' })
})
/** Shared schema for source-derived audits and property checks. */
export const instanceConfigSchema = schema
export type Field = z.infer<typeof fieldSchema>
export type InstanceConfig = z.infer<typeof schema> & { effectiveAccess?: import('./access').EffectiveAccessPolicy }
export type InstanceInput = z.input<typeof schema>
export type Operation = 'read' | 'create' | 'update' | 'delete'
export const baseFields = ['id', 'organization_id', 'created_at', 'updated_at', 'version']
export const reservedEntities = new Set(['users', 'organizations', 'memberships', 'sessions', 'invitations', 'email_outbox', 'audit_outbox', 'security_log', 'idempotency_keys', 'instance_meta', 'webhook_deliveries', 'audit_events', 'd1_migrations', 'identities', 'access_tokens', 'user', 'session', 'account', 'verification', 'rateLimit', 'identity_link_grants', '_plugin_migrations'])
type InstanceDefinitionInput = Omit<ShorthandInput, 'roles' | 'entities' | 'permissions' | 'baseline'> & { roles?: string[]; entities?: ShorthandInput['entities']; permissions?: ShorthandInput['permissions'] }
export function defineInstance(input: InstanceDefinitionInput): InstanceConfig {
  return normalizeInstance(input)
}
/** @internal Shared kernel normalization; schema declarations opt into exact authored roles. */
export function normalizeInstance(input: InstanceDefinitionInput, exactRoles = false, entityError?: (error: unknown, path: (string | number)[]) => never): InstanceConfig {
  const resolved = resolvePlugins(input.plugins ?? [], input.interactive)
  const pluginConfig = { ...input.pluginConfig }
  let contribution: Partial<InstanceInput> = {}
  const model: Partial<InstanceInput> = {}
  for (const plugin of resolved.plugins) {
    for (const key of Object.keys(plugin.model ?? {}) as (keyof NonNullable<WorkbasePlugin['model']>)[]) {
      if (!['entities', 'permissions', 'policies', 'ui', 'account', 'commands', 'organizationPermissions'].includes(key)) throw new Error(`Invalid plugin model contribution: ${key}`)
      if (Object.hasOwn(model, key)) throw new Error(`Duplicate plugin model contribution: ${key}`)
      Object.assign(model, { [key]: plugin.model![key] })
    }
  }
  for (const plugin of resolved.plugins) {
    if (plugin.configure) contribution = { ...contribution, ...plugin.configure(plugin.configSchema?.parse(pluginConfig[plugin.name])) }
  }
  const expanded = expand({ ...model, ...input, entities: input.entities ?? model.entities ?? {}, permissions: input.permissions ?? model.permissions ?? {}, ...contribution, roles: contribution.roles ?? input.roles ?? [],
    organizationPermissions: { ...model.organizationPermissions, ...contribution.organizationPermissions, ...input.organizationPermissions },
    ...(input.pluginConfig || Object.keys(pluginConfig).length ? { pluginConfig } : {}),
  })
  // Append built-ins after shorthand expansion: wildcards/default tables keep their
  // existing entries byte-for-byte. Newly materialized roles receive no grants.
  const authoredRoles = expanded.roles
  const roles = [...authoredRoles]
  if (exactRoles) {
    if (JSON.stringify(roles) !== JSON.stringify(input.roles) || expanded.organizationOwnerRole !== input.organizationOwnerRole) throw new Error('Plugin role configuration must match declared roles and organizationOwnerRole')
  } else for (const role of [expanded.organizationOwnerRole ?? 'owner', 'member']) if (!roles.includes(role)) roles.push(role)
  // Era belongs to the authored input, never a plugin configure() contribution.
  // Strip the contributed key so absent legacy inputs retain no own baseline key.
  const { baseline: _baseline, ...data } = expanded
  const config: InstanceConfig = schema.parse({ ...data, roles,
    ...(Object.hasOwn(input, 'baseline') ? { baseline: (input as InstanceInput).baseline } : {}),
  })
  // Re-normalizing an executable config retains its already-compiled access policy.
  if ('effectiveAccess' in input) config.effectiveAccess = (input as InstanceConfig).effectiveAccess
  for (const name of Object.keys(config.pluginConfig ?? {})) {
    if (!config.plugins?.some(plugin => plugin.name === name)) throw new Error(`Unknown plugin config: ${name}`)
  }
  // Custom roles have no default grants. Preserve sparse explicit/model tables;
  // implicit tables retain their existing empty entries for custom roles.
  const defaultRoles = exactRoles ? [] : input.organizationPermissions === undefined && model.organizationPermissions === undefined
    ? authoredRoles.filter(role => role !== 'member') : authoredRoles.filter(role => Object.hasOwn(defaultOrganizationPermissions, role))
  // Only absent entries receive legacy defaults; a persisted [] stays empty on reload.
  config.organizationPermissions = { ...Object.fromEntries(defaultRoles.filter(role => !Object.hasOwn(config.organizationPermissions, role))
    .map(role => [role, [...(defaultOrganizationPermissions[role] ?? [])]])), ...config.organizationPermissions }
  if (!authoredRoles.includes(config.organizationOwnerRole) && !Object.hasOwn(config.organizationPermissions, config.organizationOwnerRole)) config.organizationPermissions[config.organizationOwnerRole] = []
  if (config.organizationOwnerRole !== 'owner' && !config.roles.includes(config.organizationOwnerRole)) throw new Error('Unknown organization owner role')
  for (const [name, entity] of Object.entries(config.entities)) {
    let path: (string | number)[] = ['entities', name]
    try {
      if ((reservedEntities.has(name) && !(name === 'users' && config.account?.entity === name)) || name === 'atomic_assert' || name.startsWith('sqlite_') || name.startsWith('d1_')) throw new Error(`Reserved entity: ${name}`)
      path = ['entities', name, 'fields']
      if (Object.keys(entity.fields).length > 90) throw new Error('Entity exceeds the supported field/parameter budget')
      for (const [key, field] of Object.entries(entity.fields)) {
        path = ['entities', name, 'fields', key]
        if (field.userLink) {
          if (name === 'users' || config.account?.entity !== 'users' || key !== 'user' || field.type !== 'ref' || field.entity !== 'users'
            || field.required || field.computed || field.default != null || field.backfillFrom || field.renameFrom
            || !Object.values(entity.relations).some(relation => !relation.many && relation.field === key && relation.entity === 'users')) throw new Error(`Invalid user link: ${name}.${key}`)
          field.readOnly = true
        }
        if (name === 'users' && ['email', 'password_hash', 'salt'].includes(key)) throw new Error(`Account identity field is private: ${key}`)
        if (field.computed) field.readOnly = true
        if (baseFields.includes(key)) throw new Error(`Reserved field: ${key}`)
        path = ['entities', name, 'fields', key, 'min']
        if (field.min !== undefined && !['int', 'float'].includes(field.type)) throw new Error('min requires a numeric field')
        path = ['entities', name, 'fields', key, 'default']
        if (field.default !== undefined && field.default !== null) {
          const value = field.default
          const valid = field.type === 'bool' ? typeof value === 'boolean'
            : field.type === 'int' ? Number.isSafeInteger(value) && (value as number) >= (field.min ?? Number.MIN_SAFE_INTEGER)
            : field.type === 'float' ? typeof value === 'number' && Number.isFinite(value) && value >= (field.min ?? -Number.MAX_VALUE)
            : field.type === 'enum' ? field.values!.includes(String(value)) && typeof value === 'string'
            : field.type === 'datetime' ? typeof value === 'string' && z.iso.datetime().safeParse(value).success
            : typeof value === 'string'
          if (!valid) throw new Error(`Invalid default: ${name}.${key}`)
        }
        if (field.required && field.default === null) throw new Error(`Required default cannot be null: ${name}.${key}`)
        path = ['entities', name, 'fields', key, 'entity']
        if (field.type === 'ref' && !Object.hasOwn(config.entities, field.entity!)) throw new Error(`Unknown reference: ${field.entity}`)
        path = ['entities', name, 'fields', key, 'backfillFrom']
        if (field.backfillFrom) {
          const ref = entity.fields[field.backfillFrom.refField]
          if (!ref?.entity || ref.computed || !config.entities[ref.entity]?.fields[field.backfillFrom.valueField] || config.entities[ref.entity].fields[field.backfillFrom.valueField].computed) throw new Error('Invalid backfill reference')
        }
      }
      for (const [relationName, r] of Object.entries(entity.relations)) {
        path = ['entities', name, 'relations', relationName, 'field']
        const target = r.many ? config.entities[r.entity]?.fields[r.field] : entity.fields[r.field]
        if (!target || target.type !== 'ref' || target.entity !== (r.many ? name : r.entity)) throw new Error(`Invalid relation on ${name}`)
        path = ['entities', name, 'relations', relationName, 'through']
        if (r.through) {
          const join = config.entities[r.entity]
          const other = join?.fields[r.through.field]
          if (Object.hasOwn(entity.fields, relationName) || !r.many || r.field === r.through.field || other?.type !== 'ref' || other.entity !== r.through.entity
            || Object.entries(join.fields).some(([field, spec]) => ![r.field, r.through!.field].includes(field) && !(spec.readOnly && spec.ui?.hidden))
            || ![r.through.createCommand, r.through.deleteCommand].every(command => config.commands.includes(command))) throw new Error(`Invalid pure join relation on ${name}`)
          const inverse = Object.values(config.entities[r.through.entity]?.relations ?? {}).some(inverse => inverse.entity === r.entity && inverse.field === r.through!.field && inverse.through?.entity === name && inverse.through.field === r.field)
          if (!inverse) throw new Error(`Missing inverse pure join relation on ${name}`)
        }
      }
      for (const [i, c] of entity.checks.entries()) {
        path = ['entities', name, 'checks', i, !entity.fields[c.left] || entity.fields[c.left].computed ? 'left' : 'right']
        if (!entity.fields[c.left] || !entity.fields[c.right] || entity.fields[c.left].computed || entity.fields[c.right].computed) throw new Error('Unknown check field')
      }
    } catch (error) {
      if (entityError) entityError(error, path)
      throw error
    }
  }
  for (const [role, grants] of Object.entries(config.permissions)) {
    if (!config.roles.includes(role as any)) throw new Error(`Unknown role ${role}`)
    for (const name of Object.keys(grants)) if (!Object.hasOwn(config.entities, name)) throw new Error(`Unknown grant entity ${name}`)
  }
  for (const role of Object.keys(config.organizationPermissions)) {
    if (!config.roles.includes(role as any)) throw new Error(`Unknown organization role ${role}`)
  }
  if (config.account) {
    const account = config.entities[config.account.entity]
    if (!account) throw new Error('Unknown account entity')
    for (const role of config.account.managedBy ?? []) if (!config.roles.includes(role)) throw new Error(`Unknown account manager role: ${role}`)
    for (const field of config.account.assignments ?? []) if (!Object.hasOwn(account.fields, field)) throw new Error(`Unknown account assignment field: ${field}`)
  }
  for (const [name, entity] of Object.entries(config.entities)) {
    if (!entity.displayField && input.entities?.[name]?.displayField !== false) entity.displayField = ['name', 'title'].find(field => entity.fields[field])
  }
  for (const [name, entity] of Object.entries(config.entities)) {
    const expression = entity.displayExpression ?? (entity.displayField && isExpression(entity.displayField) ? entity.displayField : undefined)
    if (expression) {
      if (entity.fields[DISPLAY_VALUE] && !entity.displayExpression) expressionError(name, DISPLAY_VALUE, 'Reserved generated display field', 'Rename computed_display before assigning a display expression.')
      entity.displayExpression = expression
      entity.displayField = DISPLAY_VALUE
      entity.fields[DISPLAY_VALUE] = { type: 'string', required: false, readOnly: true, computed: expression }
    }
  }
  validateComputedExpressions(config)
  // Presentation hints are validated at load; readable capabilities further narrow them at runtime.
  const navigation = config.ui?.navigation
  if (navigation) {
    const groups = navigation.groups.map(group => group.id)
    if (new Set(groups).size !== groups.length) throw new Error('Duplicate navigation group')
    const items = navigation.items.map(item => item.id)
    if (new Set(items).size !== items.length) throw new Error('Duplicate navigation item')
    for (const item of navigation.items) {
      if (!Object.hasOwn(config.entities, item.entity)) throw new Error(`Unknown navigation entity: ${item.entity}`)
      if (item.group && !groups.includes(item.group)) throw new Error(`Unknown navigation group: ${item.group}`)
      for (const role of item.roles ?? []) if (!config.roles.includes(role)) throw new Error(`Unknown navigation role: ${role}`)
      if (item.view && !config.ui?.entities[item.entity]?.list?.views?.some(view => view.id === item.view)) throw new Error(`Unknown navigation view: ${item.entity}.${item.view}`)
    }
  }
  for (const [name, hints] of Object.entries(config.ui?.entities ?? {})) {
    const entity = config.entities[name]
    if (!entity) throw new Error(`Unknown UI entity: ${name}`)
    const known = (field: string) => baseFields.includes(field) || Object.hasOwn(entity.fields, field)
    validateFormDisplay(name, entity, hints)
    if (hints.detail) validateDetailDisplay(config, name, hints.detail)
    for (const [field, spec] of Object.entries(entity.fields)) if (spec.ui?.signedBy && (!known(spec.ui.signedBy.field) || !['int', 'float'].includes(spec.type))) {
      const error = new Error(`Invalid signed UI field: ${name}.${field}`)
      if (entityError) entityError(error, ['entities', name, 'fields', field, 'ui', 'signedBy', 'field'])
      throw error
    }
    validateCalendarViews(config, name, hints.views)
    const list = hints.list
    if (!list) continue
    const scalar = (field: string) => known(field) && entity.fields[field]?.type !== 'ref'
    for (const [key, column] of Object.entries(list.relatedColumns ?? {})) {
      const via = entity.fields[column.via]
      const target = via?.type === 'ref' && via.entity ? config.entities[via.entity] : undefined
      const field = target?.fields[column.field]
      if (known(key) || !field || field.type !== 'ref' || !field.entity) throw new Error(`Invalid UI related column: ${name}.${key}`)
    }
    for (const field of [...(list.columns ?? []).filter(field => !list.relatedColumns?.[field]), ...(list.search ?? []), ...Object.keys(list.sort ?? {}), ...Object.keys(list.filter ?? {})]) if (!known(field)) throw new Error(`Unknown UI field: ${name}.${field}`)
    for (const field of list.search ?? []) if (!['string', 'text'].includes(entity.fields[field]?.type ?? (field === 'id' ? 'string' : ''))) throw new Error(`Invalid UI search field: ${name}.${field}`)
    for (const [key, hint] of Object.entries(list.sort ?? {})) if (hint) {
      if (new Set(hint.fields).size !== hint.fields.length) throw new Error(`Duplicate UI sort field: ${name}.${key}`)
      if (!scalar(key) || !hint.fields.every(scalar)) throw new Error(`Invalid UI sort fields: ${name}`)
    }
    const kindFor = (field: string) => ({ string: 'text', text: 'text', ref: 'relation', enum: 'enum', bool: 'boolean', int: 'number', float: 'number', datetime: 'date' } as Record<string, string>)[entity.fields[field]?.type ?? (field === 'version' ? 'int' : ['created_at', 'updated_at'].includes(field) ? 'datetime' : 'string')]
    for (const [field, kind] of Object.entries(list.filter ?? {})) if (kind && kind !== kindFor(field)) throw new Error(`Invalid UI filter kind: ${name}.${field}`)
    const ids = (list.views ?? []).map(view => view.id)
    if (ids.includes('all')) throw new Error(`Reserved UI view id: ${name}.all`)
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate UI view id: ${name}`)
    if ((list.views ?? []).filter(view => view.default).length > 1) throw new Error(`Multiple default UI views: ${name}`)
    for (const view of list.views ?? []) if (!filterSchema(config)(name, 0).safeParse(view.where).success) throw new Error(`Invalid UI view where: ${name}.${view.id}`)
    if (list.defaultSort && (!scalar(list.defaultSort.key) || list.sort?.[list.defaultSort.key] === false || (['enum', 'text'].includes(entity.fields[list.defaultSort.key]?.type) && !list.sort?.[list.defaultSort.key]))) throw new Error(`Invalid UI default sort: ${name}`)
  }
  validateLabelExpressions(config)
  validatePolicies(config)
  try { validateDisplayFields(config) }
  catch (error) {
    if (isDisplayFieldError(error)) error.config = config
    throw error
  }
  return config
}
/** Diagnostics and migration baselines only; runtime and migration targets use defineInstance. */
export function inspectInstance(input: Parameters<typeof defineInstance>[0]) {
  try { return { config: defineInstance(input), errors: [] as import('./display-field').DisplayFieldIssue[] } }
  catch (error) {
    if (isDisplayFieldError(error) && error.config) return { config: error.config, errors: error.errors }
    throw error
  }
}
export function bodyValidator(entity: InstanceConfig['entities'][string], partial = false) {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, f] of Object.entries(entity.fields)) {
    if (f.readOnly || f.computed) continue
    let v: z.ZodType
    switch (f.type) {
      case 'int': v = z.number().int().min(f.min ?? Number.MIN_SAFE_INTEGER); break
      case 'float': v = z.number().min(f.min ?? -Number.MAX_VALUE); break
      case 'bool': v = z.boolean(); break
      case 'datetime': v = z.iso.datetime(); break
      case 'enum': v = z.enum(f.values as [string, ...string[]]); break
      default: v = z.string().min(1).max(f.type === 'text' ? 100000 : 2000)
    }
    if (!f.required) v = v.nullable()
    if (!partial && f.default !== undefined) v = v.default(f.default)
    else if (partial || !f.required) v = v.optional()
    shape[name] = v
  }
  return z.strictObject(shape)
}
export const allowed = (c: InstanceConfig, role: string, entity: string, op: Operation) => Object.hasOwn(c.permissions, role) && Object.hasOwn(c.permissions[role], entity) && c.permissions[role][entity].includes(op)

/** Clone mutable schema/config data while retaining the trusted plugin code references. */
export function cloneInstanceConfig(config: InstanceConfig): InstanceConfig {
  const { plugins, ...data } = config
  // AST instances carry prototypes; structuredClone would erase their renderers.
  const labels = Object.fromEntries(Object.entries(data.entities).flatMap(([name, entity]) => entity.label ? [[name, entity.label]] : []))
  const plain = { ...data, entities: Object.fromEntries(Object.entries(data.entities).map(([name, { label: _label, ...entity }]) => [name, entity])) }
  const cloned = structuredClone(plain) as InstanceConfig
  for (const [name, label] of Object.entries(labels)) cloned.entities[name].label = label
  return { ...cloned, ...(plugins ? { plugins } : {}) }
}

/** JSON-backed config tools store the library's expression format, never JS AST internals. */
export function serializableInstanceConfig(config: InstanceConfig) {
  return { ...config, entities: Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, {
    ...entity, ...(entity.label ? { label: entity.label.serialize() } : {}),
    ...(entity.displayExpression ? { displayField: entity.displayExpression, displayExpression: undefined, fields: Object.fromEntries(Object.entries(entity.fields).filter(([field]) => field !== DISPLAY_VALUE)) } : {}),
  }])) }
}
