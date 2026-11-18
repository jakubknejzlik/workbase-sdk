import { z } from 'zod'
import type { Field, InstanceConfig } from '../config'
import { publicInputSchema } from '../openapi/input-projection'
import { summaryIssue, type SafeIssue, type SummaryOperandReason } from './summary-issues'
import { fieldsFor, fieldType, filterSchema, type Filter, type QueryInput } from './input-schema'

/** Grammar version is tied to the pinned SDK, not independently negotiated. */
export const SUMMARY_VERSION = 1 as const
/** Structural ceilings only; these do not bound input rows or physical work. */
export const SUMMARY_LIMITS = Object.freeze({ metrics: 8, groupBy: 2, groups: 100, days: 366, dailyBuckets: 366 })

export type SummaryModel = { entities: Record<string, { fields: Record<string, Pick<Field, 'type' | 'computed'> & { values?: readonly string[] }> }> }
type Fields<C extends SummaryModel, E extends keyof C['entities']> = C['entities'][E]['fields'] & {
  id: { type: 'string' }; organization_id: { type: 'string' }; version: { type: 'int' }
  created_at: { type: 'datetime' }; updated_at: { type: 'datetime' }
}
export type SummaryField<C extends SummaryModel, E extends keyof C['entities'], T extends Field['type'] = Exclude<Field['type'], 'ref'>> = string extends keyof C['entities'][E]['fields'] ? string : {
  [K in keyof Fields<C, E>]: Fields<C, E>[K] extends { type: T }
    ? Fields<C, E>[K] extends { computed: string } ? never : K : never
}[keyof Fields<C, E>] & string
export type SummaryMetric<C extends SummaryModel, E extends keyof C['entities']> =
  | { op: 'count'; alias: string; field?: never }
  | { op: 'sum'; alias: string; field: SummaryField<C, E, 'int' | 'float'> }
export type SummaryWindow<C extends SummaryModel, E extends keyof C['entities']> = {
  field: SummaryField<C, E, 'datetime'>; from: string; to: string; timeZone?: 'UTC'; bucket?: 'day'
}
export type SummaryOptions<C extends SummaryModel, E extends keyof C['entities']> = {
  version: typeof SUMMARY_VERSION; metrics: readonly SummaryMetric<C, E>[]
  groupBy?: readonly SummaryField<C, E>[]; window?: SummaryWindow<C, E>; maxGroups?: number
}
/** Explicit never keys also reject row/summary mixing through non-literal values. */
export type SummaryQuery<C extends SummaryModel, E extends keyof C['entities']> = {
  entity: E; where?: Filter; summary: SummaryOptions<C, E>
} & { [K in Exclude<keyof QueryInput, 'entity' | 'where'>]?: never }
type ScalarValue<T> = T extends 'int' | 'float' ? number : T extends 'bool' ? boolean : string
type GroupValue<F> = F extends { type: 'enum'; values: readonly (infer V)[] } ? V : F extends { type: infer T } ? ScalarValue<T> : never
type BucketKey<S> = S extends { window: { bucket: 'day'; field: infer K } } ? K : never
type GroupKeys<S> = (S extends { groupBy: readonly (infer K)[] } ? K : never) | BucketKey<S>
export type SummaryResult<C extends SummaryModel, E extends keyof C['entities'], S extends SummaryOptions<C, E>> = {
  kind: 'summary'; version: typeof SUMMARY_VERSION
  data: { groups: { [K in GroupKeys<S> & keyof Fields<C, E>]: K extends BucketKey<S> ? string : GroupValue<Fields<C, E>[K]> | null }
    metrics: { [M in S['metrics'][number] as M['alias']]: M extends { op: 'count' } ? number : number | null } }[]
}

const dayMs = 86_400_000
const alias = z.string().min(1).max(64).regex(/^(?!(?:prototype|constructor)$)[a-z][a-z0-9_]*$/)
// Bounds preserve the numeric discriminator in the existing public projection.
const version = z.number().int().min(SUMMARY_VERSION).max(SUMMARY_VERSION)
const instant = z.iso.datetime({ offset: true }).regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/).refine(value => Number.isFinite(Date.parse(value)), 'Invalid summary instant')

function operand(config: InstanceConfig, entity: string, use: 'sum' | 'groupBy' | 'window') {
  const names = fieldsFor(config, entity)
  const legal = names.filter(name => {
    const field = config.entities[entity].fields[name], type = fieldType(config, entity, name)
    return !field?.computed && type !== 'ref' && (use === 'groupBy' || (use === 'sum' ? ['int', 'float'].includes(type) : type === 'datetime'))
  })
  return z.enum(legal)
}

/** Canonical, model-derived contract. Does not authorize or execute a query. */
function summaryQuerySchema<C extends InstanceConfig, E extends keyof C['entities'] & string>(config: C, entity: E): z.ZodType<SummaryQuery<C, E>> {
  if (!Object.hasOwn(config.entities, entity)) throw new Error('Unknown summary entity')
  const window = z.strictObject({ field: operand(config, entity, 'window'), from: instant, to: instant,
    timeZone: z.enum(['UTC']).optional(), bucket: z.enum(['day']).optional(),
  }).superRefine((value, ctx) => {
    // Compare instants, including explicit offsets, rather than timestamp text.
    const from = Date.parse(value.from), to = Date.parse(value.to)
    if (to <= from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Summary window must have from < to' })
    if (to - from > SUMMARY_LIMITS.days * dayMs) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Summary window exceeds day limit' })
    const buckets = Math.ceil(to / dayMs) - Math.floor(from / dayMs)
    if (value.bucket && buckets > SUMMARY_LIMITS.dailyBuckets) ctx.addIssue({ code: 'custom', path: ['bucket'], message: 'Summary window exceeds daily bucket limit' })
  })
  const metric = z.discriminatedUnion('op', [
    z.strictObject({ op: z.enum(['count']), alias }),
    z.strictObject({ op: z.enum(['sum']), alias, field: operand(config, entity, 'sum') }),
  ])
  const summary = z.strictObject({ version, metrics: z.array(metric).min(1).max(SUMMARY_LIMITS.metrics)
    .refine(values => new Set(values.map(value => value.alias)).size === values.length, 'Summary aliases must be unique'),
  groupBy: z.array(operand(config, entity, 'groupBy')).min(1).max(SUMMARY_LIMITS.groupBy)
    .refine(values => new Set(values).size === values.length, 'Summary groupBy fields must be unique').optional(),
  window: window.optional(), maxGroups: z.number().int().min(1).max(SUMMARY_LIMITS.groups).optional(),
  }).superRefine((value, ctx) => {
    if (value.window?.bucket && value.groupBy?.includes(value.window.field)) ctx.addIssue({ code: 'custom', path: ['groupBy'], message: 'Summary bucket field cannot also be a groupBy field' })
  })
  return z.strictObject({ entity: z.enum([entity]), where: filterSchema(config)(entity, 0).optional(), summary }) as z.ZodType<SummaryQuery<C, E>>
}

function groupValue(config: InstanceConfig, entity: string, field: string): z.ZodType {
  const type = fieldType(config, entity, field)
  return (type === 'int' ? z.number().int().safe() : type === 'float' ? z.number().finite() : type === 'bool' ? z.boolean()
    : type === 'datetime' ? z.iso.datetime() : type === 'enum' ? z.enum(config.entities[entity].fields[field].values!) : z.string()).nullable()
}

/** Request-specific result maps; the later executor must enforce ordering and exact arithmetic. */
function summaryResultSchema<C extends InstanceConfig, E extends keyof C['entities'] & string, const S extends SummaryOptions<C, E>>(
  config: C, entity: E, options: S,
): z.ZodType<SummaryResult<C, E, S>> {
  const summary = options
  const groups: Record<string, z.ZodType> = Object.create(null), metrics: Record<string, z.ZodType> = Object.create(null)
  for (const field of summary.groupBy ?? []) groups[field] = groupValue(config, entity, field)
  if (summary.window?.bucket) groups[summary.window.field] = z.iso.datetime().refine(value => Date.parse(value) % dayMs === 0, 'Summary day bucket must start at UTC midnight')
  for (const metric of summary.metrics) metrics[metric.alias] = metric.op === 'count' ? z.number().int().safe().nonnegative()
    : (fieldType(config, entity, metric.field) === 'int' ? z.number().int().safe() : z.number().finite()).nullable()
  const row = z.strictObject({ groups: z.strictObject(groups), metrics: z.strictObject(metrics) })
  const data = Object.keys(groups).length ? z.array(row).max(summary.maxGroups ?? SUMMARY_LIMITS.groups) : z.array(row).length(1)
  return z.strictObject({ kind: z.enum(['summary']), version, data }) as unknown as z.ZodType<SummaryResult<C, E, S>>
}

/** The boundary returns plain data, never a schema or a Zod error. */
export type SummaryValidation<T> = { ok: true; data: T } | { ok: false; issues: SafeIssue[] }

// Zod 4.6.7 finalizeIssue uses the first defined message: schema, per-parse,
// global customError, locale. Always return a constant so consumer hooks cannot
// receive raw issues (including issue.inst) before the SafeIssue mapper runs.
const internalError = () => 'Invalid summary'

function operandReason(config: InstanceConfig, entity: string, input: unknown, issue: z.core.$ZodIssue): SummaryOperandReason | undefined {
  if (issue.code !== 'invalid_value' || issue.path[0] !== 'summary') return
  const summary = (input as { summary?: SummaryOptions<InstanceConfig, string> } | null)?.summary
  const path = issue.path
  let field: unknown
  if (path.length === 3 && path[1] === 'window' && path[2] === 'field') field = summary?.window?.field
  else if (path.length === 3 && path[1] === 'groupBy' && typeof path[2] === 'number') field = summary?.groupBy?.[path[2]]
  else if (path.length === 4 && path[1] === 'metrics' && typeof path[2] === 'number' && path[3] === 'field') field = summary?.metrics?.[path[2]]?.field
  else return
  // Select only fixed reasons using trusted field/relation metadata. Input can
  // identify an operand, but cannot supply a reason, message or diagnostic code.
  if (typeof field !== 'string') return
  const model = config.entities[entity]
  if (Object.hasOwn(model.fields, field)) {
    if (model.fields[field].computed) return 'computed'
    if (model.fields[field].type === 'ref') return 'reference'
    return 'unsupported_type'
  }
  if (Object.hasOwn(model.relations, field)) return 'reference'
  if (fieldsFor(config, entity).includes(field)) return 'unsupported_type'
  return /[.()+*/\s-]/.test(field) ? 'expression' : 'unknown_field'
}

/** Canonical request validation only; does not authorize or execute a query. */
export function parseSummaryRequest<C extends InstanceConfig, E extends keyof C['entities'] & string>(
  config: C, entity: E, input: unknown,
): SummaryValidation<SummaryQuery<C, E>> {
  if (!Object.hasOwn(config.entities, entity)) return { ok: false, issues: [summaryIssue({ code: 'invalid_summary', path: ['entity'] })] }
  const parsed = summaryQuerySchema(config, entity).safeParse(input, { error: internalError })
  return parsed.success ? { ok: true, data: parsed.data }
    : { ok: false, issues: parsed.error.issues.map(issue => summaryIssue(issue, operandReason(config, entity, input, issue))) }
}

/** Validate options through the same safe boundary before constructing a result. */
export function parseSummaryResult<C extends InstanceConfig, E extends keyof C['entities'] & string, const S extends SummaryOptions<C, E>>(
  config: C, entity: E, options: S, input: unknown,
): SummaryValidation<SummaryResult<C, E, S>> {
  const request = parseSummaryRequest(config, entity, { entity, summary: options })
  if (!request.ok) return request
  const parsed = summaryResultSchema(config, entity, request.data.summary).safeParse(input, { error: internalError })
  return parsed.success ? { ok: true, data: parsed.data as SummaryResult<C, E, S> }
    : { ok: false, issues: parsed.error.issues.map(issue => summaryIssue(issue)) }
}

/** Detached JSON-only projection. Parseable schemas never leave this module. */
export function projectSummaryContract<C extends InstanceConfig, E extends keyof C['entities'] & string, const S extends SummaryOptions<C, E>>(
  config: C, entity: E, options: S,
) {
  const request = parseSummaryRequest(config, entity, { entity, summary: options })
  if (!request.ok) throw new Error('Invalid summary options')
  return {
    request: publicInputSchema(summaryQuerySchema(config, entity)),
    result: publicInputSchema(summaryResultSchema(config, entity, request.data.summary)),
  }
}
