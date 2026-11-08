import { initialSchema } from '../src/migrations/schema'
import { checkInstanceSchema } from '../src/kernel/schema-check'
import { queryClient } from '../../mcp/test/data/query-client'
import { resolveActor, requireScope } from '../src/authorization'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { tenancy } from '../src/plugins'
import { expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { Q, Fn, Cond, defineInstance, bodyValidator, serializableInstanceConfig } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { executeQuery } from '../src/query/executor'
import { setup, request, runtime } from '@workbasehq/test-support/helpers'
import type { Scope } from '../src/types'

const composite = () => Fn.concat(Fn.strftime('%d. %m. %Y %H:%M', 'termin'), Q.value(' · '), 'customer', Q.value(' · '), 'service').serialize()
const input = (): Parameters<typeof defineInstance>[0] => ({ id: 'computed_test', revision: 1, roles: ['owner'], interactive: true, plugins: [identity, localAuth, tenancy, rbac], locale: 'cs' as const,
  permissions: { owner: { bookings: ['read', 'create', 'update'], people: ['read'], services: ['read'] } },
  policies: { bookings: { owner: 'all' }, people: { owner: 'all' }, services: { owner: 'all' } },
  entities: {
    people: { displayField: 'name', fields: { name: { type: 'string' as const } } },
    services: { displayField: 'name', fields: { name: { type: 'string' as const } } },
    bookings: { displayField: composite(), fields: { title: { type: 'string' as const }, termin: { type: 'datetime' as const }, customer: { type: 'ref' as const, entity: 'people' }, service: { type: 'ref' as const, entity: 'services' }, amount: { type: 'int' as const }, doubled: { type: 'int' as const, computed: Fn.multiply('amount', Q.value(2)).serialize() } } },
  } })
let scope: Scope = { organizationId: 'org-a', actor: { type: 'user', id: 'owner-a' }, role: 'owner', correlationId: 'computed-test' }
const run = (config: ReturnType<typeof defineInstance>, query: unknown, kernel = new KernelRegistry(config)) => executeQuery(kernel, scope, env.DB, 'synthetic', query, { writeLog: () => {} })

it('W44 raw SQL, unknown node, cycle, no dependency, type mismatch and date-only display are rejected with fixes', () => {
  const invalid = (expression: string, field = 'displayField') => { const value: any = input(); if (field === 'displayField') value.entities.bookings.displayField = expression; else value.entities.bookings.fields.doubled.computed = expression; return () => defineInstance(value) }
  expect(invalid(Q.raw('sqlite_version()').serialize())).toThrow(/raw|structured/i)
  expect(invalid('{"type":"Surprise"}')).toThrow(/node|SELECT/i)
  expect(invalid(Fn.concat('missing', Q.value('!')).serialize())).toThrow(/Unknown.*field/i)
  expect(invalid(Fn.add('doubled', Q.value(1)).serialize(), 'computed')).toThrow(/cycl/i)
  expect(invalid(Q.value('Constant').serialize())).toThrow(/field/i)
  expect(invalid(Fn.concat('title', Q.value('!')).serialize(), 'computed')).toThrow(/type/i)
  expect(invalid('termin')).not.toThrow() // Old field-name shorthand remains valid.
  expect(invalid(Q.expr('termin').serialize().replace('termin', '#termin#'))).toThrow(/date|text/i)
})

it('W44 computed fields have no DDL and reject writes in create/update schemas', () => {
  const config = defineInstance(input())
  expect(bodyValidator(config.entities.bookings).safeParse({ doubled: 99 }).success).toBe(false)
  expect(bodyValidator(config.entities.bookings, true).safeParse({ doubled: 99 }).success).toBe(false)
  expect(initialSchema(config)).not.toMatch(/\"(?:doubled|computed_display)\"/)
  const wire = serializableInstanceConfig(config)
  expect(defineInstance({ ...JSON.parse(JSON.stringify(wire)), plugins: config.plugins }).entities.bookings.displayField).toBe(config.entities.bookings.displayField)
})

it('W44 cross-org subquery cannot leak rows and masked dependencies become NULL', async () => {
  const value: any = input()
  value.entities.bookings.fields.other_name = { type: 'string', computed: Q.select().from('people', 'p').field('p.name').orderBy('p.name', 'DESC').limit(1).serialize() }
  value.entities.bookings.fields.foreign_match = { type: 'bool', computed: Cond.exists(Q.select().from('people', 'p').field('p.id').where(Cond.equal('p.name', 'ZZZ ORG B CANARY')).limit(1)).serialize() }
  value.entities.people.fields.booking_count = { type: 'int', computed: Q.select().from('bookings', 'b').field(Fn.count('b.id')).where(Cond.columnEqual('b.customer', 'self.id')).serialize() }
  const config = defineInstance(value)
  await setup(config)
  const bound = new KernelRegistry(config).config
  scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), bound), 'org-a', bound)
  const now = '2026-11-11T15:26:00Z'
  await env.DB.batch([
    env.DB.prepare('INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?),(?,?,?,?,?)').bind('pa','org-a','John Doe',now,now,'pb','org-b','ZZZ ORG B CANARY',now,now),
    env.DB.prepare('INSERT INTO services(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('sa','org-a','Umývání oken',now,now),
    env.DB.prepare('INSERT INTO bookings(id,organization_id,title,termin,customer,service,amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind('booking-a','org-a','Booking',now,'pa','sa',3,now,now),
  ])
  const result = await run(config, { entity: 'bookings', limit: 10 })
  expect(result.data[0].other_name).toBe('John Doe')
  expect(result.data[0].doubled).toBe(6)
  expect(result.data[0].foreign_match).toBe(false)
  expect((await run(config, { entity: 'people', select: ['booking_count'], limit: 10 })).data[0].booking_count).toBe(1)
  expect(result.data[0][config.entities.bookings.displayField!]).toBe('11. 11. 2026 15:26 · John Doe · Umývání oken')
  const masked = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'mask_operand', version: '1', fieldMask: entity => new KernelRegistry(config).fieldMask(entity, scope).filter(field => entity !== 'people' || field !== 'name') }] })
  const hidden = await run(config, { entity: 'bookings', limit: 10 }, masked)
  expect(hidden.data[0].other_name).toBeNull()
  expect(hidden.data[0][config.entities.bookings.displayField!]).toBeNull()
  const rowPolicy = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'people_policy', version: '1', tableFilter: entity => entity === 'people' ? { kind: 'where', predicate: { name: { eq: 'Not this row' } } } : { kind: 'all' } }] })
  const denied = await run(config, { entity: 'bookings', limit: 10 }, rowPolicy)
  expect(denied.data[0].other_name).toBeNull()
  expect(denied.data[0][config.entities.bookings.displayField!]).toBeNull()
  await checkInstanceSchema(env.DB, config, {})

})

it('W44 SQL sorts, pages and picker-searches the composite display, API and MCP reject computed writes', async () => {
  const config = defineInstance(input()); const app = await setup(config)
  const bound = new KernelRegistry(config).config
  scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), bound), 'org-a', bound)
  const now = '2026-11-11T15:26:00Z'
  await env.DB.prepare('INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('pa','org-a','John Doe',now,now).run()
  await env.DB.prepare('INSERT INTO services(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('sa','org-a','Umývání oken',now,now).run()
  for (const id of ['a','b']) await env.DB.prepare('INSERT INTO bookings(id,organization_id,title,termin,customer,service,amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,'org-a','Booking',now,'pa','sa',3,now,now).run()
  const field = config.entities.bookings.displayField!
  const query = { entity: 'bookings', search: { fields: [field], text: 'John Doe · Umývání' }, orderBy: [{ field, dir: 'asc' }], limit: 1 }
  const first = await run(config, query); expect(first.data[0].id).toBe('a'); expect(first.next_cursor).toBeTruthy()
  expect((await run(config, { ...query, cursor: first.next_cursor })).data[0].id).toBe('b')
  expect((await request(app, '/api/bookings', 'POST', { doubled: 123 })).status).toBe(400)
  expect((await request(app, '/api/bookings', 'POST', { title: 'Writable fields', amount: 2 })).status).toBe(201)
  expect((await request(app, '/api/bookings/a', 'PATCH', { version: 1, doubled: 123 })).status).toBe(400)
  const { client, close } = await queryClient(((url: string, init: RequestInit) => { const { redirect: _redirect, ...local } = init; return app.request(url, local) }) as typeof fetch, 'synthetic-owner-a')
  try {
    for (const [name, args] of [['create_record', { entity: 'bookings', data: { doubled: 99 } }], ['update_record', { entity: 'bookings', id: 'a', version: 1, data: { doubled: 99 } }]] as const) {
      expect((await client.callTool({ name, arguments: args })).structuredContent).toMatchObject({ ok: false, status: 400 })
    }
  } finally { await close() }

})
it('W44 validation rejects physical entities, unknown functions, mutual computed cycles and transitive two-hop display refs', () => {
  for (const source of ['sqlite_master', 'organizations', 'missing']) {
    const value: any = input(); value.entities.bookings.fields.doubled.computed = Q.select().from(source, 'p').field(Fn.count('p.id')).serialize()
    expect(() => defineInstance(value)).toThrow(/Unknown schema entity/)
  }
  const wire: any = input(); wire.entities.bookings.fields.doubled.computed = 'FN(["LOAD_EXTENSION","amount"])'
  expect(() => defineInstance(wire)).toThrow(/unsafe function/)
  wire.entities.bookings.fields.doubled.computed = Fn.add('constructor', Q.value(1)).serialize()
  expect(() => defineInstance(wire)).toThrow(/Unknown schema field/)
  wire.entities.bookings.fields.doubled.computed = Fn.add('other', Q.value(1)).serialize()
  wire.entities.bookings.fields.other = { type: 'int', computed: Fn.add('doubled', Q.value(1)).serialize() }
  expect(() => defineInstance(wire)).toThrow(/cycle/)
  const hops: any = input()
  hops.entities.people.fields.manager = { type: 'ref', entity: 'services' }
  hops.entities.people.fields.caption = { type: 'string', computed: Fn.concat('manager.name', Q.value('!')).serialize() }
  hops.entities.bookings.displayField = Fn.concat('customer.caption', Q.value('!')).serialize()
  expect(() => defineInstance(hops)).toThrow(/at most one hop/)
})
