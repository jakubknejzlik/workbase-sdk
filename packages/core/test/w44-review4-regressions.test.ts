import { toSQLWithBindings, type SelectQuery } from '@jakub.knejzlik/ts-query'
import { describe, expect, it } from 'vitest'
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
import { DisplayPartsExpression } from '../src/query/display-parts'
import { compileRoot, compileAggregate } from '../src/query/compiler'
import { ExpressionError, expressionInfo, rebindExpression, readableComputed } from '../src/query/expressions'

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


// R4 independent cardinality, clause and lexical-scope probes.
it.each(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'])('R4 outer-only %s in explicit SELECT must not collapse entity rows', async fn => {
 const v:any=input();
 v.entities.notes.fields.value.computed=Q.select().from('people','p').field(Q.expr(`FN(${JSON.stringify([fn,'self.amount'])})`)).where(Cond.columnEqual('p.note','self.id')).serialize();
 let c;
 try { c=defineInstance(v) } catch(e) { expect(e).toBeInstanceOf(ExpressionError); return }
 const {run,kernel,scope}=await fixture(c);
 const q={entity:'notes',select:['id','title'],orderBy:[{field:'id',dir:'asc'}],limit:10};
 const {query,cost}=validateQuery(kernel,scope,q);const st=compileRoot(kernel,scope,query,undefined,cost);
 const list=await run(q);const ct=compileAggregate(kernel,scope,query,{fn:'count'},cost);const count=await env.DB.prepare(ct.sql).bind(...ct.bindings).first<any>();
 console.log('R4 OUTER AGGREGATE',fn,JSON.stringify({list:list.data,count}),st.sql);
 expect(list.data).toHaveLength(2);expect(count?.value).toBe(2);
});
it('R4 aggregate outer dependency hidden through computed chain must preserve rows',async()=>{
 const v:any=input();v.entities.notes.fields.a={type:'int',computed:Fn.abs('amount').serialize()};v.entities.notes.fields.b={type:'int',computed:Fn.add('a',Q.value(1)).serialize()};
 v.entities.notes.fields.value.computed=Q.select().from('people','p').field(Fn.sum('self.b')).where(Cond.columnEqual('p.note','self.id')).serialize();
 let c;try{c=defineInstance(v)}catch(e){expect(e).toBeInstanceOf(ExpressionError);return}
 const {run}=await fixture(c);expect((await run({entity:'notes',select:['id','value'],limit:10})).data).toHaveLength(2);
});
it.each(['unqualified','qualified'])('R4 ORDER BY aggregate output alias %s',async mode=>{
 const v:any=input();let q=Q.select().from('people','p').field(Fn.count('p.id'),'total');
 q=q.orderBy(mode==='unqualified'?'total':'p.total','ASC');v.entities.notes.fields.value.computed=q.serialize();
 if(mode==='qualified'){expect(()=>defineInstance(v)).toThrow();return}
 const {run}=await fixture(defineInstance(v));expect((await run({entity:'notes',select:['value'],limit:10})).data).toEqual([{value:2},{value:2}]);
});
it.each(['WHERE','JOIN ON','ORDER BY'])('R4 local aggregate in scalar SELECT within %s is valid',async clause=>{
 const v:any=input();const sub=Q.select().from('people','sub').field(Fn.count('sub.id'));
 // Structured subquery operand via IN exercises a distinct SELECT context.
 let q=Q.select().from('notes','n').field('n.amount').limit(1);
 if(clause==='WHERE')q=q.where(Cond.in('n.amount',sub));
 if(clause==='JOIN ON')q=q.leftJoin(Q.table('people','p'),Cond.and([Cond.columnEqual('p.note','n.id'),Cond.in('n.amount',sub)])!);
 if(clause==='ORDER BY')q=q.orderBy(Cond.in('n.amount',sub),'ASC');
 v.entities.notes.fields.value.computed=q.serialize();const {run}=await fixture(defineInstance(v));
 const result=await run({entity:'notes',select:['value'],limit:1});expect(result.data[0].value).toBe(clause==='WHERE'?null:3);
});
it.each(['MIN','MAX'])('R4 three-arg scalar %s through computed dependency is valid',async fn=>{
 const v:any=input();v.entities.notes.fields.a={type:'int',computed:`FN(${JSON.stringify([fn,'amount',Q.value(4).serialize(),Q.value(5).serialize()])})`};
 v.entities.notes.fields.value.computed=Fn.add('a',Q.value(1)).serialize();const {run}=await fixture(defineInstance(v));
 expect((await run({entity:'notes',select:['value'],limit:10})).data).toEqual([{value:fn==='MIN'?4:6},{value:fn==='MIN'?4:6}]);
});
it.each(['LEFT','INNER'])('R4 nested correlated subquery cannot use later %s alias',join=>{
 const v:any=input();
 const sub=Q.select().from('people','sub').field('sub.id').where(Cond.columnEqual('sub.id','later.id')).limit(1);
 const on=Cond.and([Cond.columnEqual('current.id','p.id'),Cond.in('current.id',sub)])!;
 let q=Q.select().from('people','p');q=join==='LEFT'?q.leftJoin(Q.table('people','current'),on):q.innerJoin(Q.table('people','current'),on);
 v.entities.notes.fields.value.computed=q.innerJoin(Q.table('people','later'),Cond.columnEqual('later.id','p.id')).field(Fn.count('p.id')).serialize();
 invalid(v,/alias.*later/i);
});
it.each(['SUM','COUNT','MIN','MAX'])('R4 bare aggregate %s hidden behind four computed dependencies rejects',fn=>{
 const v:any=input();v.entities.notes.fields.value.computed=Fn.add('one',Q.value(1)).serialize();
 v.entities.notes.fields.one={type:'int',computed:Fn.abs('two').serialize()};v.entities.notes.fields.two={type:'int',computed:Fn.add('three',Q.value(2)).serialize()};
 v.entities.notes.fields.three={type:'int',computed:`FN(${JSON.stringify([fn,'amount'])})`};invalid(v,/aggregate/i);
});
it('R4 scalar COUNT dependency supports outer SUM without nesting SQL aggregates',async()=>{
 const v:any=input();v.entities.notes.fields.counted={type:'int',computed:Q.select().from('people','p').field(Fn.count('p.id')).where(Cond.columnEqual('p.note','self.id')).serialize()};
 v.entities.notes.fields.value.computed=Q.select().from('notes','n').field(Fn.sum('n.counted')).serialize();
 const {run}=await fixture(defineInstance(v));expect((await run({entity:'notes',select:['value'],limit:10})).data).toEqual([{value:2},{value:2}]);
});

it.each(['WHERE','JOIN ON','ORDER BY'])('R4 correlated aggregate cannot escape clause restriction via nested SELECT in %s',async clause=>{
 const v:any=input();
 const sub=Q.select().from('people','sub').field(Fn.sum('n.amount')).where(Cond.columnEqual('sub.note','n.id'));
 let q=Q.select().from('notes','n').field(clause==='ORDER BY'?'n.amount':Fn.count('n.id'));
 if(clause==='WHERE')q=q.where(Cond.in('n.amount',sub));
 if(clause==='JOIN ON')q=q.innerJoin(Q.table('people','p'),Cond.and([Cond.columnEqual('p.note','n.id'),Cond.in('n.amount',sub)])!);
 if(clause==='ORDER BY')q=q.orderBy(Cond.in('n.amount',sub),'ASC').limit(1);
 v.entities.notes.fields.value.computed=q.serialize();
 let c;try{c=defineInstance(v)}catch(e){expect(e).toBeInstanceOf(ExpressionError);return}
 const {run,kernel,scope}=await fixture(c);const query={entity:'notes',select:['value'],limit:10};
 const {query:validated,cost}=validateQuery(kernel,scope,query);const st=compileRoot(kernel,scope,validated,undefined,cost);
 try{const result=await run(query);console.log('R4 CORRELATED CLAUSE EXECUTED',clause,JSON.stringify(result.data));}catch(e){
 try { await env.DB.prepare(st.sql).bind(...st.bindings).all() } catch(raw) { console.log('R4 D1 CLAUSE ERROR',clause,String(raw)) }
 const response=await request((await setup(c)),'/query','POST',query);console.log('R4 HTTP CLAUSE',clause,response.status,JSON.stringify(await response.json()));
 console.log('R4 CORRELATED CLAUSE ERROR',clause,String(e),st.sql);
 throw e;
 }
});
it('R4 HTTP unselected correlated outer aggregate must preserve list size',async()=>{
 const v:any=input();v.entities.notes.fields.value.computed=Q.select().from('people','p').field(Fn.sum('self.amount')).where(Cond.columnEqual('p.note','self.id')).serialize();
 let c;try{c=defineInstance(v)}catch(e){expect(e).toBeInstanceOf(ExpressionError);return}
 const {app}=await fixture(c);const response=await request(app,'/query','POST',{entity:'notes',select:['id','title'],limit:10});const result:any=await response.json();
 console.log('R4 HTTP CARDINALITY',response.status,JSON.stringify(result));expect(response.status).toBe(200);expect(result.data).toHaveLength(2);
});

it.each(['LEFT','INNER'])('R4 two nested correlated SELECTs cannot hide forward alias in %s ON',join=>{
 const v:any=input();
 const deep=Q.select().from('people','deep').field('deep.id').where(Cond.columnEqual('deep.id','later.id')).limit(1);
 const middle=Q.select().from('people','middle').field('middle.id').where(Cond.exists(deep)).limit(1);
 let q=Q.select().from('people','p');q=join==='LEFT'?q.leftJoin(Q.table('people','current'),Cond.exists(middle)):q.innerJoin(Q.table('people','current'),Cond.exists(middle));
 v.entities.notes.fields.value.computed=q.innerJoin(Q.table('people','later'),Cond.columnEqual('later.id','p.id')).field(Fn.count('p.id')).serialize();invalid(v,/alias.*later/i);
});
it('R4 two nested SELECTs in ON execute with available aliases',async()=>{
 const v:any=input();
 const deep=Q.select().from('people','deep').field('deep.id').where(Cond.columnEqual('deep.id','current.id')).limit(1);
 const middle=Q.select().from('people','middle').field('middle.id').where(Cond.exists(deep)).limit(1);
 v.entities.notes.fields.value.computed=Q.select().from('people','p').leftJoin(Q.table('people','current'),Cond.exists(middle)).field(Fn.count('p.id')).where(Cond.columnEqual('current.id','p.id')).serialize();
 const {run}=await fixture(defineInstance(v));expect((await run({entity:'notes',select:['value'],limit:1})).data[0].value).toBe(2);
});

it.each(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'])('R4 outer-only %s reports actionable invalid_expression through scalar wrappers', fn => {
  const value: any = input()
  value.entities.notes.fields.value.computed = Q.select().from('people', 'p')
    .field(Q.expr(`FN(${JSON.stringify([fn, Fn.abs('self.amount').serialize()])})`))
    .where(Cond.columnEqual('p.note', 'self.id')).serialize()
  invalid(value, /aggregate.*outer/i)
})

it.each(['1', '*'])('R4 COUNT(%s) stays local and preserves entity rows', async operand => {
  const value = input()
  value.entities.notes.fields.value.computed = Q.select().from('people', 'p')
    .field(Fn.count(operand === '*' ? '*' : Q.value(1)))
    .where(Cond.columnEqual('p.note', 'self.id')).serialize()
  const { run } = await fixture(defineInstance(value))
  expect((await run({ entity: 'notes', select: ['id', 'value'], orderBy: [{ field: 'id', dir: 'asc' }], limit: 10 })).data)
    .toEqual([{ id: 'n1', value: 2 }, { id: 'n2', value: 0 }])
})

it.each(['1', '*'])('R4 uncorrelated COUNT(%s) counts scoped schema rows without a column operand', async operand => {
  const value = input()
  value.entities.notes.fields.value.computed = Q.select().from('people', 'p')
    .field(Fn.count(operand === '*' ? '*' : Q.value(1))).serialize()
  const { run } = await fixture(defineInstance(value))
  expect((await run({ entity: 'notes', select: ['value'], limit: 10 })).data).toEqual([{ value: 2 }, { value: 2 }])
})

it('R4 mixed local and outer aggregate operands belong to the local SELECT', async () => {
  const value = input()
  value.entities.notes.fields.value.computed = Q.select().from('notes', 'n')
    .field(Fn.sum(Fn.add('n.amount', 'self.amount'))).serialize()
  const { run } = await fixture(defineInstance(value))
  expect((await run({ entity: 'notes', select: ['value'], limit: 10 })).data).toEqual([{ value: 12 }, { value: 12 }])
})

it.each(['n.amount', 'self.amount'])('R4 aggregate ownership follows %s through a scalar SELECT operand', async column => {
  const value = input()
  const operand = Q.select().from('people', 'p').field('p.id')
    .where(Cond.columnEqual('p.note', 'self.id')).where(Cond.greaterThan(column, 0)).limit(1)
  value.entities.notes.fields.value.computed = Q.select().from('notes', 'n')
    .field(Fn.count(Cond.exists(operand))).serialize()
  if (column === 'self.amount') { invalid(value, /aggregate.*outer/i); return }
  const { run } = await fixture(defineInstance(value))
  expect((await run({ entity: 'notes', select: ['value'], orderBy: [{ field: 'id', dir: 'asc' }], limit: 10 })).data)
    .toEqual([{ value: 2 }, { value: 2 }])
})

it.each(['n.amount', Fn.abs(Fn.sum('n.amount')).serialize()])('R4 ORDER BY resolves scalar and wrapped aggregate output aliases: %s', async projection => {
  const value = input()
  value.entities.notes.fields.value.computed = Q.select().from('notes', 'n')
    .field(Q.expr(projection), 'total').orderBy('total', 'DESC').limit(1).serialize()
  const { run } = await fixture(defineInstance(value))
  const expected = projection === 'n.amount' ? 3 : 6
  expect((await run({ entity: 'notes', select: ['value'], limit: 10 })).data).toEqual([{ value: expected }, { value: expected }])
})


// The approved grammar v2 acceptance matrix. Keep NULL and all keyword/value
// spellings together: SQL keyword lists do not determine operand roles.
describe('ORDER BY grammar v2 acceptance matrix', () => {
  const keywords = ['order', 'select', 'key']
  const valueWords = ['TRUE', 'FALSE', 'CURRENT_TIME', 'CURRENT_DATE', 'CURRENT_TIMESTAMP']
  const query = (alias: string, operand: string) => Q.select().from('notes', 'n')
    .field('n.amount', alias).orderBy(Q.expr(operand), 'ASC').limit(1)
  const configFor = (wire: string) => {
    const value = input()
    value.entities.notes.fields.value.computed = wire
    return defineInstance(value)
  }
  const infoFor = (wire: string) => expressionInfo(configFor(wire), 'notes', 'value', wire)
  const sql = (ast: Parameters<typeof toSQLWithBindings>[0]) => toSQLWithBindings(ast, Q.flavors.sqlite)
  async function amounts(config: ReturnType<typeof defineInstance>) {
    const result = await fixture(config)
    await env.DB.prepare("UPDATE notes SET amount=-5 WHERE id='n2'").run()
    return result
  }
  async function assertOrder(alias: string, operand: string, literal = false) {
    const original = query(alias, operand)
    const wire = original.serialize()
    const config = configFor(wire) // unchanged serialized builder configuration
    expect(config.entities.notes.fields.value.computed).toBe(wire)
    const info = expressionInfo(config, 'notes', 'value', wire)
    const statement = sql(info.ast)
    expect(statement.sql).toContain(`ORDER BY ${literal ? 'NULL' : `\`${alias}\``} ASC`)
    expect(statement.bindings).toEqual([1])
    expect(sql(rebindExpression(original, new Map([[alias, 'outer.amount']])))).toEqual(statement)
    expect(original.serialize()).toBe(wire)
    expect(await env.DB.prepare(statement.sql).bind(...statement.bindings).first())
      .toEqual({ [alias]: literal ? 3 : -5 })
  }

  it.each(['null', 'Null'])('A1 exact NULL stays literal beside declaration %s through both caller paths', async alias => {
    const wire = query(alias, 'NULL').serialize()
    expect(Q.select().from('notes', 'n').field('n.amount', alias).orderBy('NULL', 'ASC').limit(1).serialize()).toBe(wire)
    const { run } = await amounts(configFor(wire))
    await assertOrder(alias, 'NULL', true)
    expect((await run({ entity: 'notes', select: ['value'], limit: 10 })).data).toEqual([{ value: 3 }, { value: 3 }])
  })

  it.each(['null', 'Null'])('A2 non-sentinel and wrapped NULL resolve declaration %s', async alias => {
    await amounts(configFor(query(alias, alias).serialize()))
    for (const operand of ['null', 'Null', '#null#', '#NULL#']) await assertOrder(alias, operand)
  })

  it.each(keywords)('A3 unchanged keyword alias config %s remains accepted', async alias => {
    await amounts(configFor(query(alias, alias).serialize()))
    await assertOrder(alias, alias)
  })
  it.each(valueWords)('A4 unchanged uppercase alias config %s remains accepted', async alias => {
    await amounts(configFor(query(alias, alias).serialize()))
    await assertOrder(alias, alias)
  })

  const crossProduct = [...keywords, ...valueWords, 'NULL'].flatMap(word => {
    const lower = word.toLowerCase(), title = lower[0].toUpperCase() + lower.slice(1), upper = word.toUpperCase()
    return [lower, title, upper].map(alias => ({ alias, operands: [lower, title, upper, `#${lower}#`, `#${upper}#`] }))
  })
  it.each(crossProduct)('A5 spelling cross-product declaration $alias (five operands)', async ({ alias, operands }) => {
    if (alias === 'NULL') {
      for (const operand of operands) expect(() => configFor(query(alias, operand).serialize())).toThrow(/unsupported.*alias.*NULL/i)
      return
    }
    await amounts(configFor(query(alias, alias).serialize()))
    for (const operand of operands) await assertOrder(alias, operand, operand === 'NULL')
  })

  it('A6 variants have equivalent canonical AST, SQL, bindings, type, dependencies and display parts', () => {
    const baseline = infoFor(query('Total', 'Total').serialize())
    for (const operand of ['total', '#total#', 'TOTAL', '#ToTaL#']) {
      const raw = query('Total', operand), wire = raw.serialize(), info = infoFor(wire)
      expect((info.ast as SelectQuery).serialize()).toBe((baseline.ast as SelectQuery).serialize())
      expect((info.ast as SelectQuery).serialize()).toContain('#Total#')
      expect(sql(info.ast)).toEqual(sql(baseline.ast))
      expect(info.type).toBe(baseline.type)
      expect(info.dependencies).toEqual(baseline.dependencies)
      expect(info.parts).toEqual(baseline.parts)
      const columns = new Map([['total', 'outer.amount'], ['Total', 'outer.amount']])
      const source = (entity: string) => Q.select().from(entity).field('amount')
      const render = (parts: NonNullable<typeof info.parts>) => sql(new DisplayPartsExpression(parts, columns, new Map(), source))
      expect(render({ wire, type: 'number' })).toEqual(render(baseline.parts!))
      expect(sql(rebindExpression(raw, columns))).toEqual(sql(info.ast))
      expect(raw.serialize()).toBe(wire)
    }
  })

  it('A7 unmatched uppercase words reject while typed values and condition data retain their roles', async () => {
    for (const word of valueWords) expect(() => infoFor(query('Total', word).serialize())).toThrow(/Unknown field/)
    const data = ['Total', '#Total#', 'NULL', 'FN(["ABS","Total"])']
    const original = query('Total', 'Total').where(Cond.in('n.title', data))
      .orderBy(Q.value(true)).orderBy(Q.value(false)).orderBy(Q.value('Total')).orderBy(Q.value(null as any))
      .orderBy(Q.expr('&Total&')).orderBy(Q.expr('+2.5'))
    const info = infoFor(original.serialize()), statement = sql(info.ast)
    expect(statement.bindings).toEqual([...data, true, false, 'Total', null, 'Total', 2.5, 1])
    expect(statement.sql).toContain('ORDER BY `Total` ASC, ? ASC, ? ASC, ? ASC, ? ASC, ? ASC, ? ASC')
    expect(JSON.parse((info.ast as SelectQuery).serialize()).where[0].values).toEqual(data.map(value => Q.value(value).serialize()))
  })

  it('A7 number wires are scalar literals rather than positional ORDER BY ordinals', async () => {
    await amounts(configFor(query('Total', '1').serialize()))
    for (const operand of ['1', '-5', '+2.5', '0.25']) {
      const raw = Q.select().from('notes', 'n').field(Fn.abs('n.amount'), 'Total').orderBy(Q.expr(operand)).limit(1)
      const statement = sql(infoFor(raw.serialize()).ast)
      expect(statement.sql).toContain('ORDER BY ? ASC')
      expect(statement.bindings).toEqual([Number(operand), 1])
      expect(sql(rebindExpression(raw, new Map()))).toEqual(statement)
      expect(await env.DB.prepare(statement.sql).bind(...statement.bindings).first()).toEqual({ Total: 3 })
    }
  })

  it('A8 qualified references retain source semantics and malformed operands/declarations reject whole', async () => {
    await amounts(configFor(query('Total', 'n.amount').serialize()))
    for (const operand of ['n.amount', '#n.amount#']) {
      const statement = sql(infoFor(query('Total', operand).serialize()).ast)
      expect(statement.sql).toContain('ORDER BY `n`.`amount` ASC')
      expect(await env.DB.prepare(statement.sql).bind(...statement.bindings).first()).toEqual({ Total: -5 })
    }
    for (const operand of ['n.Total', '#n.Total#', 'missing', '#NULL#', 'Total\n', '#Total#\n', ' Total', 'Total ', 'Total+1', '##Total##', '"Total"', "'Total'", 'ToTaK', 'ſelect']) {
      expect(() => infoFor(query('Total', operand).serialize()), operand).toThrow(ExpressionError)
    }
    for (const alias of ['#Total#', 'Total\n', 'Total ', 'Total;DROP_TABLE', 'ſelect', '1Total']) {
      expect(() => infoFor(query(alias, 'n.amount').serialize()), alias).toThrow(/alias/i)
    }
  })

  it('A9 aliases inside FN, OP and raw SQL reject; qualified source functions remain supported', () => {
    for (const operand of [Fn.abs('Total').serialize(), Fn.add('Total', Q.value(1)).serialize(), Q.raw('Total').serialize()]) {
      expect(() => infoFor(query('Total', operand).serialize())).toThrow(ExpressionError)
    }
    expect(sql(infoFor(query('Total', Fn.abs('n.amount').serialize()).serialize()).ast).sql).toContain('ORDER BY ABS(`n`.`amount`) ASC')
  })

  it.each(['nested', 'sibling'])('A10 output alias visibility does not leak to a %s SELECT', mode => {
    const first = Q.select().from('notes', 'n').field(Fn.count('n.id'), 'Total').orderBy('#TOTAL#')
    const second = Q.select().from('people', 'p').field(Fn.count('p.id'), 'Other').orderBy('#total#')
    const wire = mode === 'nested' ? first.where(Cond.exists(second)).serialize()
      : Fn.if(Cond.and([Cond.exists(first), Cond.exists(second)])!, 'amount', Q.value(0)).serialize()
    expect(() => infoFor(wire)).toThrow(/needs a schema table alias/)
  })
  it('A10 shared operand resolves separately per SELECT and per clause without mutation', () => {
    const shared = Q.expr('total')
    const first = Q.select().from('notes', 'n').field('n.amount', 'Total').orderBy(shared).limit(1)
    const second = Q.select().from('notes', 'n').field('n.amount', 'TOTAL').orderBy(shared).limit(1)
    const nested = first.where(Cond.exists(second))
    const siblings = Fn.add(first, second)
    for (const raw of [nested, siblings]) {
      const before = raw.serialize()
      const rebound = rebindExpression(raw, new Map([['total', 'outer.amount']]))
      expect(sql(rebound).sql).toContain('ORDER BY `Total` ASC')
      expect(sql(rebound).sql).toContain('ORDER BY `TOTAL` ASC')
      expect(raw.serialize()).toBe(before)
    }
    const otherClause = first.where(Cond.isNull(shared))
    const wire = otherClause.serialize()
    const rebound = JSON.parse(rebindExpression(otherClause, new Map()).serialize())
    expect(rebound.orderBy[0].field).toBe('#Total#')
    expect(rebound.where[0].key).toBe('total')
    expect(() => infoFor(wire)).toThrow(/needs a schema table alias/)
    expect(otherClause.serialize()).toBe(wire)
    expect(shared.serialize()).toBe('total')
  })

  it('A12 alias resolution retains scalar LIMIT, aggregate ownership, clause and forward-join restrictions', () => {
    const wires = [
      query('Total', '#total#').clearLimit().serialize(),
      Q.select().from('notes', 'n').field(Fn.sum('self.amount'), 'Total').orderBy('#TOTAL#').serialize(),
      query('Total', Fn.sum('n.amount').serialize()).serialize(),
      query('Total', '#TOTAL#').where(Cond.greaterThan(Fn.sum('n.amount'), 0)).serialize(),
      query('Total', '#TOTAL#').innerJoin(Q.table('people', 'p'), Cond.columnEqual('later.id', 'n.id'))
        .innerJoin(Q.table('people', 'later'), Cond.columnEqual('later.note', 'n.id')).serialize(),
    ]
    for (const wire of wires) expect(() => infoFor(wire)).toThrow(ExpressionError)
  })

  it('A13 masked projection dependencies stay unreadable, NULL and unfilterable; source scoping persists', async () => {
    const config = configFor(query('Total', '#TOTAL#').serialize())
    const { kernel, scope, run } = await amounts(config)
    await env.DB.prepare("INSERT INTO notes(id,organization_id,title,amount,created_at,updated_at) VALUES ('foreign','org-b','foreign',-99,'2026-01-01','2026-01-01')").run()
    expect((await run({ entity: 'notes', select: ['value'], limit: 10 })).data).toEqual([{ value: -5 }, { value: -5 }])
    const masked = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'mask_amount', version: '1',
      fieldMask: entity => kernel.fieldMask(entity, scope).filter(field => entity !== 'notes' || field !== 'amount') }] })
    expect(readableComputed(masked, scope, 'notes', 'value')).toBe(false)
    expect((await run({ entity: 'notes', select: ['value'], limit: 10 }, masked)).data).toEqual([{ value: null }, { value: null }])
    const { query: validated, cost } = validateQuery(masked, scope, { entity: 'notes', select: ['value'], where: { value: { eq: -5 } }, limit: 10 })
    const count = compileAggregate(masked, scope, validated, { fn: 'count' }, cost)
    expect(await env.DB.prepare(count.sql).bind(...count.bindings).first()).toMatchObject({ value: 0, __count: 0 })
    const restricted = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'scope_amount', version: '1',
      tableFilter: entity => entity === 'notes' ? { kind: 'where', predicate: { amount: { eq: 3 } } } : { kind: 'all' } }] })
    expect((await run({ entity: 'notes', select: ['value'], limit: 10 }, restricted)).data).toEqual([{ value: 3 }])
  })

  it.each(['Total', 'TOTAL'])('A14 duplicate/case-fold projection alias %s rejects before choosing a winner', alias => {
    expect(() => infoFor(query('Total', '#total#').field('n.amount', alias).serialize())).toThrow(/exactly one field/)
  })

  it('A15 cache reuse/isolation and both emission routes preserve original wire/AST and canonical idempotence', () => {
    const original = query('Total', '#tOtAl#'), wire = original.serialize(), config = configFor(wire)
    const info = expressionInfo(config, 'notes', 'value', wire), astWire = (info.ast as SelectQuery).serialize(), parts = JSON.stringify(info.parts)
    const second = configFor(wire)
    expect(expressionInfo(second, 'notes', 'value', wire)).not.toBe(info)
    expect(expressionInfo(config, 'notes', 'amount', wire)).not.toBe(info)
    expect(expressionInfo(config, 'notes', 'value', query('Total', 'total').serialize())).not.toBe(info)
    expect((expressionInfo(config, 'notes', 'value', astWire).ast as SelectQuery).serialize()).toBe(astWire)
    const columns = new Map([['Total', Fn.abs(Q.value(99))]])
    for (let i = 0; i < 3; i++) {
      expect(expressionInfo(config, 'notes', 'value', wire)).toBe(info)
      expect(sql(rebindExpression(info.ast, columns)).sql).toContain('ORDER BY `Total` ASC')
      expect(sql(new DisplayPartsExpression({ wire, type: 'number' }, columns, new Map(), entity => Q.select().from(entity).field('amount'))).sql).toContain('ORDER BY `Total` ASC')
    }
    expect(original.serialize()).toBe(wire)
    expect((info.ast as SelectQuery).serialize()).toBe(astWire)
    expect(JSON.stringify(info.parts)).toBe(parts)
    expect(config.entities.notes.fields.value.computed).toBe(wire)
  })

  it('A16 exact uppercase NULL declaration fails validation before emission', () => {
    for (const operand of ['NULL', 'null', '#NULL#', 'n.amount']) {
      expect(() => configFor(query('NULL', operand).serialize())).toThrow(/unsupported.*alias.*NULL/i)
    }
  })
})
