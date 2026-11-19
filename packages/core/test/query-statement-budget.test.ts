import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { defineInstance, Q, Fn, Cond } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import type { Scope } from '../src/types'
import { executeQuery, type QueryLog } from '../src/query/executor'
import { validateQuery } from '../src/query/schema'
import { QUERY_LIMITS as L } from '../src/query/limits'
import { setup, insertDomain, runtime } from '@workbasehq/test-support/helpers'

// Lower only the statement budget, without changing SDK constants or letting the
// relation cap reject the shape first. Each test gets the real limits otherwise.
const budget = vi.hoisted(() => ({ statements: 16 }))
vi.mock('../src/query/limits', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/query/limits')>()
  return { ...actual, QUERY_LIMITS: { ...actual.QUERY_LIMITS, get statements() { return budget.statements } } }
})

const config = defineInstance({ ...sample, entities: { ...sample.entities,
  clients: { ...sample.entities.clients, relations: { ...sample.entities.clients.relations,
    other_jobs: { entity: 'jobs', field: 'client_id', many: true },
  } },
} })
const kernel = new KernelRegistry(config)
let scope: Scope
let logs: QueryLog[]
let prepare: ReturnType<typeof vi.fn>; let batch: ReturnType<typeof vi.fn>
const nested = { entity: 'clients', select: ['id'], limit: 1, include: {
  jobs: { select: ['id'], limit: 1, include: { client: { select: ['id'] } } },
  other_jobs: { select: ['id'], limit: 1, include: { client: { select: ['id'] } } },
} }
function run(input: unknown, current = kernel) {
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return prepare
    if (key === 'batch') return batch
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return executeQuery(current, scope, db, 'synthetic-query-secret-32-characters', input, { writeLog: log => logs.push(log) })
}
beforeEach(async () => {
  budget.statements = 16
  await setup(config); await insertDomain()
  scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  logs = []
  prepare = vi.fn((sql: string) => env.DB.prepare(sql))
  batch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements))
})

it.each([1, 100])('estimates one root statement independent of root limit %i', limit => {
  expect(validateQuery(kernel, scope, { entity: 'clients', select: ['id'], limit }).cost).toMatchObject({ statements: 1, relations: 0 })
})
it('counts sibling include occurrences targeting the same entity, independent of parent and child limits', () => {
  for (const limit of [1, 100]) {
    const { cost } = validateQuery(kernel, scope, { entity: 'clients', select: ['id'], limit, include: {
      jobs: { select: ['id'], limit: 1 }, other_jobs: { select: ['id'], limit: 20 },
    } })
    expect(cost).toMatchObject({ statements: 3, relations: 2 })
  }
})
it('counts nested includes separately across repeated entity branches', async () => {
  expect(validateQuery(kernel, scope, nested).cost).toMatchObject({ statements: 5, relations: 4 })
  await run(nested)
  expect(prepare).toHaveBeenCalledTimes(5)
  expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([1, 2, 2])
  expect(logs[0]).toMatchObject({ estimatedCost: { statements: 5 }, statementCount: 5 })
})
it('relation filters and label joins, filters and ordering add no driver statements', async () => {
  const input = { entity: 'jobs', select: ['id'], limit: 1,
    where: { client: { name: { contains: 'Client' } } }, labels: ['client_id'],
    labelWhere: { client_id: { contains: 'Client' } }, orderBy: [{ field: 'client_id', dir: 'asc', label: true }],
  }
  expect(validateQuery(kernel, scope, input).cost).toMatchObject({ statements: 1, relations: 2 })
  await run(input)
  expect(prepare).toHaveBeenCalledTimes(1); expect(batch).toHaveBeenCalledTimes(1)
  expect(logs[0]).toMatchObject({ estimatedCost: { statements: 1 }, statementCount: 1 })
})
it('computed and policy subqueries add no driver statements', async () => {
  const configured = defineInstance({ ...config, entities: { ...config.entities,
    clients: { ...config.entities.clients, fields: { ...config.entities.clients.fields,
      job_count: { type: 'int', computed: Q.select().from('jobs', 'j').field(Fn.count('j.id')).where(Cond.columnEqual('j.client_id', 'self.id')).serialize() },
    } },
  } })
  const current = new KernelRegistry(configured, { plugins: [...configured.plugins!, {
    name: 'statement_policy', version: '1', tableFilter: entity => entity === 'clients'
      ? { kind: 'where', predicate: { exists: { entity: 'jobs', field: 'client_id', parentField: 'id', predicate: { title: { ne: 'hidden' } } } } }
      : { kind: 'all' },
  }] })
  const input = { entity: 'clients', select: ['id', 'job_count'], limit: 1 }
  expect(validateQuery(current, scope, input).cost).toMatchObject({ statements: 1, expressionSources: 1, relations: 1 })
  expect((await run(input, current)).data).toEqual([{ id: 'client-org-a', job_count: 1 }])
  expect(prepare).toHaveBeenCalledTimes(1); expect(batch).toHaveBeenCalledTimes(1)
  expect(logs[0]).toMatchObject({ estimatedCost: { statements: 1 }, statementCount: 1 })
})
it.each([
  { where: { id: { eq: 'missing-parent' } }, expected: [] },
  { where: { id: { eq: 'client-org-a' } }, expected: [{ id: 'client-org-a', jobs: [], other_jobs: [] }] },
])('keeps the full estimate when empty parents skip include statements %#', async ({ where, expected }) => {
  await env.DB.prepare('DELETE FROM slots').run()
  await env.DB.prepare('DELETE FROM jobs').run()
  const input = { ...nested, where }
  expect(validateQuery(kernel, scope, input).cost).toMatchObject({ statements: 5 })
  expect((await run(input)).data).toEqual(expected)
  const actual = expected.length ? 3 : 1
  expect(prepare).toHaveBeenCalledTimes(actual)
  expect(logs[0]).toMatchObject({ estimatedCost: { statements: 5 }, statementCount: actual })
})
it('accepts the exact statement cap while other validation budgets have headroom', async () => {
  budget.statements = 5
  const { cost } = validateQuery(kernel, scope, nested)
  expect(cost).toMatchObject({ statements: L.statements, relations: 4 })
  expect(cost.relations).toBeLessThan(L.relations)
  await run(nested)
  expect(prepare).toHaveBeenCalledTimes(5)
  expect(logs[0]).toMatchObject({ estimatedCost: { statements: 5 }, statementCount: 5, errorCode: null })
})
it.each([undefined, { id: { eq: 'missing-parent' } }])('rejects cap+1 during validation with numeric diagnostics and zero SQL %#', async where => {
  budget.statements = 4
  const input = { ...nested, ...(where ? { where } : {}) }
  const failure = { status: 400, code: 'query_too_expensive', path: [], cost: {
    statements: 5, relations: 4, depth: 2, exists: expect.any(Number), fieldRows: expect.any(Number), nodes: expect.any(Number),
  } }
  const error = await run(input).then(() => null, error => error)
  expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled()
  expect(error).toMatchObject(failure)
  expect(() => validateQuery(kernel, scope, input)).toThrowError(expect.objectContaining(failure))
  expect(logs[0]).toMatchObject({ estimatedCost: { statements: 5 }, statementCount: 0, errorCode: 'query_too_expensive' })
})
it.each(['preflight', 'relationDepth'])('includes numeric statements in early %s cost diagnostics', kind => {
  const input = kind === 'preflight'
    ? { entity: 'clients', limit: 1, where: { and: Array.from({ length: 401 }, () => ({})) } }
    : { entity: 'clients', limit: 1, include: { jobs: { include: { client: { include: { jobs: {} } } } } } }
  expect(() => validateQuery(kernel, scope, input)).toThrowError(expect.objectContaining({
    code: 'query_too_expensive', cost: expect.objectContaining({ statements: expect.any(Number) }),
  }))
})
it('charges an exact total statement and rejects it at cap+1 before SQL', async () => {
  const input = { ...nested, includeTotal: true }
  budget.statements = 5
  await expect(run(input)).rejects.toMatchObject({ code: 'query_too_expensive', cost: { statements: 6 } })
  expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled()
  budget.statements = 6
  await expect(run(input)).resolves.toMatchObject({ total: 1 })
  expect(prepare).toHaveBeenCalledTimes(6)
  expect(logs.at(-1)).toMatchObject({ estimatedCost: { statements: 6 }, statementCount: 6 })
})
