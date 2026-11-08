import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { defineInstance, Q, Fn, Cond, type Field } from '../src/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { tenancy } from '../src/plugins'
import { setup, runtime } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeQuery } from '../src/query/executor'
import { validateQuery } from '../src/query/schema'
import { compileAggregate } from '../src/query/compiler'
import { ExpressionError } from '../src/query/expressions'

const aggregate = (fn: string, operand: string) => Q.expr(`FN(${JSON.stringify([fn, operand])})`)
const scalarMinMax = (fn: string, operand: string) => Q.expr(`FN(${JSON.stringify([fn, operand, Q.value(4).serialize()])})`)
type TestInput = Omit<Parameters<typeof defineInstance>[0], 'entities'> & {
  entities: Record<string, { displayField: string; fields: Record<string, Pick<Field, 'type' | 'computed' | 'entity'>> }>
}
function input(): TestInput {
  return { id: 'w44_review3', revision: 1, interactive: true,
    plugins: [identity, localAuth, tenancy, legacyPermissions], roles: ['owner'],
    permissions: { owner: { notes: ['read'], people: ['read'] } },
    policies: { notes: { owner: 'all' }, people: { owner: 'all' } },
    entities: {
      notes: { displayField: 'title', fields: {
        title: { type: 'string' }, amount: { type: 'int' }, date: { type: 'datetime' }, person: { type: 'ref', entity: 'people' },
        value: { type: 'int', computed: Fn.add('amount', Q.value(1)).serialize() },
      } },
      people: { displayField: 'name', fields: { name: { type: 'string' }, note: { type: 'ref', entity: 'notes' } } },
    },
  }
}
function invalid(value: Parameters<typeof defineInstance>[0], message: RegExp, fix: RegExp) {
  let error: unknown
  try { defineInstance(value) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ExpressionError)
  expect(error).toMatchObject({ code: 'invalid_expression', errors: [expect.objectContaining({
    code: 'invalid_expression', message: expect.stringMatching(message), suggestedFix: expect.stringMatching(fix),
  })] })
}
async function fixture(config: ReturnType<typeof defineInstance>) {
  await setup(config)
  for (const [id, date] of [['n1', '2025-02-01T12:00:00Z'], ['n2', '2026-03-01T12:00:00Z']]) {
    await env.DB.prepare('INSERT INTO notes(id,organization_id,title,amount,date,person,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, 'org-a', id, 3, date, null, date, date).run()
  }
  for (const [id, org] of [['p1', 'org-a'], ['p2', 'org-a'], ['pb', 'org-b']]) {
    await env.DB.prepare('INSERT INTO people(id,organization_id,name,note,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .bind(id, org, id, org === 'org-a' ? 'n1' : null, '2026-01-01', '2026-01-01').run()
  }
  await env.DB.prepare('UPDATE notes SET person=?').bind('p1').run()
  const kernel = new KernelRegistry(config)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const run = (query: unknown) => executeQuery(kernel, scope, env.DB, 'synthetic', query, { writeLog: () => {} })
  const count = async (input: unknown) => {
    const { query, cost } = validateQuery(kernel, scope, input)
    const statement = compileAggregate(kernel, scope, query, { fn: 'count' }, cost)
    return (await env.DB.prepare(statement.sql).bind(...statement.bindings).first<{ value: number }>())?.value
  }
  return { run, count }
}

describe('R3 finding 1: computed fields preserve entity row cardinality', () => {
  it.each(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'])('rejects bare %s with a scalar SELECT hint', fn => {
    const value = input()
    value.entities.notes.fields.value.computed = aggregate(fn, 'amount').serialize()
    invalid(value, /aggregate/i, /wrap.*(?:SELECT|subquery)/i)
  })
  it.each(['scalar wrapper', 'condition'])('rejects a bare aggregate inside a %s', mode => {
    const value = input()
    value.entities.notes.fields.value.computed = mode === 'scalar wrapper' ? Fn.abs(Fn.sum('amount')).serialize()
      : Fn.if(Cond.greaterThan(Fn.count('id'), 1), 'amount', Q.value(0)).serialize()
    invalid(value, /aggregate/i, /wrap.*(?:SELECT|subquery)/i)
  })
  it.each(['SUM', 'COUNT', 'MIN', 'MAX'])('rejects %s over a bare aggregate computed dependency', fn => {
    const value = input()
    // Visit the consumer first: expanding this dependency must not hide SUM.
    value.entities.notes.fields.value.computed = aggregate(fn, 'total').serialize()
    value.entities.notes.fields.total = { type: 'int', computed: Fn.sum('amount').serialize() }
    invalid(value, /aggregate/i, /wrap.*(?:SELECT|subquery)/i)
  })
  it('rejects a bare aggregate reached through scalar computed dependencies', () => {
    const value = input()
    value.entities.notes.fields.value.computed = Fn.add('middle', Q.value(1)).serialize()
    value.entities.notes.fields.middle = { type: 'int', computed: Fn.abs('total').serialize() }
    value.entities.notes.fields.total = { type: 'int', computed: Fn.sum('amount').serialize() }
    invalid(value, /aggregate/i, /wrap.*(?:SELECT|subquery)/i)
  })
  it('rejects a bare aggregate dependency even when consumed from an explicit SELECT', () => {
    const value = input()
    value.entities.notes.fields.value.computed = Q.select().from('notes', 'n').field(Fn.sum('n.total')).serialize()
    value.entities.notes.fields.total = { type: 'int', computed: Fn.sum('amount').serialize() }
    invalid(value, /aggregate/i, /wrap.*(?:SELECT|subquery)/i)
  })
  it.each(['MIN', 'MAX'])('executes scalar multi-argument %s without collapsing lists or counts', async fn => {
    const value = input()
    value.entities.notes.fields.value.computed = scalarMinMax(fn, 'amount').serialize()
    const { run, count } = await fixture(defineInstance(value))
    const query = { entity: 'notes', select: ['id', 'value'], orderBy: [{ field: 'id', dir: 'asc' }], limit: 10 }
    expect((await run(query)).data).toEqual([{ id: 'n1', value: fn === 'MIN' ? 3 : 4 }, { id: 'n2', value: fn === 'MIN' ? 3 : 4 }])
    expect(await count(query)).toBe(2)
  })
  it('executes scalar SELECT aggregates and computed composition while preserving unselected lists and counts', async () => {
    const value = input()
    value.entities.notes.fields.total = { type: 'int', computed: Q.select().from('people', 'p').field(Fn.count('p.id')).where(Cond.columnEqual('p.note', 'self.id')).serialize() }
    value.entities.notes.fields.value.computed = Fn.add('total', Q.value(1)).serialize()
    value.entities.notes.fields.total_sum = { type: 'int', computed: Q.select().from('notes', 'n').field(Fn.sum('n.total')).serialize() }
    const { run, count } = await fixture(defineInstance(value))
    const query = { entity: 'notes', select: ['id', 'title'], orderBy: [{ field: 'id', dir: 'asc' }], limit: 10 }
    expect((await run(query)).data).toEqual([{ id: 'n1', title: 'n1' }, { id: 'n2', title: 'n2' }])
    expect(await count(query)).toBe(2)
    expect((await run({ ...query, select: ['value', 'total_sum'] })).data).toEqual([{ value: 3, total_sum: 2 }, { value: 1, total_sum: 2 }])
  })
  it('validates and executes the Rezervace formatted date and one-level ref label through computed intermediates', async () => {
    const value = input()
    value.entities.people.fields.caption = { type: 'string', computed: Fn.concat('name', Q.value('!')).serialize() }
    value.entities.notes.fields.caption = { type: 'string', computed: Fn.concat(Fn.strftime('%d. %m. %Y', 'date'), Q.value(' · '), 'person.caption').serialize() }
    value.entities.notes.displayField = Fn.concat('caption').serialize()
    const { run } = await fixture(defineInstance(value))
    expect((await run({ entity: 'notes', select: ['computed_display'], orderBy: [{ field: 'computed_display', dir: 'asc' }],
      search: { fields: ['computed_display'], text: 'p1!' }, limit: 10 })).data)
      .toEqual([{ computed_display: '01. 02. 2025 · p1!' }, { computed_display: '01. 03. 2026 · p1!' }])
  })
})

describe('R3 finding 2: aggregates respect query clause context', () => {
  it.each(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'].flatMap(fn => ['WHERE', 'INNER ON', 'LEFT ON', 'ORDER BY'].map(clause => [fn, clause])))('rejects %s in %s', (fn, clause) => {
    const value = input()
    let query = Q.select().from('notes', 'n')
    const condition = Cond.greaterThan(Fn.abs(aggregate(fn, 'n.amount')), 1)
    if (clause === 'WHERE') query = query.where(Cond.not(Cond.not(condition)))
    if (clause.endsWith('ON')) {
      const on = Cond.and([Cond.columnEqual('p.note', 'n.id'), condition])!
      query = clause === 'LEFT ON' ? query.leftJoin(Q.table('people', 'p'), on) : query.innerJoin(Q.table('people', 'p'), on)
    }
    query = query.field(clause === 'ORDER BY' ? 'n.amount' : Fn.count('n.id'))
    if (clause === 'ORDER BY') query = query.orderBy(Fn.abs(aggregate(fn, 'n.amount')), 'ASC').limit(1)
    value.entities.notes.fields.value.computed = query.serialize()
    invalid(value, /aggregate.*(?:WHERE|ON|ORDER BY)/i, /SELECT|subquery/i)
  })
  it('does not let an aggregate inside a scalar SELECT make the enclosing SELECT aggregate', () => {
    const value = input()
    const inner = Q.select().from('people', 'p').field(Fn.count('p.id'))
    value.entities.notes.fields.value.computed = Q.select().from('notes', 'n').field(Fn.if(Cond.exists(inner), 'n.amount', Q.value(0)))
      .orderBy(Fn.sum('n.amount'), 'ASC').limit(1).serialize()
    invalid(value, /aggregate.*ORDER BY/i, /SELECT|subquery/i)
  })
  it('executes an ORDER BY aggregate when SELECT contains a wrapped aggregate', async () => {
    const value = input()
    value.entities.notes.fields.value.computed = Q.select().from('notes', 'n').field(Fn.abs(Fn.sum('n.amount'))).orderBy(Fn.count('n.id'), 'ASC').serialize()
    const { run } = await fixture(defineInstance(value))
    expect((await run({ entity: 'notes', select: ['value'], limit: 10 })).data).toEqual([{ value: 6 }, { value: 6 }])
  })
  it.each(['WHERE', 'JOIN ON', 'ORDER BY'])('allows aggregates in separate scalar SELECT contexts within %s', async clause => {
    const value = input()
    const inner = Q.select().from('people', 'sub').field(Fn.count('sub.id'))
    let query = Q.select().from('notes', 'n').field('n.amount').limit(1)
    if (clause === 'WHERE') query = query.where(Cond.exists(inner))
    if (clause === 'JOIN ON') query = query.innerJoin(Q.table('people', 'p'), Cond.and([Cond.columnEqual('p.note', 'n.id'), Cond.exists(inner)])!)
    if (clause === 'ORDER BY') query = query.orderBy(Cond.exists(inner), 'ASC')
    value.entities.notes.fields.value.computed = query.serialize()
    const { run } = await fixture(defineInstance(value))
    expect((await run({ entity: 'notes', select: ['value'], limit: 1 })).data[0].value).toBe(3)
  })
  it.each(['MIN', 'MAX'])('allows scalar multi-argument %s in WHERE, ON and ORDER BY', async fn => {
    const value = input()
    const condition = Cond.greaterThan(scalarMinMax(fn, 'n.amount'), 1)
    value.entities.notes.fields.value.computed = Q.select().from('notes', 'n').field('n.amount')
      .innerJoin(Q.table('people', 'p'), Cond.and([Cond.columnEqual('p.note', 'n.id'), condition])!)
      .where(condition).orderBy(scalarMinMax(fn, 'n.amount'), 'ASC').limit(1).serialize()
    const { run } = await fixture(defineInstance(value))
    expect((await run({ entity: 'notes', select: ['value'], limit: 1 })).data[0].value).toBe(3)
  })
})

describe('R3 finding 3: JOIN ON sees only preceding and current aliases', () => {
  it.each(['LEFT', 'INNER'].flatMap(join => ['direct', 'nested SELECT'].map(mode => [join, mode])))('rejects a later alias in %s ON (%s)', (join, mode) => {
    const value = input()
    let query = Q.select().from('people', 'p')
    const condition = mode === 'direct' ? Cond.columnEqual('p2.id', 'p3.id')
      : Cond.and([Cond.columnEqual('p2.id', 'p.id'), Cond.exists(Q.select().from('people', 'sub').field('sub.id').where(Cond.columnEqual('sub.id', 'p3.id')).limit(1))])!
    query = join === 'LEFT' ? query.leftJoin(Q.table('people', 'p2'), condition) : query.innerJoin(Q.table('people', 'p2'), condition)
    value.entities.notes.fields.value.computed = query.innerJoin(Q.table('people', 'p3'), Cond.columnEqual('p3.id', 'p.id')).field(Fn.count('p.id')).serialize()
    invalid(value, /alias.*p3/i, /alias|JOIN/i)
  })
  it.each(['LEFT', 'INNER'])('executes %s ON referencing current, earlier and self aliases', async join => {
    const value = input()
    const condition = Cond.and([Cond.columnEqual('p2.id', 'p.id'), Cond.columnEqual('p.note', 'self.id')])!
    let query = Q.select().from('people', 'p')
    query = join === 'LEFT' ? query.leftJoin(Q.table('people', 'p2'), condition) : query.innerJoin(Q.table('people', 'p2'), condition)
    value.entities.notes.fields.value.computed = query.innerJoin(Q.table('people', 'p3'), Cond.columnEqual('p3.id', 'p2.id')).field(Fn.count('p.id')).serialize()
    const { run } = await fixture(defineInstance(value))
    expect((await run({ entity: 'notes', select: ['value'], where: { id: { eq: 'n1' } }, limit: 1 })).data[0].value).toBe(2)
  })
  it('allows later aliases in SELECT, WHERE and ORDER BY after all joins are declared', async () => {
    const value = input()
    value.entities.notes.fields.value.computed = Q.select().from('people', 'p')
      .leftJoin(Q.table('people', 'p2'), Cond.columnEqual('p2.id', 'p.id'))
      .innerJoin(Q.table('people', 'p3'), Cond.columnEqual('p3.id', 'p2.id'))
      .field(Fn.count('p3.id')).where(Cond.isNotNull('p3.id')).orderBy(Fn.count('p3.id'), 'ASC').serialize()
    const { run } = await fixture(defineInstance(value))
    expect((await run({ entity: 'notes', select: ['value'], limit: 1 })).data[0].value).toBe(2)
  })
})
