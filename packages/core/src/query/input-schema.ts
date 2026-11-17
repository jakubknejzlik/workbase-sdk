import { z } from 'zod'
import { baseFields } from '../model-inputs'
import type { Field, InstanceConfig } from '../config'
import { QUERY_LIMITS as L } from './limits'
import { labelPath } from './labels'

export type Scalar = string | number | boolean | null
export interface Filter { [key: string]: unknown }
export interface Order { field: string; dir: 'asc' | 'desc'; label?: boolean }
export interface Selection { labels?: string[]; select?: string[]; where?: Filter; orderBy?: Order[]; limit?: number; include?: Record<string, Selection> }
export type RowAccessState = 'no_account' | 'invited' | 'expired' | 'signed_in'
export interface QueryInput extends Selection { rowAccess?: RowAccessState; contextList?: { entity: string; list: string; id: string }; search?: { text: string; fields: string[]; locale?: 'en' | 'cs' }; labelWhere?: Record<string, { contains: string; locale?: 'en' | 'cs' }>; entity: string; limit: number; cursor?: string }
export const fieldsFor = (config: InstanceConfig, entity: string) => [...baseFields, ...Object.keys(config.entities[entity].fields)]
export function fieldType(config: InstanceConfig, entity: string, field: string): Field['type'] {
  return config.entities[entity].fields[field]?.type ?? (field === 'version' ? 'int' : ['created_at', 'updated_at'].includes(field) ? 'datetime' : 'string')
}
export function operatorsFor(type: Field['type']) {
  return ['eq', 'ne', 'in', ...(['bool'].includes(type) ? [] : ['lt', 'lte', 'gt', 'gte']),
    ...(['string', 'text'].includes(type) ? ['contains'] : []), 'isNull']
}
function valueSchema(config: InstanceConfig, entity: string, field: string, rest: boolean) {
  const type = fieldType(config, entity, field)
  // crud.ts accepted all finite numeric operands (also for int fields), and did
  // not impose the write validator's string lengths on URL filter operands.
  if (rest) return type === 'bool' ? z.boolean() : ['int', 'float'].includes(type) ? z.number().finite() : z.string()
  return type === 'bool' ? z.boolean() : type === 'int' ? z.number().int().safe()
    : type === 'float' ? z.number().finite() : z.string().max(2_000)
}
/** Shared client/policy grammar; only trusted configuration enables actor predicates. */
export function filterSchema(config: InstanceConfig, rest = false, maxDepth = L.relationDepth as number,
  actorValues?: (type: Field['type']) => z.ZodType) {
  const filters = new Map<string, z.ZodType>()
  function filter(name: string, depth: number): z.ZodType {
    const key = `${name}:${depth}`
    const cached = filters.get(key); if (cached) return cached
    const schema: z.ZodType = z.lazy(() => {
      const shape: Record<string, z.ZodType> = Object.create(null)
      for (const field of fieldsFor(config, name)) {
        const scalar = (valueSchema(config, name, field, rest) as z.ZodType).refine((value: unknown) => !actorValues || typeof value !== 'string' || !value.startsWith('$actor.'), 'Actor values require a declared compatible field'); const value = actorValues ? z.union([scalar, actorValues(fieldType(config, name, field))]) : scalar; const ops: Record<string, z.ZodType> = Object.create(null)
        for (const op of rest ? ['eq', 'lt', 'lte', 'gt', 'gte'] : operatorsFor(fieldType(config, name, field))) ops[op] =
          (op === 'isNull' ? (actorValues ? z.union([z.boolean(), actorValues('bool')]) : z.boolean()) : op === 'in' ? z.array(value.nullable()).max(L.bindings)
            : op === 'eq' || op === 'ne' ? value.nullable() : value).optional()
        shape[field] = z.strictObject(ops).refine(v => Object.keys(v).length > 0).optional()
      }
      if (depth < maxDepth) for (const [relation, r] of Object.entries(config.entities[name].relations)) {
        const child = filter(r.entity, depth + 1)
        shape[relation] = (r.many ? z.union([z.strictObject({ some: child }), z.strictObject({ none: child })]) : child).optional()
      }
      if (actorValues) shape.actorLinkedIn = z.string().refine(entity =>
        Object.hasOwn(config.entities, entity) && Object.values(config.entities[entity].fields).some(field => field.userLink),
      'actorLinkedIn requires an entity with a protected user link').optional()
      shape.and = z.array(schema).min(1).max(L.nodes).optional()
      shape.or = z.array(schema).min(1).max(L.nodes).optional()
      shape.not = schema.optional()
      return z.strictObject(shape)
    })
    filters.set(key, schema); return schema
  }
  return filter
}
/** Generated from the complete model. No library AST/raw/functions are client input. */
export function querySchema(config: InstanceConfig, entity: string, rest = false) {
  const filter = filterSchema(config, rest)
  function selection(name: string, depth: number, root: boolean): z.ZodType {
    const names = fieldsFor(config, name) as [string, ...string[]]
    const labelNames = [...names.filter(key => labelPath(config, name, key)), ...Object.keys(config.ui?.entities?.[name]?.list?.relatedColumns ?? {})] as [string, ...string[]]
    const shape: Record<string, z.ZodType> = {
      select: z.array(z.enum(names)).min(1).max(names.length).refine(v => new Set(v).size === v.length).optional(),
      where: filter(name, depth).optional(),
      orderBy: z.array(z.strictObject({ field: z.enum(root ? [...new Set([...names, ...labelNames])] as [string, ...string[]] : names), dir: z.enum(['asc', 'desc']), ...(root ? { label: z.boolean().optional() } : {}) })).max(5)
        .refine(v => new Set(v.map(o => o.field)).size === v.length).optional(),
      limit: root ? z.number().int().min(1).max(L.root) : z.number().int().min(1).max(L.children).optional(),
    }
    if (depth < L.relationDepth) shape.include = z.strictObject(Object.fromEntries(Object.entries(config.entities[name].relations)
      .map(([key, r]) => [key, z.lazy(() => selection(r.entity, depth + 1, false)).optional()]))).optional()
    if (root) {
      if (labelNames.length) {
        shape.labelWhere = z.partialRecord(z.enum(labelNames), z.strictObject({ contains: z.string().min(1).max(2000), locale: z.enum(['en', 'cs']).optional() })).optional()
        shape.labels = z.array(z.enum(labelNames)).max(L.relations).refine(v => new Set(v).size === v.length).optional()
      }
      shape.search = z.strictObject({ text: z.string().min(1).max(2000), fields: z.array(z.enum([...new Set([...names, ...labelNames])] as [string, ...string[]])).min(1).max(names.length + labelNames.length).refine(v => new Set(v).size === v.length), locale: z.enum(['en', 'cs']).optional() }).optional()
      shape.contextList = z.strictObject({ entity: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100), list: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100), id: z.string().min(1).max(2000) }).optional()
      shape.rowAccess = z.enum(['no_account', 'invited', 'expired', 'signed_in']).optional()
      shape.entity = z.literal(name); shape.cursor = z.string().min(1).max(L.cursorBytes).optional()
    }
    return z.strictObject(shape)
  }
  return selection(entity, 0, true)
}
