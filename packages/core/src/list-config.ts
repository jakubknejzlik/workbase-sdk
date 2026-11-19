import { z } from 'zod'
import { baseFields } from './model-inputs'
import type { InstanceConfig } from './config'
import { fieldType, filterSchema, operatorsFor } from './query/input-schema'
import type { ListConfig, ListFilterKind, ListOperator } from './list-contract'
export type * from './list-contract'

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/)
const label = z.string().min(1)
const placement = z.enum(['toolbar', 'panel'])
const kind = z.enum(['text', 'enum', 'relation', 'number', 'date', 'boolean'])
const operator = z.enum(['eq', 'in', 'contains', 'gte', 'gt', 'lte', 'lt', 'isNull'])
const cell = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text') }),
  z.strictObject({ kind: z.literal('identifier'), copy: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('badge'), tones: z.record(z.string(), z.enum(['neutral', 'positive', 'warning', 'negative'])).optional() }),
  ...(['date', 'datetime', 'number'] as const).map(kind => z.strictObject({ kind: z.literal(kind) })),
])
/** Syntax only; normalizeListConfig adds model-aware validation and canonical defaults. */
export const listInputSchema = z.strictObject({
  columns: z.array(z.union([identifier, z.strictObject({ field: identifier, label: label.optional(), secondary: identifier.optional(), cell: cell.optional(), defaultVisible: z.boolean().optional() })])).optional(),
  relatedColumns: z.record(identifier, z.strictObject({ via: identifier, field: identifier })).optional(),
  compact: z.boolean().optional(), mobileCards: z.boolean().optional(),
  defaultSort: z.strictObject({ key: identifier, direction: z.enum(['asc', 'desc']) }).optional(),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(50), z.literal(100)]).optional(),
  search: z.array(identifier).optional(),
  filter: z.record(identifier, z.union([z.literal(false), kind, z.strictObject({ kind: kind.optional(), label: label.optional(), placement: placement.optional(), operators: z.array(operator).min(1).refine(ops => new Set(ops).size === ops.length, 'Duplicate filter operator').optional() })])).optional(),
  rowAccess: z.union([z.literal(false), z.strictObject({ column: z.boolean().optional(), placement: placement.optional(), label: label.optional() })]).optional(),
  views: z.array(z.strictObject({ id: identifier, label, where: z.record(z.string(), z.unknown()).optional(), rowAccess: z.enum(['no_account', 'invited', 'expired', 'signed_in']).optional(), default: z.boolean().optional() })).max(8).optional(),
  sort: z.record(identifier, z.union([z.literal(false), z.strictObject({ fields: z.array(identifier).min(1).max(4) })])).optional(),
})

/** Operators the existing controls can round-trip. This narrows the query DSL only for controls. */
export function listControlOperators(kind: ListFilterKind, type: string, required = true): ListOperator[] {
  switch (kind) {
    case 'text': return ['contains']
    case 'enum': case 'relation': return ['in']
    case 'boolean': return required ? ['eq'] : ['eq', 'isNull']
    case 'number': return ['eq', 'gte', 'lte']
    case 'date': return type === 'datetime' ? ['gte', 'lt'] : ['eq', 'gte', 'lte']
  }
}
/** Fresh, idempotent canonicalization for every producer, including trusted plugin hints. */
export function normalizeListConfig(config: InstanceConfig, name: string, input: unknown): ListConfig {
  const list = listInputSchema.parse(input)
  const entity = config.entities[name]
  if (!entity) throw new Error(`Unknown UI entity: ${name}`)
  const fail = (kind: string, field = ''): never => { throw new Error(`Invalid UI ${kind}: ${name}${field ? `.${field}` : ''}`) }
  const known = (field: string) => baseFields.includes(field) || Object.hasOwn(entity.fields, field)
  const related = list.relatedColumns ?? {}
  const column = (field: string) => known(field) || Object.hasOwn(related, field)
  const scalar = (field: string) => known(field) && entity.fields[field]?.type !== 'ref'
  for (const [key, column] of Object.entries(related)) {
    const via = entity.fields[column.via]
    const target = via?.type === 'ref' && via.entity ? config.entities[via.entity] : undefined
    const field = target?.fields[column.field]
    if (known(key) || !field || field.type !== 'ref' || !field.entity) fail('related column', key)
  }
  const columns = list.columns?.map(value => {
    const spec = typeof value === 'string' ? { field: value } : value
    if (!column(spec.field) || spec.secondary && !column(spec.secondary)) fail('column field', spec.field)
    const type = related[spec.field] ? 'ref' : fieldType(config, name, spec.field)
    const format = spec.cell?.kind
    if (format && !(format === 'text' || format === 'identifier' && ['string', 'text'].includes(type) || format === 'badge' && type === 'enum' || ['date', 'datetime'].includes(format) && type === 'datetime' || format === 'number' && ['int', 'float'].includes(type))) fail('cell kind', spec.field)
    if (spec.cell?.kind === 'badge' && Object.keys(spec.cell.tones ?? {}).some(value => !entity.fields[spec.field]?.values?.includes(value))) fail('badge tone key', spec.field)
    return spec
  })
  for (const field of [...list.search ?? [], ...Object.keys(list.sort ?? {})]) if (!known(field)) throw new Error(`Unknown UI field: ${name}.${field}`)
  for (const field of list.search ?? []) if (!['string', 'text'].includes(entity.fields[field]?.type ?? (field === 'id' ? 'string' : ''))) fail('search field', field)
  for (const [key, hint] of Object.entries(list.sort ?? {})) if (hint) {
    if (new Set(hint.fields).size !== hint.fields.length) fail('duplicate sort field', key)
    if (!scalar(key) || !hint.fields.every(scalar)) fail('sort fields', key)
  }
  const filter = list.filter && Object.fromEntries(Object.entries(list.filter).map(([field, value]) => {
    if (!column(field)) throw new Error(`Unknown UI field: ${name}.${field}`)
    if (value === false) return [field, false]
    const type = fieldType(config, name, field)
    const inferred = related[field] ? 'text' : ({ string: 'text', text: 'text', ref: 'relation', enum: 'enum', bool: 'boolean', int: 'number', float: 'number', datetime: 'date' } as const)[type]
    const spec = typeof value === 'string' ? { kind: value } : value
    const kind = spec.kind ?? inferred
    if (kind !== inferred) fail('filter kind', field)
    const allowed = listControlOperators(kind, type, entity.fields[field]?.required ?? true).filter(op => related[field] ? op === 'contains' : operatorsFor(type).includes(op))
    if (spec.operators?.some(op => !allowed.includes(op)) || kind === 'boolean' && spec.operators?.includes('isNull') && !spec.operators.includes('eq')) fail('filter operator', field)
    return [field, { ...spec, kind, placement: spec.placement ?? 'panel', operators: spec.operators ?? allowed }]
  })) as ListConfig['filter']
  const views = list.views?.map(view => {
    if (!view.where && !view.rowAccess) fail('view where', view.id)
    const where = view.where ?? {}
    if (view.id === 'all' && (Object.keys(where).length || view.rowAccess)) fail('all view', view.id)
    if (!filterSchema(config)(name, 0).safeParse(where).success) fail('view where', view.id)
    return { ...view, where: structuredClone(where) }
  })
  if (new Set(views?.map(view => view.id)).size !== (views?.length ?? 0)) fail('duplicate view id')
  if ((views ?? []).filter(view => view.default).length > 1) fail('multiple default views')
  if (list.defaultSort && (!scalar(list.defaultSort.key) || list.sort?.[list.defaultSort.key] === false || (['enum', 'text'].includes(entity.fields[list.defaultSort.key]?.type) && !list.sort?.[list.defaultSort.key]))) fail('default sort')
  return { ...list, ...(columns ? { columns } : {}), ...(filter ? { filter } : {}), ...(views ? { views } : {}) } as ListConfig
}
