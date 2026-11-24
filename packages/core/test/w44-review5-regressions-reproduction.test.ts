import { expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { defineInstance, Q, Fn, Cond } from '../src/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { consoleUI } from '@workbasehq/plugins/console'
import { tenancy } from '../src/plugins'
import { setup, runtime, request } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeQuery } from '../src/query/executor'
import { validateQuery } from '../src/query/schema'
import { compileRoot, compileAggregate } from '../src/query/compiler'

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
function rebindConfig(mode:string,selection:string){
 const v:any=input();const field=mode==='stored'?'amount':'mid';
 if(mode==='computed')v.entities.notes.fields.mid={type:'int',computed:Fn.add('amount',Q.value(1)).serialize()};
 const sub=Q.select().from('notes','n').field(Fn.count('n.id'),field).orderBy(field,'ASC');
 v.entities.notes.fields.value.computed=Fn.if(Cond.exists(sub),field,Q.value(0)).serialize();
 v.plugins.push(consoleUI(),{name:'rebind-count',version:'1',requires:{console:'^1'},contributes:{console:{pages:[{
  id:'r5.count',path:'/r5-count',label:'Count',widgets:[{id:'count',kind:'stat',label:'Count',aggregate:{fn:'count'},
   query:{entity:'notes',...(selection==='selected'?{where:{value:{eq:mode==='stored'?3:4}}}:{})}}],
 }]}}});
 return defineInstance(v);
}

it.each(['stored','computed'].flatMap(mode=>['selected','unselected'].map(selection=>[mode,selection])))('R5 P2 regression: %s output alias preserves list values and counts (%s)',async(mode,selection)=>{
 const c=rebindConfig(mode,selection);const {app,run,kernel,scope}=await fixture(c);
 const input={entity:'notes',select:selection==='selected'?['id','value']:['id','title'],limit:10};
 const {query,cost}=validateQuery(kernel,scope,input);const st=compileRoot(kernel,scope,query,undefined,cost);
 const field=mode==='stored'?'amount':'mid';
 expect(st.sql).toContain(`AS \`${field}\``);
 expect(st.sql).toContain(`ORDER BY \`${field}\` ASC`);
 const expected=['n1','n2'].map(id=>selection==='selected'?{id,value:mode==='stored'?3:4}:{id,title:id});
 expect((await env.DB.prepare(st.sql).bind(...st.bindings).all()).results).toEqual(expected);
 expect((await run(input)).data).toEqual(expected);
 const ct=compileAggregate(kernel,scope,query,{fn:'count'},cost);
 expect(await env.DB.prepare(ct.sql).bind(...ct.bindings).first()).toMatchObject({value:2,__count:2});
 const response=await request(app,'/query','POST',input);
 expect(response.status).toBe(200);expect((await response.json() as any).data).toEqual(expected);
 const countResponse=await request(app,'/o/org-a/console-pages/r5.count');
 expect(countResponse.status).toBe(200);
 expect((await countResponse.json() as any).widgets).toEqual([{id:'count',kind:'stat',label:'Count',value:2}]);
});

it.each(['stored','computed'])('R5 P2 preserves a %s field name used as a table alias',async mode=>{
 const v:any=input();const alias=mode==='stored'?'amount':'mid';
 if(mode==='computed')v.entities.notes.fields.mid={type:'int',computed:Fn.add('amount',Q.value(1)).serialize()};
 const sub=Q.select().from('notes',alias).field(Fn.count(`${alias}.id`),alias).orderBy(alias,'ASC');
 v.entities.notes.fields.value.computed=Fn.if(Cond.exists(sub),alias,Q.value(0)).serialize();
 const {run}=await fixture(defineInstance(v));
 expect((await run({entity:'notes',select:['id','value'],limit:10})).data).toEqual(['n1','n2'].map(id=>({id,value:mode==='stored'?3:4})));
});

it('R5 P2 keeps output alias resolution lexical across sibling SELECTs',async()=>{
 const v:any=input();
 const first=Q.select().from('people','p').field(Fn.count('p.id'),'amount').orderBy('amount','ASC');
 const second=Q.select().from('notes','n').field(Fn.count('n.id'),'amount').orderBy('amount','ASC');
 v.entities.notes.fields.value.computed=Fn.if(Cond.and([Cond.exists(first),Cond.exists(second)]),'amount',Q.value(0)).serialize();
 const {kernel,scope,run}=await fixture(defineInstance(v));
 const {query,cost}=validateQuery(kernel,scope,{entity:'notes',select:['id','value'],limit:10});
 const st=compileRoot(kernel,scope,query,undefined,cost);
 expect(st.sql.match(/ORDER BY `amount` ASC/g)).toHaveLength(2);
 expect((await run(query)).data).toEqual(['n1','n2'].map(id=>({id,value:3})));
 const ct=compileAggregate(kernel,scope,query,{fn:'count'},cost);
 expect(await env.DB.prepare(ct.sql).bind(...ct.bindings).first()).toMatchObject({value:2,__count:2});
});

it('R5 P2 preserves local columns that share an outer ref operand spelling',async()=>{
 const v:any=input();
 v.entities.notes.fields.person={type:'ref',entity:'people'};
 v.entities.people.fields.amount={type:'int'};
 const sub=Q.select().from('people','person').field('person.id','amount')
  .where(Cond.greaterThan('person.amount',10)).orderBy('amount','ASC').limit(1);
 v.entities.notes.fields.value.computed=Fn.if(Cond.exists(sub),'person.amount',Q.value(0)).serialize();
 const {run}=await fixture(defineInstance(v));
 await env.DB.prepare("UPDATE people SET amount=CASE id WHEN 'p1' THEN 5 ELSE 20 END").run();
 await env.DB.prepare("UPDATE notes SET person=CASE id WHEN 'n1' THEN 'p1' ELSE 'p2' END").run();
 expect((await run({entity:'notes',select:['id','value'],limit:10})).data).toEqual([{id:'n1',value:5},{id:'n2',value:20}]);
});
