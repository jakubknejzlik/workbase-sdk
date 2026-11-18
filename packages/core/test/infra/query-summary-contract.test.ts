import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { z } from 'zod'
import SwaggerParser from '@apidevtools/swagger-parser'
import { instanceConfigSchema } from '../../src/config'
import { SUMMARY_LIMITS, SUMMARY_VERSION, summaryQuerySchema, summaryResultSchema } from '@workbasehq/core/query/schema'
import { summaryContract } from '../../src/openapi/summary-contract'

const require = createRequire(import.meta.url)
const Ajv = createRequire(require.resolve('@apidevtools/swagger-parser'))('ajv/dist/2020')
const config = instanceConfigSchema.parse({ id: 'summary', revision: 1, roles: ['reader'], permissions: {}, entities: { sales: {
  fields: { amount: { type: 'int' }, price: { type: 'float' }, name: { type: 'text' }, enabled: { type: 'bool' },
    at: { type: 'datetime' }, category: { type: 'enum', values: ['retail', 'wholesale'] },
    owner: { type: 'ref', entity: 'sales' }, calculated: { type: 'int', computed: 'PRIVATE_EXPRESSION_CANARY' } },
  relations: { parent: { field: 'owner', entity: 'sales' } },
} } })
const metrics = [{ op: 'count', alias: 'rows' }, { op: 'sum', field: 'amount', alias: 'total' }, { op: 'sum', field: 'price', alias: 'cost' }] as const
const options = { version: SUMMARY_VERSION, metrics } as const
const request = (summary = {}) => ({ entity: 'sales', summary: { ...options, ...summary } })
const window = { field: 'at', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', timeZone: 'UTC', bucket: 'day' } as const
const grouped = { ...options, groupBy: ['category', 'enabled'], window } as const
const schema = summaryQuerySchema(config, 'sales')
const ungroupedResult = { kind: 'summary', version: 1, data: [{ groups: {}, metrics: { rows: 0, total: null, cost: null } }] }
const groupRow = { groups: { category: null, enabled: false, at: '2026-01-01T00:00:00Z' }, metrics: { rows: 2, total: 7, cost: 1.5 } }
const groupedResult = { kind: 'summary', version: 1, data: [groupRow] }

const unsafeKey = 'UNSAFE_KEY_CANARY', unsafeValue = 'UNSAFE_VALUE_CANARY'
const unknownKeys = { [unsafeKey]: unsafeValue, [`second_${unsafeKey}`]: { nested: unsafeValue } }
const unknownKeyCases = [
  ['request root', schema, { ...request(), ...unknownKeys }],
  ['summary options', schema, request(unknownKeys)],
  ['count metric', schema, request({ metrics: [{ ...metrics[0], ...unknownKeys }] })],
  ['sum metric', schema, request({ metrics: [{ ...metrics[1], ...unknownKeys }] })],
  ['window', schema, request({ window: { ...window, ...unknownKeys } })],
  ['result root', summaryResultSchema(config, 'sales', grouped), { ...groupedResult, ...unknownKeys }],
  ['result row', summaryResultSchema(config, 'sales', grouped), { ...groupedResult, data: [{ ...groupRow, ...unknownKeys }] }],
  ['group map', summaryResultSchema(config, 'sales', grouped), { ...groupedResult, data: [{ ...groupRow, groups: { ...groupRow.groups, ...unknownKeys } }] }],
  ['empty group map', summaryResultSchema(config, 'sales', options), { ...ungroupedResult, data: [{ ...ungroupedResult.data[0], groups: unknownKeys }] }],
  ['metric map', summaryResultSchema(config, 'sales', grouped), { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, ...unknownKeys } }] }],
  ['unknown keys with an invalid sibling', schema, { ...request({ version: 2 }), ...unknownKeys }],
] as const
it.each(unknownKeyCases.flatMap(([name, contract, input]) => [false, true].map(reportInput => ({ name, contract, input, reportInput }))))(
  'rejects unknown keys without disclosing keys or values: $name (reportInput=$reportInput)', ({ contract, input, reportInput }) => {
    // Opting into Zod input diagnostics must not reintroduce rejected unknown data.
    const parsed = contract.safeParse(input, { reportInput })
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('Expected unknown-key rejection')
    const serialized = JSON.stringify(parsed.error.issues)
    expect(serialized).not.toContain(unsafeKey)
    expect(serialized).not.toContain(unsafeValue)
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys', keys: [] }))
    expect(JSON.stringify(input)).toContain(unsafeKey)
    expect(JSON.stringify(input)).toContain(unsafeValue)
  },
)

const validRequests = [
  request(), request({ metrics: [{ op: 'count', alias: 'rows' }] }),
  { ...request(), where: { and: [{ amount: { gte: 0 } }, { parent: { name: { contains: 'A' } } }] } },
  request({ groupBy: ['category', 'enabled'] }), request({ groupBy: ['name', 'at'] }),
  request({ groupBy: ['id', 'version'] }), request({ window }), request(grouped),
  request({ window: { field: 'created_at', from: '2026-01-01T01:00:00+01:00', to: '2026-01-01T00:00:00.001Z' } }),
  request({ metrics: Array.from({ length: SUMMARY_LIMITS.metrics }, (_, i) => ({ op: 'count', alias: `m${i}` })) }),
  request({ maxGroups: SUMMARY_LIMITS.groups }),
  request({ window: { ...window, from: '2024-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' } }),
  // 365 elapsed days plus partial first/last days intersects exactly 366 buckets.
  request({ window: { ...window, from: '2024-01-01T12:00:00Z', to: '2024-12-31T12:00:00Z' } }),
  request({ metrics: [{ op: 'count', alias: 'a'.repeat(64) }] }),
]
const invalidRequests: [string, unknown][] = [
  ['entity', { ...request(), entity: 'missing' }], ['version', request({ version: 2 })], ['fractional version', request({ version: 1.5 })],
  ['empty metrics', request({ metrics: [] })], ['metric cap+1', request({ metrics: Array.from({ length: 9 }, (_, i) => ({ op: 'count', alias: `m${i}` })) })],
  ['unknown op', request({ metrics: [{ op: 'avg', field: 'amount', alias: 'total' }] })],
  ['count field', request({ metrics: [{ op: 'count', field: 'id', alias: 'rows' }] })],
  ...['missing', 'name', 'owner', 'calculated', 'SUM(amount)', 'parent.amount'].map(field => [`sum ${field}`, request({ metrics: [{ op: 'sum', field, alias: 'total' }] })] as [string, unknown]),
  ...['__proto__', 'prototype', 'constructor', 'Upper', 'a.b', 'a-b', 'a b', '', 'a'.repeat(65)].map(alias => [`alias ${alias}`, request({ metrics: [{ op: 'count', alias }] })] as [string, unknown]),
  ['group cap+1', request({ groupBy: ['category', 'enabled', 'name'] })], ['empty grouping', request({ groupBy: [] })],
  ...['missing', 'owner', 'parent', 'calculated', 'parent.name', 'LOWER(name)'].map(field => [`group ${field}`, request({ groupBy: [field] })] as [string, unknown]),
  ['groups cap+1', request({ maxGroups: 101 })], ['zero maxGroups', request({ maxGroups: 0 })], ['fractional maxGroups', request({ maxGroups: 1.5 })],
  ...['missing', 'owner', 'calculated', 'amount', 'name'].map(field => [`window ${field}`, request({ window: { ...window, field } })] as [string, unknown]),
  ...['yesterday', '2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00', '2026-01-01T00:00:00+25:00', '2026-01-01T00:00:00.0001Z'].map(from => [`timestamp ${from}`, request({ window: { ...window, from } })] as [string, unknown]),
  ['malformed to', request({ window: { ...window, to: 'tomorrow' } })],
  ['timezone', request({ window: { ...window, timeZone: 'Europe/Prague' } })], ['bucket', request({ window: { ...window, bucket: 'month' } })],
  ['relative window', request({ window: { field: 'at', lastDays: 7 } })],
  ...Object.entries({ select: ['id'], include: {}, cursor: 'x', limit: 1, orderBy: [], labels: [], search: { text: 'a', fields: ['name'] }, rowAccess: 'signed_in', contextList: {}, labelWhere: {} })
    .map(([key, value]) => [`mixed ${key}`, { ...request(), [key]: value }] as [string, unknown]),
  ['unknown option', request({ raw: 'SELECT PRIVATE_CANARY' })],
]
// Semantic refinements deliberately cannot be enforced by JSON Schema alone.
const semanticInvalid: [string, unknown][] = [
  ['duplicate aliases', request({ metrics: [{ op: 'count', alias: 'rows' }, { op: 'sum', field: 'amount', alias: 'rows' }] })],
  ['duplicate grouping', request({ groupBy: ['name', 'name'] })],
  ['bucket collision', request({ groupBy: ['at'], window })],
  ['equal instants across offsets', request({ window: { ...window, from: '2026-01-01T01:00:00+01:00', to: '2026-01-01T00:00:00Z' } })],
  ['reversed instants across offsets', request({ window: { ...window, from: '2026-01-01T00:00:00-01:00', to: '2026-01-01T00:30:00Z' } })],
  ['days cap+1', request({ window: { ...window, from: '2024-01-01T00:00:00Z', to: '2025-01-02T00:00:00Z', bucket: undefined } })],
  ['days cap+1 millisecond', request({ window: { ...window, from: '2024-01-01T00:00:00Z', to: '2025-01-01T00:00:00.001Z', bucket: undefined } })],
  ['daily buckets cap+1 within duration cap', request({ window: { ...window, from: '2024-01-01T12:00:00Z', to: '2025-01-01T12:00:00Z' } })],
]
it.each(validRequests.map((value, i) => [i, value] as const))('accepts valid summary request %i', (_, value) => {
  expect(schema.safeParse(value).success).toBe(true)
})
it.each([...invalidRequests, ...semanticInvalid])('rejects %s', (_, value) => {
  expect(schema.safeParse(value).success).toBe(false)
})
it.each([
  ['owner', 'reference'], ['parent', 'reference'], ['calculated', 'computed'], ['SUM(amount)', 'expressions'], ['missing', 'Unknown'],
])('provides specific operand diagnostics for %s', (field, diagnostic) => {
  for (const summary of [{ groupBy: [field] }, { metrics: [{ op: 'sum', field, alias: 'total' }] }, { window: { ...window, field } }]) {
    const parsed = schema.safeParse(request(summary))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0].message).toContain(diagnostic)
  }
})
it('rejects an unknown schema entity and does not disclose computed expressions', () => {
  expect(() => summaryQuerySchema(config, 'missing')).toThrow('Unknown summary entity')
  expect(JSON.stringify(summaryContract(config, 'sales', grouped))).not.toContain('PRIVATE_EXPRESSION_CANARY')
})
it('validates exact empty-input shapes, null groups and safe numeric results', () => {
  const plain = summaryResultSchema(config, 'sales', options), groups = summaryResultSchema(config, 'sales', grouped)
  expect(plain.safeParse(ungroupedResult).success).toBe(true)
  expect(groups.safeParse(groupedResult).success).toBe(true)
  expect(groups.safeParse({ kind: 'summary', version: 1, data: [] }).success).toBe(true)
  expect(plain.safeParse({ kind: 'summary', version: 1, data: [] }).success).toBe(false)
  for (const [key, values] of Object.entries({ rows: [-1, 1.5, null, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN], total: [1.5, Number.MAX_SAFE_INTEGER + 1, -Infinity], cost: [Infinity, NaN] })) {
    for (const value of values) expect(plain.safeParse({ ...ungroupedResult, data: [{ groups: {}, metrics: { rows: 0, total: null, cost: null, [key]: value } }] }).success).toBe(false)
  }
  expect(plain.safeParse({ ...ungroupedResult, data: [{ groups: {}, metrics: { rows: Number.MAX_SAFE_INTEGER, total: Number.MIN_SAFE_INTEGER, cost: Number.MAX_VALUE } }] }).success).toBe(true)
  for (const groupsValue of [{ ...groupRow.groups, category: 'missing' }, { ...groupRow.groups, enabled: 0 }, { ...groupRow.groups, at: null }, { ...groupRow.groups, at: '2026-01-01T01:00:00Z' }]) {
    expect(groups.safeParse({ ...groupedResult, data: [{ ...groupRow, groups: groupsValue }] }).success).toBe(false)
  }
})
const invalidResults = [
  { ...groupedResult, kind: 'rows' }, { ...groupedResult, version: 2 }, { data: [groupRow] },
  { ...groupedResult, next_cursor: null }, { ...groupedResult, entity: 'sales' },
  { ...groupedResult, data: [{ ...groupRow, metrics: { rows: 2, total: 7 } }] },
  { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, other: 1 } }] },
  { ...groupedResult, data: [{ ...groupRow, groups: { enabled: false, at: window.from } }] },
  { ...groupedResult, data: [{ ...groupRow, groups: { ...groupRow.groups, other: 'x' } }] },
  { ...groupedResult, data: [{ ...groupRow, groups: { ...groupRow.groups, category: 'unknown' } }] },
  { ...groupedResult, data: [{ ...groupRow, groups: { ...groupRow.groups, enabled: 1 } }] },
  { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, rows: null } }] },
  { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, rows: -1 } }] },
  { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, rows: 1.5 } }] },
  { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, rows: Number.MAX_SAFE_INTEGER + 1 } }] },
  { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, total: Number.MIN_SAFE_INTEGER - 1 } }] },
  { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, total: 1.5 } }] },
  { ...groupedResult, data: Array.from({ length: 101 }, () => groupRow) },
]
it.each([
  { fields: ['amount', 'price'], groups: { amount: 1, price: 1.5 } },
  { fields: ['name', 'at'], groups: { name: 'Sale', at: '2026-01-01T00:00:00Z' } },
  { fields: ['id', 'version'], groups: { id: 'sale-1', version: 1 } },
])('preserves stored scalar group types for $fields', ({ fields, groups }) => {
  const result = summaryResultSchema(config, 'sales', { ...options, groupBy: fields })
  const row = { ...ungroupedResult.data[0], groups }
  expect(result.safeParse({ ...ungroupedResult, data: [row] }).success).toBe(true)
  expect(result.safeParse({ ...ungroupedResult, data: [{ ...row, groups: Object.fromEntries(fields.map(field => [field, null])) }] }).success).toBe(true)
})
it.each(invalidResults.map((value, i) => [i, value] as const))('rejects malformed summary result %i', (_, value) => {
  expect(summaryResultSchema(config, 'sales', grouped).safeParse(value).success).toBe(false)
})
it.each([1, SUMMARY_LIMITS.groups])('enforces requested output group cap %i and cap+1', maxGroups => {
  const result = summaryResultSchema(config, 'sales', { ...grouped, maxGroups })
  expect(result.safeParse({ ...groupedResult, data: Array.from({ length: maxGroups }, () => groupRow) }).success).toBe(true)
  expect(result.safeParse({ ...groupedResult, data: Array.from({ length: maxGroups + 1 }, () => groupRow) }).success).toBe(false)
})
it('projects deterministic OpenAPI and MCP-style fragments from the same canonical request and result', async () => {
  const fragments = summaryContract(config, 'sales', grouped)
  expect(summaryContract(config, 'sales', grouped)).toEqual(fragments)
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true })
  for (const input of [fragments.request, z.toJSONSchema(schema, { io: 'input' })]) {
    const check = ajv.compile(input)
    for (const value of validRequests) expect(check(value), JSON.stringify(check.errors)).toBe(true)
    for (const [name, value] of invalidRequests) expect(check(value), name).toBe(false)
    for (const [name, value] of semanticInvalid) expect(check(value), `semantic-only: ${name}`).toBe(true)
  }
  for (const input of [fragments.result, z.toJSONSchema(summaryResultSchema(config, 'sales', grouped))]) {
    const check = ajv.compile(input)
    for (const value of [groupedResult, { ...groupedResult, data: [] }]) expect(check(value), JSON.stringify(check.errors)).toBe(true)
    for (const value of invalidResults) expect(check(value), JSON.stringify(value)).toBe(false)
  }
  for (const input of [summaryContract(config, 'sales', options).result, z.toJSONSchema(summaryResultSchema(config, 'sales', options))]) {
    const check = ajv.compile(input)
    expect(check(ungroupedResult), JSON.stringify(check.errors)).toBe(true)
    expect(check({ ...ungroupedResult, data: [] })).toBe(false)
    expect(check({ ...ungroupedResult, data: [...ungroupedResult.data, ...ungroupedResult.data] })).toBe(false)
  }
  // Standalone fragments own local $defs. Rebase only references when embedding.
  const embed = (fragment: unknown, name: string) => JSON.parse(JSON.stringify(fragment).replaceAll('"#', `"#/components/schemas/${name}`))
  await SwaggerParser.validate({ openapi: '3.1.0', info: { title: 'Detached summary contract', version: '1' },
    paths: {}, components: { schemas: { SummaryRequest: embed(fragments.request, 'SummaryRequest'), SummaryResult: embed(fragments.result, 'SummaryResult') } },
  })
})
