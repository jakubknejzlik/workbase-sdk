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
/** Follow only known type-def children: enum/literal data and checks are leaves.
 * Data descriptors skip executable accessors. Shape and lazy resolution use Zod's
 * caches; a failed resolution leaves legacy conversion to decide the outcome. */
function containsTransform(schema: z.core.$ZodType, seen = new Set<z.core.$ZodType>()): boolean {
  if (seen.has(schema)) return false
  seen.add(schema)
  const def = schema._zod.def
  const read = (key: string) => Object.getOwnPropertyDescriptor(def, key)?.value
  const children: z.core.$ZodType[] = []
  const add = (value: unknown) => {
    if ((value as z.core.$ZodType | null)?._zod?.def) children.push(value as z.core.$ZodType)
  }
  const addList = (value: unknown) => { if (Array.isArray(value)) value.forEach(add) }
  switch (read('type')) {
    case 'transform': return true
    case 'optional': case 'nullable': case 'default': case 'prefault':
    case 'nonoptional': case 'success': case 'catch': case 'readonly': case 'promise':
      add(read('innerType')); break
    case 'array': add(read('element')); break
    case 'object':
      try { Object.values((schema as z.core.$ZodObject)._zod.def.shape).forEach(add) } catch { /* Unresolvable shape. */ }
      add(read('catchall')); break
    case 'union': addList(read('options')); break
    case 'intersection': add(read('left')); add(read('right')); break
    case 'tuple': addList(read('items')); add(read('rest')); break
    case 'record': case 'map': add(read('keyType')); add(read('valueType')); break
    case 'set': add(read('valueType')); break
    case 'pipe': add(read('in')); add(read('out')); break
    case 'function': add(read('input')); add(read('output')); break
    case 'lazy':
      try { add((schema as z.core.$ZodLazy)._zod.innerType) } catch { /* Unresolvable lazy. */ }
      break
  }
  return children.some(child => containsTransform(child, seen))
}
