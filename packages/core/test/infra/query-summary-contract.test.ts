import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import SwaggerParser from '@apidevtools/swagger-parser'
import { instanceConfigSchema, type InstanceConfig } from '../../src/config'
import * as publicSummary from '@workbasehq/core/query/schema'
import * as internalSummary from '../../src/query/summary-schema'
import { summaryIssue } from '../../src/query/summary-issues'
import { SUMMARY_LIMITS, SUMMARY_VERSION, parseSummaryRequest, parseSummaryResult, type SummaryValidation, type SummaryOptions } from '@workbasehq/core/query/schema'
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
// Adversarial JavaScript callers may still pass removed settings as extra args.
// Keep the earlier reportInput/message cases without adding settings to the API.
type RejectedParseSettings = { reportInput?: boolean; error?: () => string }
const parseRequest = (input: unknown, settings?: RejectedParseSettings): SummaryValidation<unknown> =>
  Reflect.apply(parseSummaryRequest, undefined, [config, 'sales', input, settings])
const resultParser = (model: InstanceConfig, entity: string, summary: SummaryOptions<InstanceConfig, string>) =>
  (input: unknown, settings?: RejectedParseSettings): SummaryValidation<unknown> =>
    Reflect.apply(parseSummaryResult, undefined, [model, entity, summary, input, settings])
const ungroupedResult = { kind: 'summary', version: 1, data: [{ groups: {}, metrics: { rows: 0, total: null, cost: null } }] }
const groupRow = { groups: { category: null, enabled: false, at: '2026-01-01T00:00:00Z' }, metrics: { rows: 2, total: 7, cost: 1.5 } }
const groupedResult = { kind: 'summary', version: 1, data: [groupRow] }

const unsafeKey = 'UNSAFE_KEY_CANARY', unsafeValue = 'UNSAFE_VALUE_CANARY'
const unknownKeys = { [unsafeKey]: unsafeValue, [`second_${unsafeKey}`]: { nested: unsafeValue } }
const unknownKeyCases = [
  ['request root', parseRequest, { ...request(), ...unknownKeys }],
  ['summary options', parseRequest, request(unknownKeys)],
  ['count metric', parseRequest, request({ metrics: [{ ...metrics[0], ...unknownKeys }] })],
  ['sum metric', parseRequest, request({ metrics: [{ ...metrics[1], ...unknownKeys }] })],
  ['window', parseRequest, request({ window: { ...window, ...unknownKeys } })],
  ['result root', resultParser(config, 'sales', grouped), { ...groupedResult, ...unknownKeys }],
  ['result row', resultParser(config, 'sales', grouped), { ...groupedResult, data: [{ ...groupRow, ...unknownKeys }] }],
  ['group map', resultParser(config, 'sales', grouped), { ...groupedResult, data: [{ ...groupRow, groups: { ...groupRow.groups, ...unknownKeys } }] }],
  ['empty group map', resultParser(config, 'sales', options), { ...ungroupedResult, data: [{ ...ungroupedResult.data[0], groups: unknownKeys }] }],
  ['metric map', resultParser(config, 'sales', grouped), { ...groupedResult, data: [{ ...groupRow, metrics: { ...groupRow.metrics, ...unknownKeys } }] }],
  ['unknown keys with an invalid sibling', parseRequest, { ...request({ version: 2 }), ...unknownKeys }],
] as const
it.each(unknownKeyCases.flatMap(([name, contract, input]) => [false, true].map(reportInput => ({ name, contract, input, reportInput }))))(
  'rejects unknown keys without disclosing keys or values: $name (reportInput=$reportInput)', ({ contract, input, reportInput }) => {
    // Removed Zod settings passed as extra JS arguments must have no effect.
    const parsed = contract(input, { reportInput })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('Expected unknown-key rejection')
    const serialized = JSON.stringify(parsed.issues)
    expect(serialized).not.toContain(unsafeKey)
    expect(serialized).not.toContain(unsafeValue)
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys', message: 'Unknown summary properties are unsupported' }))
    for (const issue of parsed.issues) expect(issue).not.toHaveProperty('keys')
    expect(JSON.stringify(input)).toContain(unsafeKey)
    expect(JSON.stringify(input)).toContain(unsafeValue)
  },
)

// Deterministic property-style generation: vary keys, values, containers and
// nesting while requiring coverage of every summary-owned issue code.
it.each([false, true])('projects every summary diagnostic without input data (reportInput=%s)', reportInput => {
  const reached = new Set<string>(), messages = new Map<string, string>()
  for (let seed = 0; seed < 8; seed++) {
    const key = `diagnostic_key_canary_${seed}`, value = `diagnostic_value_canary_${seed}`
    const poison = { [key]: value }
    const model = instanceConfigSchema.parse({ ...config, entities: { sales: { ...config.entities.sales,
      fields: { ...config.entities.sales.fields, [key]: { type: 'enum', values: [value] } },
    } } })
    const resultOptions = { version: 1, metrics: [{ op: 'count', alias: key }], groupBy: [key] } as const
    const resultSchema = resultParser(model, 'sales', resultOptions)
    const result = { kind: 'summary', version: 1, data: [{ groups: { [key]: value }, metrics: { [key]: 1 } }] }
    const row = result.data[0]
    const cases: [(input: unknown, settings?: RejectedParseSettings) => SummaryValidation<unknown>, unknown, string][] = [
      [parseRequest, request({ metrics: [{ op: value, alias: key, ...poison }] }), 'invalid_union'],
      [parseRequest, { ...request(), ...poison }, 'unrecognized_keys'],
      [parseRequest, request({ metrics: Array.from({ length: SUMMARY_LIMITS.metrics + 1 + seed }, () => ({ op: 'count', alias: key, ...poison })) }), 'too_big'],
      [parseRequest, request({ groupBy: Array.from({ length: SUMMARY_LIMITS.groupBy + 1 + seed }, () => value), ...poison }), 'too_big'],
      [parseRequest, request({ groupBy: [value], ...poison }), 'invalid_value'],
      [parseRequest, request({ maxGroups: SUMMARY_LIMITS.groups + 1 + seed, ...poison }), 'too_big'],
      [parseRequest, request({ maxGroups: -seed, ...poison }), 'too_small'],
      [parseRequest, request({ metrics: [], ...poison }), 'too_small'],
      [parseRequest, request({ metrics: [{ op: 'count', alias: value.toUpperCase() }], ...poison }), 'invalid_format'],
      [parseRequest, request({ window: { ...window, from: value, ...poison } }), 'invalid_format'],
      [parseRequest, request({ metrics: [{ op: 'count', alias: key }, { op: 'count', alias: key }], ...poison }), 'custom'],
      [parseRequest, request({ window: { ...window, to: window.from, ...poison } }), 'custom'],
      [resultSchema, { ...result, data: Array.from({ length: SUMMARY_LIMITS.groups + 1 + seed }, () => ({ ...row, ...poison })) }, 'too_big'],
      [resultSchema, { ...result, data: [{ ...row, groups: {} }] }, 'invalid_value'],
      [resultSchema, { ...result, data: [{ ...row, metrics: { [key]: value } }] }, 'invalid_type'],
      [resultSchema, { ...result, data: [{ ...row, metrics: { [key]: -1 - seed } }] }, 'too_small'],
      [resultSchema, { ...result, data: [{ ...row, groups: { [key]: `${value}_rejected` } }] }, 'invalid_value'],
      [resultSchema, { ...result, data: [{ ...row, groups: { ...row.groups, ...poison }, metrics: { ...row.metrics, ...poison } }] }, 'invalid_type'],
      [resultParser(config, 'sales', grouped), { ...groupedResult, data: [{ ...groupRow, groups: { ...groupRow.groups, ...poison }, metrics: { ...groupRow.metrics, ...poison } }] }, 'unrecognized_keys'],
    ]
    for (const container of [value, [poison], seed, null]) {
      cases.push([parseRequest, container, 'invalid_type'],
        [parseRequest, { ...request(), summary: container }, 'invalid_type'],
        [parseRequest, request({ metrics: container }), Array.isArray(container) ? 'invalid_union' : 'invalid_type'],
        [parseRequest, request({ metrics: [container] }), 'invalid_type'],
        [parseRequest, request({ window: container }), 'invalid_type'],
        [resultSchema, container, 'invalid_type'],
        [resultSchema, { ...result, data: [{ ...row, groups: container, metrics: container }] }, 'invalid_type'])
    }
    for (const [contract, input, code] of cases) {
      const parsed = contract(input, { reportInput, error: () => value })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) throw new Error('Expected invalid generated summary')
      expect(parsed.issues.some(issue => issue.code === code), code).toBe(true)
      for (const issue of parsed.issues) {
        reached.add(issue.code)
        const messageKey = `${issue.code}:${issue.reason ?? ''}`
        if (messages.has(messageKey)) expect(issue.message).toBe(messages.get(messageKey))
        else messages.set(messageKey, issue.message)
        for (const bound of ['minimum', 'maximum'] as const) {
          if (bound in issue) expect(Number.isFinite(issue[bound as keyof typeof issue])).toBe(true)
        }
      }
      const serialized = JSON.stringify(parsed.issues)
      expect(serialized).not.toContain(key)
      expect(serialized).not.toContain(value)
      // Enforce the allowlist itself, including fields added by future Zod versions.
      for (const issue of parsed.issues) {
        expect(Object.keys(issue).every(field => ['code', 'path', 'message', 'reason'].includes(field))).toBe(true)
      }
      // Only plain functions cross the boundary, with plain, freshly built data.
      expect(Object.keys(parsed)).toEqual(['ok', 'issues'])
      expect(structuredClone(parsed)).toEqual(parsed)
      expect(contract(input, { reportInput: !reportInput })).toEqual(parsed)
      expect(parsed).not.toHaveProperty('error')
    }
  }
  expect([...reached].sort()).toEqual(['custom', 'invalid_format', 'invalid_type', 'invalid_union', 'invalid_value', 'too_big', 'too_small', 'unrecognized_keys'])
})

it('masks result map keys even when they match grammar tokens', () => {
  const result = resultParser(config, 'sales', { ...options, metrics: [{ op: 'count', alias: 'version' }], groupBy: ['version'] })
  const parsed = result({ kind: 'summary', version: 1, data: [{ groups: { version: 'invalid' }, metrics: { version: 'invalid' } }] })
  expect(parsed.ok).toBe(false)
  if (!parsed.ok) expect(parsed.issues.map(issue => issue.path)).toEqual([
    ['data', 0, 'groups', '[key]'], ['data', 0, 'metrics', '[key]'],
  ])
})

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
  expect(parseRequest(value).ok).toBe(true)
})
it.each([...invalidRequests, ...semanticInvalid])('rejects %s', (_, value) => {
  expect(parseRequest(value).ok).toBe(false)
})
it.each([
  ['owner', 'reference', 'Summary reference operands are unsupported'],
  ['parent', 'reference', 'Summary reference operands are unsupported'],
  ['calculated', 'computed', 'Summary computed operands are unsupported'],
  ['SUM(amount)', 'expression', 'Summary expressions are unsupported'],
  ['missing', 'unknown_field', 'Unknown summary field'],
])('rejects unsupported operands with fixed diagnostics for %s', (field, reason, message) => {
  for (const summary of [{ groupBy: [field] }, { metrics: [{ op: 'sum', field, alias: 'total' }] }, { window: { ...window, field } }]) {
    const parsed = parseRequest(request(summary))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues[0]).toMatchObject({ reason, message })
  }
})
it('rejects an unknown schema entity and does not disclose computed expressions', () => {
  expect(parseSummaryRequest(config, 'missing', request())).toEqual({ ok: false, issues: [{ code: 'invalid_summary', path: ['entity'], message: 'Invalid summary' }] })
  expect(JSON.stringify(summaryContract(config, 'sales', grouped))).not.toContain('PRIVATE_EXPRESSION_CANARY')
})
it('validates exact empty-input shapes, null groups and safe numeric results', () => {
  const plain = resultParser(config, 'sales', options), groups = resultParser(config, 'sales', grouped)
  expect(plain(ungroupedResult).ok).toBe(true)
  expect(groups(groupedResult).ok).toBe(true)
  expect(groups({ kind: 'summary', version: 1, data: [] }).ok).toBe(true)
  expect(plain({ kind: 'summary', version: 1, data: [] }).ok).toBe(false)
  for (const [key, values] of Object.entries({ rows: [-1, 1.5, null, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN], total: [1.5, Number.MAX_SAFE_INTEGER + 1, -Infinity], cost: [Infinity, NaN] })) {
    for (const value of values) expect(plain({ ...ungroupedResult, data: [{ groups: {}, metrics: { rows: 0, total: null, cost: null, [key]: value } }] }).ok).toBe(false)
  }
  expect(plain({ ...ungroupedResult, data: [{ groups: {}, metrics: { rows: Number.MAX_SAFE_INTEGER, total: Number.MIN_SAFE_INTEGER, cost: Number.MAX_VALUE } }] }).ok).toBe(true)
  for (const groupsValue of [{ ...groupRow.groups, category: 'missing' }, { ...groupRow.groups, enabled: 0 }, { ...groupRow.groups, at: null }, { ...groupRow.groups, at: '2026-01-01T01:00:00Z' }]) {
    expect(groups({ ...groupedResult, data: [{ ...groupRow, groups: groupsValue }] }).ok).toBe(false)
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
  const result = resultParser(config, 'sales', { ...options, groupBy: fields })
  const row = { ...ungroupedResult.data[0], groups }
  expect(result({ ...ungroupedResult, data: [row] }).ok).toBe(true)
  expect(result({ ...ungroupedResult, data: [{ ...row, groups: Object.fromEntries(fields.map(field => [field, null])) }] }).ok).toBe(true)
})
it.each(invalidResults.map((value, i) => [i, value] as const))('rejects malformed summary result %i', (_, value) => {
  expect(resultParser(config, 'sales', grouped)(value).ok).toBe(false)
})
it.each([1, SUMMARY_LIMITS.groups])('enforces requested output group cap %i and cap+1', maxGroups => {
  const result = resultParser(config, 'sales', { ...grouped, maxGroups })
  expect(result({ ...groupedResult, data: Array.from({ length: maxGroups }, () => groupRow) }).ok).toBe(true)
  expect(result({ ...groupedResult, data: Array.from({ length: maxGroups + 1 }, () => groupRow) }).ok).toBe(false)
})
it('projects deterministic OpenAPI and MCP-style fragments from the same canonical request and result', async () => {
  const fragments = summaryContract(config, 'sales', grouped)
  expect(summaryContract(config, 'sales', grouped)).toEqual(fragments)
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true })
  for (const input of [fragments.request]) {
    const check = ajv.compile(input)
    for (const value of validRequests) expect(check(value), JSON.stringify(check.errors)).toBe(true)
    for (const [name, value] of invalidRequests) expect(check(value), name).toBe(false)
    for (const [name, value] of semanticInvalid) expect(check(value), `semantic-only: ${name}`).toBe(true)
  }
  for (const input of [fragments.result]) {
    const check = ajv.compile(input)
    for (const value of [groupedResult, { ...groupedResult, data: [] }]) expect(check(value), JSON.stringify(check.errors)).toBe(true)
    for (const value of invalidResults) expect(check(value), JSON.stringify(value)).toBe(false)
  }
  for (const input of [summaryContract(config, 'sales', options).result]) {
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

// Review3's six annotation/clone regressions now assert construction isolation:
// callers may annotate/clone JSON projections, but cannot obtain a Zod schema.
for (const kind of ['request', 'result'] as const) {
  for (const method of ['describe', 'meta', 'clone'] as const) it(`isolates ${kind} validation from projection ${method}`, () => {
    for (const module of [publicSummary, internalSummary]) {
      expect(module).not.toHaveProperty('summaryQuerySchema')
      expect(module).not.toHaveProperty('summaryResultSchema')
      for (const exported of Object.values(module)) expect(exported).not.toHaveProperty('_zod')
    }
    const parse = kind === 'request' ? parseRequest : resultParser(config, 'sales', options)
    expect(typeof parse).toBe('function')
    for (const name of ['describe', 'meta', 'clone', 'safeParse', 'parse', '_zod']) expect(parse).not.toHaveProperty(name)
    const projection = summaryContract(config, 'sales', options)[kind]
    const annotated = method === 'clone' ? structuredClone(projection)
      : { ...projection, ...(method === 'describe' ? { description: unsafeValue } : { meta: { description: unsafeValue } }) }
    expect(JSON.parse(JSON.stringify(annotated))).toEqual(annotated)
    expect(annotated).not.toHaveProperty('_zod')
    const input = kind === 'request' ? { ...request(), ...unknownKeys } : { ...ungroupedResult, ...unknownKeys }
    for (const reportInput of [false, true]) {
      const parsed = parse(input, { reportInput, error: () => unsafeValue })
      expect(parsed.ok).toBe(false)
      expect(JSON.stringify(parsed)).not.toContain('CANARY')
    }
  })
  // Reviewer's raw-issue injection is now aimed directly at the ONE mapper,
  // without needing or exposing a mutable parser. Exercise prototype names too.
  it(`fails closed for unknown and prototype issue codes (${kind})`, () => {
    for (const code of ['UNKNOWN_CODE_CANARY', '__proto__', 'constructor', 'toString']) {
      const raw = { code, path: kind === 'request' ? ['summary', 'groupBy', 0] : ['data', 0, 'metrics', unsafeKey],
        message: unsafeValue, input: unknownKeys, received: unsafeValue, keys: [unsafeKey], options: [unsafeValue],
        params: { reason: unsafeValue }, minimum: unsafeValue, maximum: unsafeValue, future: unknownKeys }
      const issue = summaryIssue(raw)
      expect(issue).toEqual({ code: 'invalid_summary', message: 'Invalid summary',
        path: kind === 'request' ? ['summary', 'groupBy', 0] : ['data', 0, 'metrics', '[key]'] })
      expect(issue).not.toBe(raw)
      expect(JSON.stringify(issue)).not.toContain('CANARY')
    }
  })
}
it('maps invalid result options through the request boundary', () => {
  const invalid = { ...options, metrics: [{ op: 'sum', field: 'calculated', alias: 'total' }] } as const
  const parsed = parseSummaryResult(config, 'sales', invalid, ungroupedResult)
  expect(parsed).toEqual(parseSummaryRequest(config, 'sales', { entity: 'sales', summary: invalid }))
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE_EXPRESSION_CANARY')
  expect(() => summaryContract(config, 'sales', invalid)).toThrow('Invalid summary options')
})

it('selects operand reasons from trusted metadata and ignores supplied reasons', () => {
  for (const [field, reason] of [
    [{ type: 'int', computed: 'PRIVATE_EXPRESSION_CANARY' }, 'computed'],
    [{ type: 'ref', entity: 'sales' }, 'reference'],
    [{ type: 'text' }, 'unsupported_type'],
  ] as const) {
    const model = instanceConfigSchema.parse({ ...config, entities: { sales: { ...config.entities.sales,
      fields: { ...config.entities.sales.fields, operand: field },
    } } })
    const parsed = parseSummaryRequest(model, 'sales', request({
      metrics: [{ op: 'sum', field: 'operand', alias: 'total', reason: unsafeValue }], reason: unsafeValue,
    }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues).toContainEqual(expect.objectContaining({ reason }))
    expect(JSON.stringify(parsed)).not.toContain('CANARY')
  }
  const raw = { code: 'invalid_value', path: ['summary', 'groupBy', 0], params: { reason: 'reference' }, reason: 'computed' }
  expect(summaryIssue(raw)).toEqual({ code: 'invalid_value', path: raw.path, message: 'Unsupported summary value' })
})

// Review4: consumer hooks must never see even one raw issue or private schema.
for (const kind of ['request', 'result'] as const) for (const hook of ['per-parse', 'global'] as const) {
 it(`${kind} must not expose a parseable schema through the ${hook} error map`, () => {
  const input = { ...(kind === 'request' ? { entity: 'sales', summary: options }
   : { kind: 'summary', version: 1, data: [{ groups: {}, metrics: { rows: 0, total: null, cost: null } }] }),
   UNSAFE_KEY_CANARY: 'UNSAFE_VALUE_CANARY' }
  let captured: unknown
  const error = vi.fn<z.core.$ZodErrorMap>(issue => {
   if (issue.code === 'unrecognized_keys') captured = issue.inst
   return 'fixed'
  })
  const original = { ...z.config() }
  try {
   if (hook === 'global') z.config({ customError: error })
   const settings = hook === 'per-parse' ? { error, reportInput: true } : undefined
   const parsed = kind === 'request' ? Reflect.apply(parseSummaryRequest, undefined, [config, 'sales', input, settings])
    : Reflect.apply(parseSummaryResult, undefined, [config, 'sales', options, input, settings])
   expect(parsed.ok).toBe(false)
   expect(JSON.stringify(parsed)).not.toContain('CANARY')
  } finally { z.config({ ...original, customError: original.customError }) }
  const schema = captured as z.ZodType | undefined
  const escaped = typeof schema?.safeParse === 'function'
  // Confirm the consequence before asserting the intended isolation invariant.
  if (escaped) for (const derive of [(s: z.ZodType) => s, (s: z.ZodType) => s.describe('consumer'),
   (s: z.ZodType) => s.meta({ description: 'consumer' }), (s: z.ZodType) => s.clone()]) {
   const parsed = derive(schema!).safeParse(input, { reportInput: true })
   expect(parsed.success).toBe(false)
   if (!parsed.success) {
    expect(JSON.stringify(parsed.error.issues)).toContain('UNSAFE_KEY_CANARY')
    expect(JSON.stringify(parsed.error.issues)).toContain('UNSAFE_VALUE_CANARY')
    expect(parsed.error.issues[0]).toHaveProperty('input')
   }
  }
  expect(error).toHaveBeenCalledTimes(0)
  expect(captured).toBeUndefined()
  expect(escaped, 'Raw issue.inst crossed the supposedly private boundary').toBe(false)
 })
}

it('never invokes global error or locale hooks on any summary validation path', () => {
  const original = { ...z.config() }
  const customError = vi.fn<z.core.$ZodErrorMap>(() => undefined)
  const localeError = vi.fn<z.core.$ZodErrorMap>(() => 'consumer locale message')
  try {
    z.config({ customError, localeError })
    for (const [, parse, input] of unknownKeyCases) expect(parse(input).ok).toBe(false)
    for (const [, input] of [...invalidRequests, ...semanticInvalid]) expect(parseRequest(input).ok).toBe(false)
    for (const input of invalidResults) expect(resultParser(config, 'sales', grouped)(input).ok).toBe(false)
    // Nested metric and predicate unions finalize child issues before the root.
    expect(parseRequest(request({ metrics: [{ op: 'unknown', alias: unsafeValue }] })).ok).toBe(false)
    expect(parseRequest({ ...request(), where: { amount: { eq: unsafeValue }, and: [null] } }).ok).toBe(false)
    const invalid = { ...options, metrics: [{ op: 'sum', field: 'calculated', alias: 'total' }] } as const
    expect(parseSummaryResult(config, 'sales', invalid, ungroupedResult).ok).toBe(false)
    expect(() => summaryContract(config, 'sales', invalid)).toThrow('Invalid summary options')
    expect(parseSummaryRequest(config, 'missing', request()).ok).toBe(false)
    expect(parseRequest(request()).ok).toBe(true)
    expect(resultParser(config, 'sales', options)(ungroupedResult).ok).toBe(true)
    expect(customError).toHaveBeenCalledTimes(0)
    expect(localeError).toHaveBeenCalledTimes(0)
    expect(z.config().customError).toBe(customError)
    expect(z.config().localeError).toBe(localeError)
  } finally {
    z.config({ customError: original.customError, localeError: original.localeError })
  }
  expect(z.config().customError).toBe(original.customError)
  expect(z.config().localeError).toBe(original.localeError)
})

it('pins error-map precedence for root and nested union finalization', () => {
  const original = { ...z.config() }
  const customError = vi.fn<z.core.$ZodErrorMap>(() => 'global')
  const localeError = vi.fn<z.core.$ZodErrorMap>(() => 'locale')
  const error = vi.fn<z.core.$ZodErrorMap>(() => 'SDK-owned constant')
  try {
    z.config({ customError, localeError })
    const schema = z.union([z.strictObject({ number: z.number() }), z.strictObject({ flag: z.boolean() })])
    const parsed = schema.safeParse({ number: 'invalid', flag: 'invalid' }, { error })
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('Expected invalid union')
    const issue = parsed.error.issues[0]
    expect(issue.code).toBe('invalid_union')
    expect(issue.message).toBe('SDK-owned constant')
    if (issue.code !== 'invalid_union') throw new Error('Expected invalid union issue')
    for (const child of issue.errors.flat()) expect(child.message).toBe('SDK-owned constant')
    expect(error.mock.calls.length).toBeGreaterThan(1)
    expect(customError).toHaveBeenCalledTimes(0)
    expect(localeError).toHaveBeenCalledTimes(0)
    // Positive control: without a per-parse map the shared global hook runs.
    expect(z.number().safeParse('invalid').error?.issues[0].message).toBe('global')
    expect(customError).toHaveBeenCalledTimes(1)
    z.config({ customError: undefined })
    expect(z.number().safeParse('invalid').error?.issues[0].message).toBe('locale')
    expect(localeError).toHaveBeenCalledTimes(1)
  } finally {
    z.config({ customError: original.customError, localeError: original.localeError })
  }
})
