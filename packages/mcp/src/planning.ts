import { DISPLAY_VALUE, isExpression, ExpressionError } from '@workbasehq/core/query/expressions'
import { devFixtures } from './dev-support.ts'
import { createHash } from 'node:crypto'
import { defineInstance, baseFields, cloneInstanceConfig, displayFieldErrors, suggestedDisplayField, isDisplayFieldError, type InstanceConfig } from '@workbasehq/core/config'
import { plan } from '@workbasehq/core/migrations/planner'
import { quote } from '@workbasehq/core/migrations/schema'
import { changeSchema, fail, WorkflowError, type Change, type Index } from './schemas.ts'
import { effectivePolicies } from './policies.ts'
import { roleNamePrivileges } from '@workbasehq/core/organization-permissions'

export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
/** Named rebuild guards carry the physical difference through SQLite and D1. */
export function migrationBlockReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const detail = message.match(/rebuild_requires_review_([a-z0-9_]+)_(rowid|columns|indexes|foreign_keys|inline_constraints|triggers|incoming_actions)\b/)
  if (detail) return `Rebuild blocked for ${detail[1]}: physical ${detail[2].replaceAll('_', ' ')} differs from the fresh configured schema; a manually reviewed migration is required`
  if (message.includes('rebuild_requires_review')) return 'Rebuild blocked: physical schema or foreign key validation requires a manually reviewed migration'
}
const own = (object: object, key: string) => Object.hasOwn(object, key)
export function guard(changes: Change[], config: InstanceConfig) {
  const entities = new Set(Object.keys(config.entities))
  const roles = new Set(config.roles)
  const protectedField = (entity: string, field: string, rename = false) => {
    if (baseFields.includes(field)) fail('protected_field', `System field cannot be changed: ${field}`)
    if (devFixtures?.protectedField(config, entity, field, rename) ||
        config.entities[entity]?.checks.some(c => c.left === field || c.right === field) ||
        config.entities[entity]?.fields[field]?.readOnly) fail('protected_field', `Command/rule field cannot be changed: ${entity}.${field}`)
  }
  for (const c of changes) {
    // Direct planner callers must obey the same schema and role contract as MCP tools.
    if (!changeSchema.safeParse(c).success) fail('invalid_input', 'Input does not match the change schema')
    // Presentation changes may label read-only/system fields, and never mutate them.
    // Resolve field targets against the evolving copy in prepareChanges below.
    if (c.kind === 'add_role' || c.kind === 'remove_role') {
      if ([config.organizationOwnerRole, 'member'].includes(c.role)) fail('builtin_role', `Built-in role cannot be added or removed: ${c.role}`)
      if (c.kind === 'add_role') {
        if (roleNamePrivileges(c.role).size) fail('builtin_role', `Role has implicit runtime privileges and cannot start empty: ${c.role}`)
        if (roles.has(c.role)) fail('role_exists', `Role already exists: ${c.role}`)
        roles.add(c.role)
      } else {
        if (!roles.delete(c.role)) fail('unknown_role', `Unknown role: ${c.role}`)
      }
      continue
    }
    if (c.kind === 'set_permissions' || c.kind === 'set_organization_permissions') {
      if (!roles.has(c.role)) fail('unknown_role', `Unknown role: ${c.role}`)
      if (c.kind === 'set_permissions' && !entities.has(c.entity)) fail('unknown_entity', `Unknown entity: ${c.entity}`)
      continue
    }
    if (c.kind === 'set_locale') continue
    if (c.kind === 'set_label') {
      if (!entities.has(c.entity)) fail('unknown_entity', `Unknown entity: ${c.entity}`)
      continue
    }
    if (c.kind === 'add_entity') {
      for (const role of Object.keys(c.permissions ?? {})) if (!roles.has(role)) {
        fail('unknown_role', `Unknown permission role: ${c.entity}.${role}; declared roles: ${config.roles.join(', ')}`)
      }
    }
    if (c.kind === 'add_entity' || c.kind === 'set_policy') {
      const policyRoles = c.kind === 'add_entity' ? Object.keys(c.policies ?? {}) : [c.role]
      for (const role of policyRoles) if (!roles.has(role)) fail('unknown_role', `Unknown policy role: ${c.entity}.${role}`)
    }
    if (c.kind === 'add_entity') {
      entities.add(c.entity)
      for (const field of Object.keys(c.fields)) protectedField(c.entity, field)
    } else if (c.kind === 'set_policy' || c.kind === 'set_display_field' || c.kind === 'set_computed_field') { if (!entities.has(c.entity)) fail('unknown_entity', `Unknown entity: ${c.entity}`) }
    else if (c.kind === 'rename_field') { protectedField(c.entity, c.from, true); protectedField(c.entity, c.to, true) }
    else if (c.kind === 'add_user_link') { if (!entities.has(c.entity)) fail('unknown_entity', `Unknown entity: ${c.entity}`) }
    else if (c.kind === 'add_field' || c.kind === 'add_computed_field' || c.kind === 'add_relation') protectedField(c.entity, c.field)
    else for (const field of c.fields) protectedField(c.entity, field)
  }
}
export function indexSQL(index: Index) {
  // Every index is organization-scoped; agents cannot create global uniqueness constraints.
  return `CREATE INDEX ${quote(index.name)} ON ${quote(index.entity)} (${['organization_id', ...index.fields].map(quote).join(', ')});`
}
// Check operations against a private evolving copy, without requiring the whole
// legacy schema to be repaired in a single proposal.
export function prepareChanges(config: InstanceConfig, existingIndexes: Index[], changes: Change[]) {
  guard(changes, config)
  const next = cloneInstanceConfig(config)
  const indexes = structuredClone(existingIndexes)
  // Rename hints describe a single transition, never carry them into the next one.
  for (const entity of Object.values(next.entities)) for (const f of Object.values(entity.fields)) delete f.renameFrom
  for (const c of changes) {
    if (c.kind === 'add_role' || c.kind === 'remove_role') {
      if (c.kind === 'add_role') {
        next.roles.push(c.role)
        next.permissions[c.role] = Object.fromEntries(Object.keys(next.entities).map(entity => [entity, []]))
        next.organizationPermissions[c.role] = []
      } else {
        // All semantic role references validated by defineInstance/validatePolicies:
        // owner role, permission keys, organization grants, policy role keys,
        // navigation item roles and account.managedBy. Provider declarations are
        // synchronized below; arbitrary field enum values are application data.
        const references = [
          ...(own(next.permissions, c.role) ? ['permissions'] : []),
          ...(own(next.organizationPermissions, c.role) ? ['organizationPermissions'] : []),
          ...Object.entries(next.policies).filter(([, policies]) => own(policies, c.role)).map(([entity]) => `policies.${entity}`),
          ...(next.ui?.navigation?.items.filter(item => item.roles?.includes(c.role)).map(item => `ui.navigation.items.${item.id}.roles`) ?? []),
          ...(next.account?.managedBy?.includes(c.role) ? ['account.managedBy'] : []),
        ]
        if (references.length) fail('role_in_use', `Role ${c.role} is referenced by ${references.join(', ')}`)
        next.roles = next.roles.filter(role => role !== c.role)
      }
      // The permissions provider owns the role projection. Persist its override
      // alongside roles so reloading generated config cannot restore old roles.
      if (next.plugins?.some(plugin => plugin.name === 'permissions')) {
        next.pluginConfig ??= {}
        next.pluginConfig.permissions = { roles: [...next.roles], ownerRole: next.organizationOwnerRole }
      }
      continue
    }
    if (c.kind === 'set_organization_permissions') {
      next.organizationPermissions[c.role] = [...c.actions]
      continue
    }
    if (c.kind === 'set_permissions') {
      next.permissions[c.role] ??= {}
      next.permissions[c.role][c.entity] = [...c.operations]
      continue
    }
    if (c.kind === 'set_locale') {
      if (c.locale !== undefined) next.locale = c.locale
      if (c.defaultLanguage !== undefined) { next.ui ??= { entities: {} }; next.ui.defaultLanguage = c.defaultLanguage }
      continue
    }
    if (c.kind === 'add_entity') {
      if (own(next.entities, c.entity)) fail('entity_exists', `Entity already exists: ${c.entity}`)
      next.entities[c.entity] = { fields: c.fields as InstanceConfig['entities'][string]['fields'], displayField: c.displayField ?? suggestedDisplayField(c), relations: {}, checks: [] }
      for (const role of next.roles) {
        next.permissions[role] ??= {}
        next.permissions[role][c.entity] = c.permissions?.[role] ?? []
      }
      if (c.policies) next.policies[c.entity] = structuredClone(c.policies)
      continue
    }
    if (!own(next.entities, c.entity)) fail('unknown_entity', `Unknown entity: ${c.entity}`)
    const e = next.entities[c.entity]
    if (c.kind === 'set_label') {
      // defineInstance generates this field after all proposal changes are applied.
      const generatedDisplay = c.field === DISPLAY_VALUE && e.displayField !== undefined && isExpression(e.displayField)
      if (c.field !== undefined && !own(e.fields, c.field) && !baseFields.includes(c.field) && !generatedDisplay) fail('unknown_field', `Unknown field: ${c.entity}.${c.field}`)
      next.enumLabels ??= {}
      const labels = next.enumLabels[c.language] ??= {}
      if (c.field !== undefined) labels[`field_${c.field}_${c.entity}`] = c.label!
      else {
        if (c.singular !== undefined) labels[`entitySingular_${c.entity}`] = c.singular
        if (c.plural !== undefined) labels[`entity_${c.entity}`] = c.plural
        if (c.object !== undefined) labels[`entityObject_${c.entity}`] = c.object
      }
    } else if (c.kind === 'set_policy') {
      next.policies[c.entity] ??= {}
      next.policies[c.entity][c.role] = structuredClone(c.policy)
    } else if (c.kind === 'set_display_field') {
      if (e.displayExpression) { delete e.fields[DISPLAY_VALUE]; delete e.displayExpression }
      delete e.label
      e.displayField = c.displayField
      if (isExpression(c.displayField)) continue
      const errors = displayFieldErrors(next, [c.entity])
      if (!errors.length && e.fields[c.displayField]?.sensitive) errors.push({ code: 'invalid_display_field', entity: c.entity,
        message: `Invalid displayField: ${c.entity}; set_display_field requires a non-sensitive scalar field.` })
      if (errors.length) throw new WorkflowError('invalid_input', errors.map(error => error.message).join('\n'), 400, errors)
    } else if (c.kind === 'set_computed_field') {
      if (!e.fields[c.field]?.computed) fail('invalid_input', `Cannot replace stored or unknown field ${c.entity}.${c.field}; add_computed_field with a new field name to preserve stored data.`)
      e.fields[c.field].computed = c.computed
      if (e.displayExpression && c.field === DISPLAY_VALUE) e.displayExpression = c.computed
    } else if (c.kind === 'add_field' || c.kind === 'add_computed_field') {
      if (own(e.fields, c.field)) fail('field_exists', `Field already exists: ${c.entity}.${c.field}`)
      e.fields[c.field] = c.definition as InstanceConfig['entities'][string]['fields'][string]
    } else if (c.kind === 'rename_field') {
      if (e.fields[c.from]?.userLink) fail('protected_field', `User link cannot be renamed: ${c.entity}.${c.from}`)
      if (!own(e.fields, c.from)) fail('unknown_field', `Unknown field: ${c.entity}.${c.from}`)
      if (own(e.fields, c.to)) fail('field_exists', `Rename target already exists: ${c.to}`)
      if (indexes.some(i => i.entity === c.entity && i.fields.includes(c.to))) fail('invalid_index', 'Rename target is already indexed')
      // Cascaded snapshots encode field names in runtime config: fail closed rather than rewriting domain rules.
      if (Object.values(next.entities).some(entity => Object.values(entity.fields).some(f => f.backfillFrom &&
        ((entity === e && f.backfillFrom.refField === c.from) ||
         (entity.fields[f.backfillFrom.refField]?.entity === c.entity && f.backfillFrom.valueField === c.from))))) {
        fail('protected_field', 'A snapshot depends on this field; manual review required')
      }
      e.fields[c.to] = { ...e.fields[c.from], renameFrom: c.from }
      delete e.fields[c.from]
      if (e.displayField === c.from) e.displayField = c.to
      const display = next.ui?.entities[c.entity]
      const renamed = (field: string) => field === c.from ? c.to : field
      for (const view of Object.values(display?.form ?? {})) view.fields = view.fields.map(renamed)
      for (const section of display?.sections ?? []) section.fields = section.fields.map(renamed)
      const renameItem = (item: NonNullable<NonNullable<NonNullable<InstanceConfig['ui']>['entities'][string]['detail']>['summary']>[number]) => typeof item === 'string' ? renamed(item) : { ...item, field: renamed(item.field), ...(item.when ? { when: { ...item.when, field: renamed(item.when.field) } } : {}) }
      if (display?.views) display.views = display.views.map(view => ({ ...view, startField: renamed(view.startField), ...(view.endField ? { endField: renamed(view.endField) } : {}), ...(view.titleField ? { titleField: renamed(view.titleField) } : {}), ...(view.titleFields ? { titleFields: view.titleFields.map(renamed) } : {}), ...(view.secondaryField ? { secondaryField: renamed(view.secondaryField) } : {}) }))
      const detail = display?.detail
      if (detail) {
        if (detail.fields) detail.fields = detail.fields.map(renamed)
        if (detail.summary) detail.summary = detail.summary.map(renameItem)
        for (const group of detail.groups ?? []) group.fields = group.fields.map(renameItem)
        for (const metric of detail.metrics ?? []) { metric.field = renamed(metric.field); if (metric.unitField) metric.unitField = renamed(metric.unitField) }
      }
      for (const [source, hints] of Object.entries(next.ui?.entities ?? {})) for (const [name, related] of Object.entries(hints.detail?.relations ?? {})) {
        if (next.entities[source].relations[name]?.entity !== c.entity) continue
        related.columns = related.columns.map(renamed)
        if (related.defaultSort) related.defaultSort.key = renamed(related.defaultSort.key)
      }
      const list = display?.list
      if (list) {
        if (list.columns) list.columns = list.columns.map(renamed)
        if (list.search) list.search = list.search.map(renamed)
        if (list.defaultSort) list.defaultSort.key = renamed(list.defaultSort.key)
        if (list.filter) list.filter = Object.fromEntries(Object.entries(list.filter).map(([key, hint]) => [renamed(key), hint]))
        if (list.sort) {
          // Preserve configured key order, including disabled sort keys.
          if (own(list.sort, c.from) && own(list.sort, c.to)) fail('invalid_input', 'Rename target already has a UI sort hint')
          list.sort = Object.fromEntries(Object.entries(list.sort).map(([key, hint]) => [renamed(key), hint && { fields: hint.fields.map(renamed) }]))
        }
      }
      const renameWhere = (where: Record<string, unknown>, entity: string): Record<string, unknown> => Object.fromEntries(Object.entries(where).map(([key, value]) => {
        if (key === 'and' || key === 'or') return [key, (value as Record<string, unknown>[]).map(child => renameWhere(child, entity))]
        if (key === 'not') return [key, renameWhere(value as Record<string, unknown>, entity)]
        const relation = next.entities[entity].relations[key]
        if (relation) return [key, relation.many ? Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([quantifier, child]) => [quantifier, renameWhere(child, relation.entity)])) : renameWhere(value as Record<string, unknown>, relation.entity)]
        return [entity === c.entity && key === c.from ? c.to : key, value]
      }))
      for (const [entity, hints] of Object.entries(next.ui?.entities ?? {})) if (hints.list?.views) hints.list.views = hints.list.views.map(view => ({ ...view, where: renameWhere(view.where, entity) }))
      for (const r of Object.values(e.relations)) if (r.field === c.from) r.field = c.to
      for (const i of indexes) if (i.entity === c.entity) i.fields = i.fields.map(f => f === c.from ? c.to : f)
    } else if (c.kind === 'add_user_link') {
      if (next.account?.entity !== 'users' || c.entity === 'users') fail('invalid_user_link', 'User links require account.entity: users and a domain entity')
      if (Object.values(e.fields).some(field => field.userLink)) fail('user_link_exists', `User link already exists: ${c.entity}`)
      if (own(e.fields, 'user')) fail('field_exists', `Field already exists: ${c.entity}.user`)
      if (own(e.relations, 'user_account')) fail('relation_exists', `Relation already exists: ${c.entity}.user_account`)
      e.fields.user = { type: 'ref', entity: 'users', required: false, userLink: true, readOnly: true }
      e.relations.user_account = { field: 'user', entity: 'users' }
    } else if (c.kind === 'add_relation') {
      if (own(e.relations, c.name)) fail('relation_exists', `Relation already exists: ${c.name}`)
      if (!own(e.fields, c.field)) e.fields[c.field] = { type: 'ref', entity: c.target, required: false }
      if (e.fields[c.field].type !== 'ref' || e.fields[c.field].entity !== c.target) fail('invalid_relation', 'Relation must use a matching ref field')
      e.relations[c.name] = { field: c.field, entity: c.target }
    } else {
      if (indexes.some(i => i.name === c.name) || c.name.startsWith('sqlite_') || c.name.startsWith('d1_')) fail('index_exists', `Index name is reserved or already used: ${c.name}`)
      if (new Set(c.fields).size !== c.fields.length || c.fields.some(f => !own(e.fields, f) || e.fields[f].computed)) fail('unknown_field', 'Index must name distinct configured fields')
      indexes.push({ entity: c.entity, name: c.name, fields: c.fields })
    }
  }
  return { next, indexes }
}
export function prepare(config: InstanceConfig, existingIndexes: Index[], changes: Change[]) {
  const { next, indexes } = prepareChanges(config, existingIndexes, changes)
  next.revision++
  let target: InstanceConfig
  try { target = defineInstance(next) }
  catch (error) {
    if (error instanceof ExpressionError) throw new WorkflowError('invalid_input', error.message, 400, error.errors)
    if (isDisplayFieldError(error)) throw new WorkflowError('invalid_input', error.message, 400, error.errors)
    throw error
  }
  // A table rebuild also recreates existing supplemental indexes, including any
  // field renames in this proposal. New indexes are still appended below.
  const result = plan(config, target, { indexes: indexes.filter(index => existingIndexes.some(old => old.name === index.name)) })
  if (result.blocked.length || result.destructive.length) fail('migration_blocked', result.blocked.join('; '))
  // Core owns entity/column/ref SQL; supplemental non-unique indexes have a small typed planner here.
  const additions = indexes.filter(i => !existingIndexes.some(old => old.name === i.name))
  const sql = result.sql + additions.map(indexSQL).join('\n') + (additions.length ? '\n' : '')
  const before = { config, indexes: existingIndexes }
  const after = { config: target, indexes }
  const policyWarnings = Object.entries(effectivePolicies(target)).flatMap(([entity, roles]) =>
    Object.entries(roles).filter(([role, policy]) => target.permissions[role]?.[entity]?.length && policy === 'none')
      .map(([role]) => `${entity}.${role} grants permissions but its effective policy is 'none'; use set_policy to configure it.`))
  return { target, indexes, sql, patch: jsonPatch(before, after), warnings: [...result.warnings, ...policyWarnings] }
}
export type Patch = { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown }
function jsonPatch(before: unknown, after: unknown, path = ''): Patch[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => {
      const p = `${path}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`
      return !own(b, k) ? [{ op: 'remove', path: p } as Patch] : !own(a, k) ? [{ op: 'add', path: p, value: b[k] } as Patch] : jsonPatch(a[k], b[k], p)
    })
  }
  return [{ op: 'replace', path, value: after }]
}
