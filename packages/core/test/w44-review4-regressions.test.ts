import { toSQLWithBindings } from '@jakub.knejzlik/ts-query'
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
import { compileRoot, compileAggregate } from '../src/query/compiler'
import { ExpressionError, expressionInfo } from '../src/query/expressions'

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
