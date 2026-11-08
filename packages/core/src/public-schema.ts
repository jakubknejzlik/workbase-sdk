import { z } from 'zod'
import { labelDependencies } from './query/labels'
import { fieldsFor, fieldType, operatorsFor } from './query/schema'
import { QUERY_LIMITS } from './query/limits'
import type { InstanceConfig } from './config'
import type { RuntimeOptions } from './types'

// These objects map user-defined names to schemas; their keys are not keywords.
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
function sanitizeSchema(value: unknown, sensitive = false): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeSchema(item, sensitive))
  if (value === null || typeof value !== 'object') return value
  const node = value as Record<string, unknown>
  sensitive ||= node.sensitive === true
  return Object.fromEntries(Object.entries(node).flatMap(([key, item]) => {
    if (['default', 'examples', 'const'].includes(key) || (sensitive && key === 'description')) return []
    return [[key, schemaMaps.has(key) && item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, sanitizeSchema(schema, sensitive)]))
      : sanitizeSchema(item, sensitive)]]
  }))
}

/** Anonymous build metadata: explicit entity projection, sanitized input schemas. */
export function publicSchema(config: InstanceConfig, options: RuntimeOptions) {
  return {
    instance: config.id, revision: config.revision,
    ...(config.displayName ? { displayName: config.displayName } : {}),
    ...(config.ui ? { ui: config.ui } : {}),
    entities: Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, {
      ...(entity.displayField ? { displayField: entity.displayField } : {}),
      ...(entity.label ? { labelDependencies: labelDependencies(config, name) } : {}),
      fields: Object.fromEntries(Object.entries(entity.fields).map(([fieldName, field]) => [fieldName, {
        type: field.type, required: field.required,
        ...(field.values === undefined ? {} : { values: field.values }),
        ...(field.entity === undefined ? {} : { entity: field.entity }),
        ...(field.readOnly === undefined ? {} : { readOnly: field.readOnly }),
        ...(field.sensitive === undefined ? {} : { sensitive: field.sensitive }),
        ...(field.ui === undefined ? {} : { ui: field.ui }),
      }])),
    }])),
    query: {
      format: 'filter-object', required: ['entity', 'limit'], combinators: ['and', 'or', 'not'],
      limits: QUERY_LIMITS,
      entities: Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, {
        fields: Object.fromEntries(fieldsFor(config, name).map(field => [field, { type: fieldType(config, name, field), operators: operatorsFor(fieldType(config, name, field)) }])),
        relations: Object.fromEntries(Object.entries(entity.relations).map(([key, relation]) => [key, {
          entity: relation.entity, field: relation.field, cardinality: relation.many ? '1:n' : 'n:1',
          ...(relation.through ? { through: relation.through } : {}),
          ...(relation.many ? { quantifiers: ['some', 'none'] } : {}),
        }])),
      }])),
    },
    policies: Object.fromEntries(Object.entries(config.policies).map(([entity, roles]) => [entity, Object.fromEntries(Object.keys(roles).map(role => [role, true]))])),
    capabilities: { path: '/o/:org/capabilities', authentication: 'required' },
    roles: config.roles, permissions: config.permissions,
    commands: config.commands.flatMap(name => {
      const command = options.commands?.get(name)
      return command && !('system' in command.permission) ? [{ name, permission: command.permission, ...(command.ui ? { ui: command.ui } : {}),
        additionalPermissions: command.additionalPermissions ?? [], inputSchema: sanitizeSchema(z.toJSONSchema(command.input)) }] : []
    }),
    workflows: [...(options.workflows?.values() ?? [])].map(workflow => ({ name: workflow.name, version: workflow.version,
      inputSchema: sanitizeSchema(z.toJSONSchema(workflow.input)),
      permissions: workflow.steps?.map(step => ({ name: step.operation.name, permission: step.operation.permission })),
    })),
  }
}
