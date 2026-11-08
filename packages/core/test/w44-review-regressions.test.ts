import { expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { defineInstance, Q, Fn, Cond } from '../src/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { tenancy } from '../src/plugins'
import { setup, runtime, request } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeQuery } from '../src/query/executor'
import { validateQuery } from '../src/query/schema'
import { scopeOperations } from '../src/scope-operations'
import { ExpressionError } from '../src/query/expressions'

const count = () => Q.select().from('people', 'p').field(Fn.count(Q.value(1))).where(Cond.isNotNull('self.id')).serialize()
const input = () => ({ id: 'w44_review', revision: 1, interactive: true, plugins: [identity, localAuth, tenancy, legacyPermissions], roles: ['owner'],
  permissions: { owner: { notes: ['read' as const], people: ['read' as const] } }, policies: { notes: { owner: 'all' as const }, people: { owner: 'all' as const } },
  entities: {
    notes: { displayField: 'title', fields: { title: { type: 'string' as const }, amount: { type: 'int' as const }, date: { type: 'datetime' as const }, value: { type: 'int' as const, computed: count() } } },
    people: { displayField: 'name', fields: { name: { type: 'string' as const }, note: { type: 'ref' as const, entity: 'notes' }, person_key: { type: 'string' as const } } },
  } })
async function fixture(config: ReturnType<typeof defineInstance>) {
  const app = await setup(config)
  for (const [id, date] of [['n1', '2025-02-01T12:00:00Z'], ['n2', '2026-03-01T12:00:00Z']]) {
    await env.DB.prepare('INSERT INTO notes(id,organization_id,title,amount,date,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(id, 'org-a', id, 3, date, date, date).run()
  }
  for (const [id, org] of [['p1', 'org-a'], ['p2', 'org-a'], ['pb', 'org-b']]) {
    await env.DB.prepare('INSERT INTO people(id,organization_id,name,note,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, org, id, org === 'org-a' ? 'n1' : null, '2026-01-01', '2026-01-01').run()
  }
  const kernel = new KernelRegistry(config)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const run = (query: unknown, current = kernel) => executeQuery(current, scope, env.DB, 'synthetic', query, { writeLog: () => {} })
  return { app, kernel, scope, run }
}
function invalid(value: Parameters<typeof defineInstance>[0], pattern: RegExp) {
  let error: unknown
  try { defineInstance(value) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ExpressionError)
  expect(error).toMatchObject({ code: 'invalid_expression', errors: [expect.objectContaining({ code: 'invalid_expression', message: expect.stringMatching(pattern), suggestedFix: expect.any(String) })] })
}

it.each(['no read grant', 'empty field mask', 'unreadable identity', 'own entity operation allowlist'])('P1 subquery sources bypass read permission / empty field mask: %s', async mode => {
  const value: any = input()
  value.entities.notes.fields.exists = { type: 'bool', computed: Cond.exists(Q.select().from('people', 'p').field('self.id').limit(1)).serialize() }
  if (mode === 'no read grant') delete value.permissions.owner.people
  const config = defineInstance(value)
  const { app, kernel, scope, run } = await fixture(config)
  const current = mode === 'empty field mask' || mode === 'unreadable identity' ? new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'mask_source', version: '1', fieldMask: entity => entity === 'people' ? mode === 'empty field mask' ? [] : ['name'] : kernel.fieldMask(entity, scope) }] }) : kernel
  if (mode === 'own entity operation allowlist') scopeOperations.set(scope, { operations: ['notes.read'] })
  const query = { entity: 'notes', select: ['value', 'exists'], limit: 10 }
  expect((await run(query, current)).data).toEqual([{ value: null, exists: null }, { value: null, exists: null }])
  if (mode === 'no read grant') {
    const response = await request(app, '/query', 'POST', query)
    expect(response.status).toBe(200)
    expect((await response.json() as any).data[0]).toEqual({ value: null, exists: null })
  }
})

it.each(['YEAR', 'MONTH'])('P2 YEAR/MONTH type mismatch breaks cursor pagination: %s computed int page 2', async fn => {
  const value = input(); value.entities.notes.fields.value.computed = `FN(["${fn}","created_at"])`
  const { run } = await fixture(defineInstance(value))
  const query = { entity: 'notes', select: ['id', 'value'], orderBy: [{ field: 'value', dir: 'asc' }], limit: 1 }
  const first = await run(query)
  expect(first.data[0]).toEqual({ id: 'n1', value: fn === 'YEAR' ? 2025 : 2 })
  expect(first.next_cursor).toBeTruthy()
  const second = await run({ ...query, cursor: first.next_cursor })
  expect(second.data[0]).toEqual({ id: 'n2', value: fn === 'YEAR' ? 2026 : 3 })
})

it.each([
  ['IFNULL', 'FN(["IFNULL","title"])', 'string'], ['COALESCE', 'FN(["COALESCE","title"])', 'string'],
  ['LOWER', 'FN(["LOWER","title","title"])', 'string'], ['DATEDIFF', 'FN(["DATEDIFF","date","date"])', 'int'],
  ['ROUND', 'FN(["ROUND","amount","title"])', 'int'], ['SUBSTR', 'FN(["SUBSTR","title","title"])', 'string'],
  ['REPLACE', 'FN(["REPLACE","title","title"])', 'string'], ['NULLIF', 'FN(["NULLIF","title"])', 'string'],
  ['YEAR', 'FN(["YEAR","amount"])', 'int'], ['STRFTIME', 'FN(["STRFTIME","amount","date"])', 'string'],
  ['DATEADD', `FN(${JSON.stringify(['DATEADD', 'date', 'amount', Q.value('day').serialize()])})`, 'datetime'],
])('P2 function allowlist accepts non-executable expressions: %s contract (%s)', (fn, wire, type) => {
  const value: any = input(); value.entities.notes.fields.value = { type, computed: wire }
  invalid(value, new RegExp(fn))
})

it.each(['date-only', 'number-only'])('P2 computed intermediates bypass display validation: %s provenance', mode => {
  const value: any = input()
  value.entities.notes.fields.intermediate = { type: 'string', computed: mode === 'date-only' ? Fn.strftime('%Y-%m-%d', 'date').serialize() : Fn.concat('amount').serialize() }
  value.entities.notes.fields.second = { type: 'string', computed: 'FN(["UPPER","intermediate"])' }
  value.entities.notes.displayField = Fn.concat('second').serialize()
  invalid(value, /descriptive text/)
})
it('P2 computed intermediates bypass display validation: accumulated computed ref hops', () => {
  const value: any = input()
  value.entities.notes.fields.link = { type: 'ref', entity: 'people' }
  value.entities.notes.fields.person = { type: 'ref', entity: 'people', computed: 'link.person_key' }
  value.entities.notes.displayField = Fn.concat('person.name').serialize()
  invalid(value, /at most one hop/)
})
it('P2 computed intermediates retain descriptive text through valid composition', () => {
  const value: any = input()
  value.entities.notes.fields.intermediate = { type: 'string', computed: Fn.concat('title', Fn.strftime('%Y', 'date')).serialize() }
  value.entities.notes.displayField = Fn.concat('intermediate').serialize()
  expect(() => defineInstance(value)).not.toThrow()
})

it.each(['Cartesian', 'non-key equality', 'OR equality', 'negated equality'])('P2 expression cost escapes cost model: reject %s sources', mode => {
  const value = input()
  const join = Cond.columnEqual(mode === 'non-key equality' ? 'p.name' : 'p.id', mode === 'non-key equality' ? 'p2.name' : 'p2.id')
  const condition = mode === 'OR equality' ? Cond.or([join, Cond.isNotNull('self.id')]) : mode === 'negated equality' ? Cond.not(join) : join
  value.entities.notes.fields.value.computed = Q.select().from('people', 'p').crossJoin(Q.table('people', 'p2'), Cond.isNotNull('self.id')).field(Fn.count(Q.value(1))).where(mode === 'Cartesian' ? Cond.isNotNull('self.id') : condition).serialize()
  invalid(value, /source|Cartesian|equality/i)
})
it('P2 expression cost escapes cost model: expanded sources count and indexed correlation executes', async () => {
  const value: any = input()
  value.entities.notes.fields.value.computed = Q.select().from('people', 'p').innerJoin(Q.table('people', 'p2'), Cond.columnEqual('p2.id', 'p.id')).field(Fn.count('p.id')).where(Cond.columnEqual('p.note', 'self.id')).serialize()
  value.entities.notes.fields.twice = { type: 'int', computed: Fn.add('value', Q.value(1)).serialize() }
  const { kernel, scope, run } = await fixture(defineInstance(value))
  const query = { entity: 'notes', select: ['twice'], orderBy: [{ field: 'twice', dir: 'desc' }], limit: 10 }
  const { cost } = validateQuery(kernel, scope, query)
  expect(cost.expressionSources).toBe(2)
  expect(cost.relations).toBeGreaterThanOrEqual(2)
  expect(cost.nodes).toBeGreaterThan(0)
  expect(cost.fieldRows).toBeGreaterThan(10)
  expect((await run(query)).data[0].twice).toBe(3)
})
it('P2 expression cost escapes cost model: repeated source expansions exceed query budget', async () => {
  const value: any = input()
  for (let i = 0; i < 9; i++) value.entities.notes.fields[`count_${i}`] = { type: 'int', computed: count() }
  const { kernel, scope } = await fixture(defineInstance(value))
  expect(() => validateQuery(kernel, scope, { entity: 'notes', select: Array.from({ length: 9 }, (_, i) => `count_${i}`), limit: 100 })).toThrow(/expensive/)
})

it('P2 alias-free sources validate but fail after scoping: materialize people alias', async () => {
  const value: any = input(); value.entities.notes.fields.value = { type: 'string', computed: Q.select().from('people').field('people.name').orderBy('people.name', 'ASC').limit(1).serialize() }
  const { run } = await fixture(defineInstance(value))
  expect((await run({ entity: 'notes', select: ['value'], limit: 1 })).data[0].value).toBe('p1')
})

it('P2 expression cost escapes cost model: computed sources expand separately for two ref paths', async () => {
  const value: any = input()
  value.entities.notes.fields.first = { type: 'ref', entity: 'people' }
  value.entities.notes.fields.second = { type: 'ref', entity: 'people' }
  value.entities.people.fields.work = { type: 'int', computed: Q.select().from('notes', 'n').field(Fn.count('n.id')).where(Cond.columnEqual('n.id', 'self.note')).serialize() }
  value.entities.notes.fields.value = { type: 'string', computed: Fn.concat('first.work', 'second.work').serialize() }
  const { kernel, scope } = await fixture(defineInstance(value))
  expect(validateQuery(kernel, scope, { entity: 'notes', select: ['value'], limit: 1 }).cost.expressionSources).toBe(4)
})
it('P2 expression cost escapes cost model: sibling aliases retain separate computed source costs', async () => {
  const value: any = input()
  value.entities.people.fields.work = { type: 'int', computed: Q.select().from('notes', 'n').field(Fn.count('n.id')).serialize() }
  const sub = Q.select().from('people', 'p').field('p.work').limit(1)
  value.entities.notes.fields.value = { type: 'bool', computed: Cond.and([Cond.exists(sub), Cond.exists(sub)]).serialize() }
  const { kernel, scope } = await fixture(defineInstance(value))
  expect(validateQuery(kernel, scope, { entity: 'notes', select: ['value'], limit: 1 }).cost.expressionSources).toBe(4)
})
it('P2 function allowlist accepts executable SQLite contracts and normalizes function case', async () => {
  const value: any = input()
  value.entities.notes.fields.value = { type: 'string', computed: 'FN(["lower","title"])' }
  value.entities.notes.fields.shifted = { type: 'datetime', computed: Fn.dateAdd('date', 1, 'day').serialize() }
  value.entities.notes.fields.fallback = { type: 'string', computed: `FN(${JSON.stringify(['COALESCE', 'title', Q.value('fallback').serialize()])})` }
  value.entities.notes.fields.snippet = { type: 'string', computed: `FN(${JSON.stringify(['SUBSTR', 'title', Q.value(1).serialize(), Q.value(1).serialize()])})` }
  const { run } = await fixture(defineInstance(value))
  expect((await run({ entity: 'notes', select: ['value', 'shifted', 'fallback', 'snippet'], limit: 1 })).data[0]).toEqual({ value: 'n1', shifted: '2025-02-02 12:00:00', fallback: 'n1', snippet: 'n' })
})
