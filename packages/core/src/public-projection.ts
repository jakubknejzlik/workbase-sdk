import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { RuntimeOptions } from './types'
import { fieldsFor, fieldType, operatorsFor } from './query/input-schema'
import { QUERY_LIMITS } from './query/limits'

// These objects map user-defined names to schemas; their keys are not keywords.
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
export function sanitizeSchema(value: unknown, sensitive = false): unknown {
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

export function publicQuery(config: InstanceConfig) {
  return {
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
  }
}

/** Shared anonymous allowlists; preserve /schema insertion order and values. */
export function publicFields(entity: InstanceConfig['entities'][string]) {
  return Object.fromEntries(Object.entries(entity.fields).map(([fieldName, field]) => [fieldName, {
    type: field.type, required: field.required,
    ...(field.values === undefined ? {} : { values: field.values }),
    ...(field.entity === undefined ? {} : { entity: field.entity }),
    ...(field.readOnly === undefined ? {} : { readOnly: field.readOnly }),
    ...(field.sensitive === undefined ? {} : { sensitive: field.sensitive }),
    ...(field.ui === undefined ? {} : { ui: field.ui }),
  }]))
}
export function publicPolicies(config: InstanceConfig) {
  return Object.fromEntries(Object.entries(config.policies).map(([entity, roles]) => [entity, Object.fromEntries(Object.keys(roles).map(role => [role, true]))]))
}
export function publicCommandDefinitions(config: InstanceConfig, options: RuntimeOptions) {
  return config.commands.flatMap(name => {
    const command = options.commands?.get(name)
    return command && !('system' in command.permission) ? [{ name, command }] : []
  })
}
export function publicCommands(config: InstanceConfig, options: RuntimeOptions, input = false) {
  const schema = (command: { input: z.ZodType }) => {
    if (!input) return z.toJSONSchema(command.input)
    const projected = z.toJSONSchema(command.input, { io: 'input' })
    // /schema historically exposed output-mode object/default semantics. Keep
    // those bytes for representable schemas; transforms need the input view.
    try { return z.toJSONSchema(command.input) } catch { return projected }
  }
  return publicCommandDefinitions(config, options).map(({ name, command }) => ({ name, permission: command.permission, ...(command.ui ? { ui: command.ui } : {}),
    additionalPermissions: command.additionalPermissions ?? [], inputSchema: sanitizeSchema(schema(command)) }))
}
