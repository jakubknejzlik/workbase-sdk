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
function rebindConfig(mode:string){
 const v:any=input();const field=mode==='stored'?'amount':'mid';
 if(mode==='computed')v.entities.notes.fields.mid={type:'int',computed:Fn.add('amount',Q.value(1)).serialize()};
 const sub=Q.select().from('notes','n').field(Fn.count('n.id'),field).orderBy(field,'ASC');
 v.entities.notes.fields.value.computed=Fn.if(Cond.exists(sub),field,Q.value(0)).serialize();
 return defineInstance(v);
}

it.each(['stored','computed'].flatMap(mode=>['selected','unselected'].map(selection=>[mode,selection])))('R5 required contract: %s output alias colliding with outer field executes (%s)',async(mode,selection)=>{
 const c=rebindConfig(mode);const {app}=await fixture(c);
 const response=await request(app,'/query','POST',{entity:'notes',select:selection==='selected'?['id','value']:['id','title'],limit:10});
 expect(response.status).toBe(200);expect((await response.json() as any).data).toHaveLength(2);
});
