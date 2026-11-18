import { parseSummaryRequest, parseSummaryResult, type QueryInput, type SummaryQuery, type SummaryOptions, type SummaryResult } from '@workbasehq/core/query/schema'
import type { InstanceConfig } from '../../src/config'

// Retain the authored field literals; defineInstance's normalized output is wider.
const model = { entities: { sales: { fields: {
  amount: { type: 'int' }, price: { type: 'float' }, name: { type: 'string' }, enabled: { type: 'bool' },
  at: { type: 'datetime' }, owner: { type: 'ref' }, calculated: { type: 'int', computed: 'amount + 1' },
} } } } as const
type Query = SummaryQuery<typeof model, 'sales'>
const summary = { version: 1, metrics: [{ op: 'count', alias: 'rows' }, { op: 'sum', field: 'amount', alias: 'total' }],
  groupBy: ['enabled'], window: { field: 'at', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', bucket: 'day' },
} as const satisfies SummaryOptions<typeof model, 'sales'>
const query: Query = { entity: 'sales', where: { name: { eq: 'Sale' } }, summary }
const baseFields: Query = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'sum', field: 'version', alias: 'versions' }], groupBy: ['id'], window: { field: 'created_at', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } } }
const result: SummaryResult<typeof model, 'sales', typeof summary> = { kind: 'summary', version: 1,
  data: [{ groups: { enabled: null, at: '2026-01-01T00:00:00Z' }, metrics: { rows: 0, total: null } }],
}
// @ts-expect-error unknown model field
const unknown: Query = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'sum', field: 'missing', alias: 'total' }] } }
// @ts-expect-error nonnumeric sum
const text: Query = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'sum', field: 'name', alias: 'total' }] } }
// @ts-expect-error computed sum
const computed: Query = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'sum', field: 'calculated', alias: 'total' }] } }
// @ts-expect-error reference grouping
const reference: Query = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'count', alias: 'rows' }], groupBy: ['owner'] } }
// @ts-expect-error computed grouping
const computedGroup: Query = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'count', alias: 'rows' }], groupBy: ['calculated'] } }
// @ts-expect-error invalid datetime field
const window: Query = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'count', alias: 'rows' }], window: { field: 'name', from: '', to: '' } } }
// @ts-expect-error unsupported grammar version
const version: Query = { entity: 'sales', summary: { version: 2, metrics: [{ op: 'count', alias: 'rows' }] } }
// @ts-expect-error row keys cannot be mixed with summaries
const mixed: Query = { ...query, limit: 1 }
const row = { entity: 'sales', limit: 1, select: ['id'] }
// @ts-expect-error mixing through an existing row value is rejected too
const spread: Query = { ...row, summary }
// @ts-expect-error summary query is not an executable row query
const rowQuery: QueryInput = query
// @ts-expect-error unknown entity
type MissingEntity = SummaryQuery<typeof model, 'missing'>
// @ts-expect-error group type follows the model
const invalidResult: typeof result = { kind: 'summary', version: 1, data: [{ groups: { enabled: 'yes', at: '' }, metrics: { rows: 0, total: null } }] }
// @ts-expect-error count is never null
const nullCount: typeof result = { kind: 'summary', version: 1, data: [{ groups: { enabled: true, at: '' }, metrics: { rows: null, total: null } }] }
// @ts-expect-error bucket keys are never null
const nullBucket: typeof result = { kind: 'summary', version: 1, data: [{ groups: { enabled: true, at: null }, metrics: { rows: 0, total: null } }] }
// @ts-expect-error metric aliases come from the request
const unknownAlias: typeof result = { kind: 'summary', version: 1, data: [{ groups: { enabled: true, at: '' }, metrics: { rows: 1, total: 1, other: 2 } }] }

// Boundary inference preserves field restrictions for a literal normalized model too.
function schemaTypes(normalized: InstanceConfig) {
  const config = { ...normalized, entities: { sales: { ...normalized.entities.sales, fields: {
    amount: { type: 'int', required: false }, price: { type: 'float', required: false }, name: { type: 'string', required: false },
    enabled: { type: 'bool', required: false }, at: { type: 'datetime', required: false }, owner: { type: 'ref', required: false },
    calculated: { type: 'int', required: false, computed: 'amount + 1' },
  } } } } as const
  const request = parseSummaryRequest(config, 'sales', query)
  const response = parseSummaryResult(config, 'sales', summary, result)
  if (!request.ok || !response.ok) throw new Error('Invalid summary fixture')
  const parsed = request.data
  const parsedResult: typeof result = response.data
  // @ts-expect-error schema inference retains the numeric operand inventory
  const invalid: typeof parsed = { entity: 'sales', summary: { version: 1, metrics: [{ op: 'sum', field: 'name', alias: 'total' }] } }
  return { parsed, parsedResult, invalid }
}
void [baseFields, result, unknown, text, computed, reference, computedGroup, window, version, mixed, spread, rowQuery, invalidResult, nullCount, nullBucket, unknownAlias, schemaTypes]

// Public validation exposes no Zod settings or raw callback channel.
function rejectsParseSettings(config: InstanceConfig) {
  // @ts-expect-error SummaryParseSettings was removed from the public module.
  type RemovedSettings = import('@workbasehq/core/query/schema').SummaryParseSettings
  // @ts-expect-error Request parsing accepts no Zod settings.
  parseSummaryRequest(config, 'sales', {}, { reportInput: true })
  // @ts-expect-error Result parsing accepts no raw callback or settings.
  parseSummaryResult(config, 'sales', { version: 1, metrics: [{ op: 'count', alias: 'rows' }] }, {}, { error: () => 'unsafe' })
}
void rejectsParseSettings
