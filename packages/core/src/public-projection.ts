import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { RuntimeOptions } from './types'
import { fieldsFor, fieldType, operatorsFor } from './query/input-schema'
import { QUERY_LIMITS } from './query/limits'
import { publicOutputSchema } from './openapi/input-projection'

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
export function publicCommands(config: InstanceConfig, options: RuntimeOptions, transformInputs = false) {
  return publicCommandDefinitions(config, options).map(({ name, command }) => ({ name, permission: command.permission, ...(command.ui ? { ui: command.ui } : {}),
    additionalPermissions: command.additionalPermissions ?? [], inputSchema: sanitizeSchema(transformInputs ? transformTolerantSchema(command.input) : z.toJSONSchema(command.input)) }))
}
/** Legacy output conversion stays the only path for every transform-free command,
 * so its /schema bytes are unchanged by construction. Only a command whose graph
 * contains a transform uses the disclosure-filtered projection. The check is
 * structural: converting first would evaluate default factories before throwing. */
function transformTolerantSchema(input: z.ZodType) {
  return containsTransform(input) ? publicOutputSchema(input) : z.toJSONSchema(input)
}
/** Walks every Zod child reachable from a schema definition, whatever key holds it,
 * so a new or rarely used container type (function args/returns, promise, ...) can
 * never hide a transform. Accessors are never invoked; object shapes and lazy
 * schemas are resolved explicitly. */
const isZod = (value: unknown): value is z.core.$ZodType => !!value && typeof value === 'object' && '_zod' in value
function containsTransform(schema: z.core.$ZodType, seen = new Set<z.core.$ZodType>()): boolean {
  if (seen.has(schema)) return false
  seen.add(schema)
  const def = schema._zod.def as any
  if (def.type === 'transform') return true
  const children: z.core.$ZodType[] = []
  const collect = (value: unknown, depth: number): void => {
    if (isZod(value)) children.push(value)
    else if (depth < 2 && Array.isArray(value)) value.forEach(item => collect(item, depth + 1))
    else if (depth < 2 && value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) Object.values(value).forEach(item => collect(item, depth + 1))
  }
  // Data properties only: accessors such as default/prefault `defaultValue` run user factories.
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(def))) if ('value' in descriptor) collect(descriptor.value, 0)
  if (def.type === 'object') children.push(...Object.values(def.shape as Record<string, z.core.$ZodType>))
  if (def.type === 'lazy') children.push((schema as z.core.$ZodLazy)._zod.innerType)
  return children.some(child => containsTransform(child, seen))
}
