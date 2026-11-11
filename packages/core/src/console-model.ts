import { canGrantRole, organizationPermission } from './organization-permissions'
import { z } from 'zod'
import { bodyValidator } from './config'
import { capabilities } from './capabilities'
import { scopeMiddleware } from './authorization'
import { fieldsFor, fieldType, operatorsFor } from './query/schema'
import { labelDependencies } from './query/labels'
import { QUERY_LIMITS } from './query/limits'
import { consolePresentation } from './console-presentation'
import { consoleAuthorization } from './console-authorization'
import { consoleInputSchema } from './console-input-schema'
import type { KernelRegistry } from './kernel/registry'
import type { App, RuntimeEnv, Scope } from './types'
import type { ConsoleInputSchema, ConsoleModelContract, ConsoleRuntimeModel } from './console-contract'

/** No instance-source imports or private catalog: project the resolved runtime kernel. */
export function consoleModel(kernel: KernelRegistry, scope: Scope): ConsoleModelContract {
  const config = kernel.config
  const caps = capabilities(kernel, scope)
  const authority = consoleAuthorization(kernel, scope, caps)
  const presentation = consolePresentation(kernel, scope, authority)
  const entities: ConsoleRuntimeModel['entities'] = Object.fromEntries(Object.entries(config.entities).filter(([name]) => authority.canRead(name)
    || authority.operation(name, 'create') || authority.operation(name, 'update')).map(([name, entity]) => {
    function entityInputSchema(partial = false) {
      const schema = z.toJSONSchema(bodyValidator(entity, partial), { io: 'input' }) as ConsoleInputSchema
      // Preserve sensitivity and the read decision across conversion. Redact only
      // after conversion so server defaults retain their original input requiredness.
      const literalGrants = new WeakMap<object, boolean>()
      schema.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, ConsoleInputSchema>)
        .filter(([field]) => authority.write(name, field, partial ? 'update' : 'create')).map(([field, property]) => {
          const projected: ConsoleInputSchema = { ...property, ...(entity.fields[field].sensitive ? { sensitive: true } : {}) }
          literalGrants.set(projected, authority.literals(name, field))
          if (!authority.defaults(name, field)) delete projected.default
          return [field, projected]
        }))
      if (Array.isArray(schema.required)) schema.required = schema.required.filter(field => Object.hasOwn(schema.properties as object, field))
      return consoleInputSchema(schema, node => authority.schema(node) && literalGrants.get(node) !== false)
    }
    let rowInvitations = false
    if (kernel.providers.has('members') && authority.read(name, 'id') && Object.values(entity.fields).some(field => field.userLink)) {
      try { kernel.permission(scope, name, 'create'); kernel.resourcePermission(scope, 'invitations.create'); organizationPermission(config, scope, 'invitations.create'); rowInvitations = canGrantRole(config, scope.role, 'member') } catch {}
    }
    const display = authority.canRead(name) && config.ui?.entities[name] ? presentation.display(name, config.ui.entities[name]) : undefined
    const displayField = entity.displayField && authority.read(name, entity.displayField) ? entity.displayField : undefined
    return [name, {
      ...display,
      ...(rowInvitations ? { rowInvitations: true } : {}),
      fields: Object.fromEntries(fieldsFor(config, name).filter(field => authority.read(name, field)).map(field => {
        const definition = entity.fields[field]
        const type = fieldType(config, name, field)
        return [field, {
          type, required: definition?.required ?? true, nullable: definition ? !definition.required : false,
          operators: operatorsFor(type),
          ...(definition ? {
            ...(definition.values === undefined || !authority.literals(name, field) ? {} : { values: definition.values }),
            ...(definition.entity === undefined || !authority.canRead(definition.entity) ? {} : { entity: definition.entity }),
            ...(definition.min === undefined ? {} : { min: definition.min }),
            ...(definition.default === undefined || !authority.defaults(name, field) ? {} : { default: definition.default }),
            ...(definition.readOnly === undefined ? {} : { readOnly: definition.readOnly }),
            ...(definition.sensitive === undefined ? {} : { sensitive: definition.sensitive }),
            ...(definition.ui === undefined ? {} : { ui: presentation.fieldUI(name, definition.ui) }),
          } : { readOnly: true }),
        }]
      })),
      columns: Object.keys(entity.fields).filter(field => authority.read(name, field)),
      ...(display?.list?.columns ? { listColumns: display.list.columns } : {}),
      listLimit: Math.min(30, QUERY_LIMITS.root),
      ...(displayField ? { displayField } : {}),
      ...(entity.label && displayField ? { labelDependencies: labelDependencies(config, name).filter(dependency => authority.read(dependency.entity, dependency.field)) } : {}),
      relations: Object.fromEntries(Object.entries(entity.relations).filter(([key]) => authority.relation(name, key)).map(([key, relation]) => [key, {
        entity: relation.entity, field: relation.field, cardinality: relation.many ? '1:n' as const : 'n:1' as const,
        ...(relation.through ? { through: relation.through } : {}),
        ...(relation.many ? { quantifiers: ['some', 'none'] } : {}),
      }])),
      commandsOnly: entity.commandsOnly ?? false,
      checks: entity.checks.filter(check => authority.read(name, check.left) && authority.read(name, check.right)),
      indexes: [
        { name: `${name}_org_idx`, fields: ['organization_id', 'id'], unique: false },
        ...Object.entries(entity.fields).filter(([, field]) => field.type === 'ref' && !field.computed).map(([field]) => ({
          name: `${name}_${field}_idx`, fields: ['organization_id', field], unique: false,
        })),
      ].filter(index => index.fields.every(field => authority.read(name, field))),
      writeSchema: entityInputSchema(),
      updateSchema: entityInputSchema(true),
      routes: { list: `/o/$orgId/e/${name}`, detail: `/o/$orgId/e/${name}/$id` },
    }]
  }))
  return {
    contractVersion: 1,
    model: {
      instance: config.id, revision: config.revision,
      ...(config.displayName ? { displayName: config.displayName } : {}),
      locale: config.locale, timeZone: config.timeZone,
      ...(config.enumLabels || Object.values(config.entities).some(entity => entity.displayExpression) ? { enumLabels: Object.fromEntries([...new Set(['en', 'cs', ...Object.keys(config.enumLabels ?? {})])].flatMap(language => {
        const labels = config.enumLabels?.[language] ?? {}
        // Catalogs use language -> translation key, matching query search and i18next.
        const keys = new Set(Object.entries(config.entities).flatMap(([name, entity]) => Object.entries(entity.fields)
          .filter(([field]) => authority.literals(name, field)).flatMap(([, field]) => {
            const values = field.type === 'enum' ? (field.values ?? []).map(value => `value_${value}`) : field.type === 'bool' ? ['yes', 'no'] : []
            return values.flatMap(key => [key, `${key}_${name}`])
          })))
        for (const name of Object.keys(config.entities)) {
          if (authority.canRead(name)) for (const prefix of ['entity', 'entitySingular', 'entityObject']) keys.add(`${prefix}_${name}`)
          for (const field of fieldsFor(config, name)) if (authority.literals(name, field)) keys.add(`field_${field}_${name}`)
        }
        const dictionary = Object.fromEntries(Object.entries(labels).filter(([key]) => keys.has(key)))
        for (const [name, entity] of Object.entries(config.entities)) if (entity.displayExpression && entity.displayField && authority.read(name, entity.displayField)) {
          const title = labels[`entitySingular_${name}`] ?? labels[`entity_${name}`] ?? name.replaceAll('_', ' ').replace(/^./, first => first.toUpperCase())
          dictionary[`field_${entity.displayField}_${name}`] ??= title
          dictionary[`listField_${entity.displayField}_${name}`] = dictionary[`field_${entity.displayField}_${name}`]
        }
        return Object.keys(dictionary).length ? [[language, dictionary]] : []
      })) } : {}),
      ...(config.ui ? { ui: presentation.modelUI(config.ui) } : {}),
      limits: QUERY_LIMITS, entities,
      commands: [...kernel.commands.values()].flatMap(command => caps.commands.includes(command.name) && !('system' in command.permission) ? [{
        name: command.name, permission: command.permission, additionalPermissions: command.additionalPermissions ?? [],
        ...(command.ui ? { ui: { ...command.ui, ...(command.ui.placement && !authority.canRead(command.ui.placement.entity) ? { placement: undefined } : {}) } } : {}), inputSchema: consoleInputSchema(z.toJSONSchema(command.input, { io: 'input' }), authority.schema),
      }] : []),
      workflows: [...kernel.workflows.values()].filter(workflow => caps.workflows[workflow.name]?.includes('start')).map(workflow => ({
        name: workflow.name, version: workflow.version, inputSchema: consoleInputSchema(z.toJSONSchema(workflow.input, { io: 'input' }), authority.schema),
      })),
    },
    capabilities: caps,
    console: (() => {
      const registry = kernel.providers.get('console')?.[0]?.consoleRegistry?.(config, scope)
      return registry ? presentation.registry(registry) : null
    })(),
  }
}

export function consoleModelRoutes(app: App, kernel: KernelRegistry, env: RuntimeEnv) {
  app.get('/o/:org/console-model', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    c.header('Vary', 'Cookie, Authorization, X-Organization-Id')
    await next()
  }, scopeMiddleware(env, kernel.config, kernel), c => c.json(consoleModel(kernel, c.get('scope'))))
}
