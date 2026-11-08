import { z } from 'zod'
import type { InstanceConfig } from './config'
import { detailSectionsSchema, validateDetailLayout } from './detail-layout'

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/)
const item = z.union([identifier, z.strictObject({
  field: identifier, label: z.string().min(1).optional(), help: z.string().min(1).optional(),
  when: z.strictObject({ field: identifier, eq: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).optional(),
})])
/** Labels/composite values use the entity's SR-61 ts-query expression, never a browser composer. */
export const detailDisplaySchema = z.strictObject({
  inlineEdit: z.boolean().optional(),
  lists: z.record(identifier, z.strictObject({ entity: identifier, label: z.string().min(1),
    bind: z.strictObject({ field: identifier, record: z.literal('id') }), columns: z.array(identifier).min(1).optional(), create: z.boolean().optional(),
  })).optional(),
  summary: z.array(item).optional(),
  groups: z.array(z.strictObject({ id: identifier, label: z.string().min(1), help: z.string().min(1).optional(), fields: z.array(item).min(1) })).optional(),
  sections: detailSectionsSchema.optional(),
  fields: z.array(identifier).optional(),
  metrics: z.array(z.strictObject({ field: identifier, unitField: identifier.optional(), tone: z.enum(['positive', 'negative']).optional() })).optional(),
  relations: z.record(identifier, z.strictObject({ columns: z.array(identifier), defaultSort: z.strictObject({ key: identifier, direction: z.enum(['asc', 'desc']) }).optional() })).optional(),
}).superRefine((detail, ctx) => {
  if (detail.summary !== undefined && detail.groups === undefined || detail.groups !== undefined && detail.fields !== undefined) ctx.addIssue({ code: 'custom', message: 'Summary requires groups; groups replace detail.fields' })
})
export function validateDetailDisplay(config: Pick<InstanceConfig, 'entities'>, name: string, input: unknown) {
  const detail = detailDisplaySchema.parse(input)
  const entity = config.entities[name]
  const known = (field: string) => ['id', 'organization_id', 'created_at', 'updated_at', 'version'].includes(field) || Object.hasOwn(entity.fields, field)
  const check = (field: string) => { if (!known(field)) throw new Error(`Unknown UI detail field: ${name}.${field}`) }
  const ids = new Set<string>(); const fields = new Set<string>()
  for (const group of detail.groups ?? []) {
    if (ids.has(group.id)) throw new Error(`Duplicate UI detail group: ${name}.${group.id}`)
    ids.add(group.id)
  }
  for (const item of [...detail.summary ?? [], ...(detail.groups ?? []).flatMap(group => group.fields)]) {
    const value = typeof item === 'string' ? { field: item } : item
    check(value.field)
    if (['id', 'organization_id'].includes(value.field)) throw new Error(`Technical UI detail field: ${name}.${value.field}`)
    if (fields.has(value.field)) throw new Error(`Duplicate UI detail field: ${name}.${value.field}`)
    fields.add(value.field)
    if (value.when) {
      check(value.when.field)
      const type = entity.fields[value.when.field]?.type ?? (value.when.field === 'version' ? 'int' : 'string')
      const operand = value.when.eq
      if (operand !== null && (type === 'bool' ? typeof operand !== 'boolean' : ['int', 'float'].includes(type) ? typeof operand !== 'number' || type === 'int' && !Number.isSafeInteger(operand) : typeof operand !== 'string') || type === 'enum' && operand !== null && !entity.fields[value.when.field].values?.includes(String(operand))) throw new Error(`Invalid UI detail condition: ${name}.${value.when.field}`)
    }
  }
  for (const field of [...detail.fields ?? [], ...(detail.metrics ?? []).flatMap(metric => [metric.field, ...metric.unitField ? [metric.unitField] : []])]) check(field)
  for (const [key, list] of Object.entries(detail.lists ?? {})) {
    const target = config.entities[list.entity]; const field = target?.fields[list.bind.field]
    if (key === 'info' || !field || field.type !== 'ref' || field.entity !== name || entity.relations[key] && (entity.relations[key].entity !== list.entity || entity.relations[key].field !== list.bind.field || !entity.relations[key].many)) throw new Error(`Invalid UI context list: ${name}.${key}`)
    if (list.columns && (new Set(list.columns).size !== list.columns.length || list.columns.some(column => !['id', 'created_at', 'updated_at', 'version'].includes(column) && !Object.hasOwn(target.fields, column)))) throw new Error(`Invalid UI context list columns: ${name}.${key}`)
  }
  validateDetailLayout(name, { ...entity.relations, ...Object.fromEntries(Object.keys(detail.lists ?? {}).map(key => [key, { many: true }])) }, detail.sections)
  for (const [relation, hint] of Object.entries(detail.relations ?? {})) {
    const target = config.entities[entity.relations[relation]?.entity]
    if (!target || [...hint.columns, ...hint.defaultSort ? [hint.defaultSort.key] : []].some(field => !['id', 'organization_id', 'created_at', 'updated_at', 'version'].includes(field) && !Object.hasOwn(target.fields, field))) throw new Error(`Invalid UI detail relation: ${name}.${relation}`)
  }
}
