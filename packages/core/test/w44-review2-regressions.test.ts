import { expect, it } from 'vitest'
import { toSQLWithBindings } from '@jakub.knejzlik/ts-query'
import { env } from 'cloudflare:workers'
import { defineInstance, Q, Fn, Cond } from '../src/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { tenancy } from '../src/plugins'
import { setup, runtime } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeQuery } from '../src/query/executor'
import { ExpressionError, expressionInfo } from '../src/query/expressions'

function config(computed: string, type: 'int' | 'bool' = 'int') {
  return defineInstance({ id: 'w44_review2', revision: 1, interactive: true,
    plugins: [identity, localAuth, tenancy, legacyPermissions], roles: ['owner'],
    permissions: { owner: { notes: ['read'], people: ['read'] } },
    policies: { notes: { owner: 'all' }, people: { owner: 'all' } },
    entities: {
      notes: { displayField: 'title', fields: { title: { type: 'string' }, amount: { type: 'int' }, value: { type, computed } } },
      people: { displayField: 'name', fields: { name: { type: 'string' }, note: { type: 'ref', entity: 'notes' } } },
    },
  })
}
function invalid(wire: string, message: RegExp, fix: RegExp) {
  let error: unknown
  try { config(wire) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ExpressionError)
  expect(error).toMatchObject({ code: 'invalid_expression', errors: [expect.objectContaining({
    code: 'invalid_expression', message: expect.stringMatching(message), suggestedFix: expect.stringMatching(fix),
  })] })
}
async function run(computed: string, type: 'int' | 'bool' = 'int', title = 'Title') {
  const current = config(computed, type)
  await setup(current)
  await env.DB.prepare('INSERT INTO notes(id,organization_id,title,amount,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind('n1', 'org-a', title, 3, '2026-01-01', '2026-01-01').run()
  for (const [id, org] of [['p1', 'org-a'], ['p2', 'org-a'], ['pb', 'org-b']]) {
    await env.DB.prepare('INSERT INTO people(id,organization_id,name,note,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .bind(id, org, title, org === 'org-a' ? 'n1' : null, '2026-01-01', '2026-01-01').run()
  }
  const kernel = new KernelRegistry(current)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  return (await executeQuery(kernel, scope, env.DB, 'synthetic', { entity: 'notes', select: ['value'], orderBy: [{ field: 'value', dir: 'desc' }], limit: 1 }, { writeLog: () => {} })).data[0].value
}

it.each(['right bounded', 'right unbounded'])('P2 LEFT JOIN predicates certify earlier Cartesian sources: reject %s', mode => {
  const condition = mode === 'right bounded'
    ? Cond.and([Cond.columnEqual('p2.id', 'p.id'), Cond.columnEqual('p3.id', 'p.id')])!
    : Cond.and([Cond.columnEqual('p2.id', 'p.id'), Cond.isNotNull('p3.id')])!
  const wire = Q.select().from('people', 'p').crossJoin(Q.table('people', 'p2'), Cond.isNotNull('self.id'))
    .leftJoin(Q.table('people', 'p3'), condition).field(Fn.count(Q.value(1))).where(Cond.isNotNull('self.id')).serialize()
  invalid(wire, /Cartesian|source.*equality/i, /join|where/i)
})
it.each(['INNER ON', 'WHERE', 'LEFT chain'])('P2 LEFT JOIN predicates certify earlier Cartesian sources: valid %s executes', async mode => {
  let query = Q.select().from('people', 'p')
  if (mode === 'INNER ON') query = query.innerJoin(Q.table('people', 'p2'), Cond.columnEqual('p2.id', 'p.id'))
  else if (mode === 'WHERE') query = query.crossJoin(Q.table('people', 'p2'), Cond.isNotNull('self.id')).where(Cond.columnEqual('p2.id', 'p.id'))
  else query = query.leftJoin(Q.table('people', 'p2'), Cond.columnEqual('p2.id', 'p.id'))
  query = query.leftJoin(Q.table('people', 'p3'), Cond.and([Cond.columnEqual('p2.id', 'p.id'), Cond.columnEqual('p3.id', 'p2.id')])!)
    .field(Fn.count('p.id')).where(Cond.isNotNull('self.id'))
  expect(await run(query.serialize())).toBe(2)
})
it.each(['non-key', 'OR key', 'negated key', 'LEFT ON only'])('P2 LEFT JOIN predicates certify earlier Cartesian sources: reject nested EXISTS %s correlation', mode => {
  const key = Cond.columnEqual('p2.id', 'p.id')
  let inner = Q.select().from('people', 'p2').field('p2.id').limit(1)
  if (mode === 'LEFT ON only') inner = inner.leftJoin(Q.table('people', 'p3'), Cond.and([key, Cond.columnEqual('p3.id', 'p2.id')])!)
  else inner = inner.where(mode === 'non-key' ? Cond.columnEqual('p2.name', 'p.name')
    : mode === 'OR key' ? Cond.or([key, Cond.columnEqual('p2.name', 'p.name')])! : Cond.not(key))
  invalid(Q.select().from('people', 'p').field(Fn.count('p.id')).where(Cond.exists(inner)).serialize(), /correlat|equality/i, /id|ref/i)
})
it.each(['id', 'ref', 'uncorrelated'])('P2 LEFT JOIN predicates certify earlier Cartesian sources: nested EXISTS %s executes', async mode => {
  let inner = Q.select().from('people', 'p2').field('p2.id').limit(1)
  if (mode !== 'uncorrelated') inner = inner.where(Cond.columnEqual(mode === 'id' ? 'p2.id' : 'p2.note', mode === 'id' ? 'p.id' : 'self.id'))
  const wire = Q.select().from('people', 'p').field(Fn.count('p.id')).where(Cond.exists(inner)).serialize()
  expect(await run(wire)).toBe(2)
})

it.each([
  ['SUM(COUNT)', Fn.sum(Fn.count('amount')).serialize()],
  ['COUNT(SUM)', Fn.count(Fn.sum('amount')).serialize()],
  ['SUM(ABS(COUNT))', Fn.sum(Fn.abs(Fn.count('amount'))).serialize()],
  ['single-argument MIN', Fn.sum(Fn.min('amount')).serialize()],
  ['single-argument MAX', Fn.count(Fn.max('amount')).serialize()],
  ['scalar MIN between aggregates', Fn.sum(Q.expr(`FN(${JSON.stringify(['MIN', 'amount', Fn.count('amount').serialize()])})`)).serialize()],
])('P2 nested aggregates validate but fail at execution: reject %s', (_name, wire) => {
  invalid(wire, /nested aggregate|aggregate.*inside/i, /separate SELECT|subquery|one aggregate/i)
})
it('P2 nested aggregates validate but fail at execution: reject nesting in SELECT projection', () => {
  invalid(Q.select().from('people', 'p').field(Fn.sum(Fn.count('p.id'))).serialize(), /nested aggregate|aggregate.*inside/i, /separate SELECT|subquery|one aggregate/i)
})
it.each(['MIN', 'MAX'])('P2 nested aggregates validate but fail at execution: multi-argument %s is scalar and needs LIMIT', fn => {
  invalid(Q.select().from('notes', 'n').field(Q.expr(`FN(${JSON.stringify([fn, 'n.amount', Q.value(4).serialize()])})`)).serialize(), /LIMIT 1|aggregate/i, /LIMIT|aggregate/i)
})
it.each(['MIN', 'MAX'])('P2 nested aggregates validate but fail at execution: aggregate over scalar %s executes', async fn => {
  const scalar = `FN(${JSON.stringify([fn, 'n.amount', Q.value(4).serialize()])})`
  expect(await run(Q.select().from('notes', 'n').field(Fn.sum(Q.expr(scalar))).serialize())).toBe(fn === 'MIN' ? 3 : 4)
})
it('P2 nested aggregates validate but fail at execution: sibling aggregates and scalar MIN execute', async () => {
  const scalar = `FN(${JSON.stringify(['MIN', Fn.sum('n.amount').serialize(), Fn.count('n.id').serialize()])})`
  expect(await run(Q.select().from('notes', 'n').field(Q.expr(scalar)).serialize())).toBe(1)
})
it('P2 nested aggregates validate but fail at execution: nested SELECT starts a separate aggregate context', async () => {
  const inner = Q.select().from('notes', 'n').field(Fn.sum('n.amount')).where(Cond.columnEqual('n.id', 'p.note'))
  const wire = Q.select().from('people', 'p').field(Fn.count(Cond.in('p.note', inner))).serialize()
  expect(await run(wire)).toBe(2)
})

const literals = ['{ "a": 1 }', '{hello}%', 'FN(["lower","title"])%', 'OP(["+",1,2])%']
it.each(literals)('P2 canonicalizer rewrites literal LIKE patterns / value slots: LIKE %s stays byte-exact', async pattern => {
  const wire = Cond.like('title', pattern).serialize()
  const info = expressionInfo(config(wire, 'bool'), 'notes', 'value', wire)
  expect(toSQLWithBindings(info.ast, Q.flavors.sqlite).bindings).toContain(pattern)
  expect(await run(wire, 'bool', pattern.replace(/%$/, 'matching suffix'))).toBe(true)
})
it.each(['BinaryCondition', 'BetweenCondition', 'InCondition', 'NotInCondition'])('P2 canonicalizer rewrites literal LIKE patterns / value slots: plain %s data stays byte-exact', async type => {
  for (const literal of literals) {
    const wire = JSON.stringify({ type, key: 'title', operator: '=', value: literal, from: literal, to: literal, values: [literal] })
    expect(await run(wire, 'bool', literal)).toBe(type !== 'NotInCondition')
  }
})
it('P2 canonicalizer rewrites literal LIKE patterns / value slots: typed literals and nested operand normalization execute', async () => {
  const pattern = 'FN(["lower","title"])%'
  const query = Q.select().from('notes').field('notes.id').where(Cond.like(Q.expr('FN(["lower","notes.title"])'), pattern)).limit(1)
  const wire = Cond.and([Cond.equal('title', Q.value(pattern)), Cond.exists(query)])!.serialize()
  expect(await run(wire, 'bool', pattern)).toBe(true)
})
