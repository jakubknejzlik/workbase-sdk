import { initialSchema } from '../src/migrations/schema'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { tenancy } from '../src/plugins'
import { resolveActor, requireScope } from '../src/authorization'
import { expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { defineInstance, Fn, Q } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { executeQuery } from '../src/query/executor'
import { setup, runtime } from '@workbasehq/test-support/helpers'
it('W44 one ref source computes every operand requested through that path', async () => {
  const config = defineInstance({ id: 'composition', interactive: true, plugins: [identity, localAuth, tenancy, rbac], revision: 1, roles: ['owner'], policies: { people: { owner: 'all' }, notes: { owner: 'all' } }, permissions: { owner: { people: ['read'], notes: ['read'] } }, entities: {
    people: { displayField: 'first', fields: { first: { type: 'string' }, last: { type: 'string' }, first_label: { type: 'string', computed: 'FN(["UPPER","first"])' }, last_label: { type: 'string', computed: Fn.concat('last', Q.value('!')).serialize() } } },
    notes: { displayField: Fn.concat('person.first_label', Q.value(' '), 'person.last_label', Q.value(' #'), 'number').serialize(), fields: { quantity: { type: 'int' }, number: { type: 'int', computed: Fn.add('quantity', Q.value(1)).serialize() }, person: { type: 'ref', entity: 'people' } } },
  } })
  await setup(config)
  const now = '2026-11-11T15:26:00Z'
  await env.DB.prepare('INSERT INTO people(id,organization_id,first,last,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('p','org-a','John','Doe',now,now).run()
  await env.DB.prepare('INSERT INTO notes(id,organization_id,person,quantity,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('n','org-a','p',3,now,now).run()
  const kernel = new KernelRegistry(config)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const result = await executeQuery(kernel, scope, env.DB, 'synthetic', { entity: 'notes', limit: 10 }, { writeLog: () => {} })
  expect(result.data[0].computed_display).toBe('JOHN Doe! #4.0')
})

it('computed refs preserve availability from computed dependencies on a joined row', async () => {
  const config = defineInstance({ id: 'joined_refs', revision: 1, interactive: true, plugins: [identity, localAuth, tenancy, rbac], roles: ['viewer'],
    permissions: { viewer: { people: ['read'], notes: ['read'] } }, policies: { people: { viewer: 'all' }, notes: { viewer: 'all' } }, entities: {
      people: { displayField: 'name', fields: { name: { type: 'string' }, person_key: { type: 'string' }, person: { type: 'ref', entity: 'people', computed: Q.expr('person_key').serialize() } } },
      notes: { displayField: 'title', fields: { title: { type: 'string' }, holder: { type: 'ref', entity: 'people' }, alias: { type: 'ref', entity: 'people', computed: Q.expr('holder.person').serialize() } } },
    } })
  await setup(config)
  await env.DB.exec("INSERT INTO people(id,organization_id,name,person_key,created_at,updated_at) VALUES ('holder','org-a','Holder','hidden',datetime('now'),datetime('now')),('hidden','org-a','Secret',NULL,datetime('now'),datetime('now'))")
  await env.DB.exec("INSERT INTO notes(id,organization_id,title,holder,created_at,updated_at) VALUES ('n','org-a','Note','holder',datetime('now'),datetime('now'))")
  const kernel = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'restricted', version: '1', tableFilter: entity => entity === 'people' ? { kind: 'where', predicate: { name: { ne: 'Secret' } } } : { kind: 'all' } }] })
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-viewer-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const load = () => executeQuery(kernel, scope, env.DB, 'synthetic', { entity: 'notes', select: ['id', 'alias'], labels: ['alias'], limit: 10 }, { writeLog: () => {} })
  const forbidden = await load()
  expect(forbidden.data[0]).toEqual({ id: 'n', alias: null, __labels: { alias: { status: 'unavailable' } } })
  await env.DB.exec("DELETE FROM people WHERE id='hidden'")
  expect(await load()).toEqual(forbidden)
  await env.DB.exec("UPDATE people SET person_key=NULL WHERE id='holder'")
  expect((await load()).data[0]).toEqual({ id: 'n', alias: null, __labels: { alias: { status: 'empty' } } })
  await env.DB.exec("UPDATE people SET person_key='holder' WHERE id='holder'")
  expect((await load()).data[0]).toMatchObject({ alias: 'holder', __labels: { alias: { status: 'ok' } } })
})
it('W44 computed refs have no DDL, mask denied target IDs and resolve display paths', async () => {
  const ref = Q.expr('person_key').serialize()
  const config = defineInstance({ id: 'computed_ref', revision: 1, interactive: true, plugins: [identity, localAuth, tenancy, rbac], roles: ['owner'],
    permissions: { owner: { people: ['read'], notes: ['read'] } }, policies: { people: { owner: 'all' }, notes: { owner: 'all' } }, entities: {
      people: { displayField: 'name', fields: { name: { type: 'string' } } },
      notes: { displayField: Fn.concat('person.name', Q.value('!')).serialize(), fields: { title: { type: 'string' }, person_key: { type: 'string' }, person: { type: 'ref', entity: 'people', computed: ref } } },
    } })
  expect(initialSchema(config)).not.toMatch(/"person"|notes_person_idx/)
  await setup(config)
  const now = '2026-11-11T15:26:00Z'
  await env.DB.prepare('INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('p','org-a','John Doe',now,now).run()
  await env.DB.prepare('INSERT INTO notes(id,organization_id,title,person_key,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('n','org-a','Note','p',now,now).run()
  const kernel = new KernelRegistry(config)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const query = { entity: 'notes', where: { person: { eq: 'p' } }, limit: 10 }
  const run = (current = kernel, input: unknown = query) => executeQuery(current, scope, env.DB, 'synthetic', input, { writeLog: () => {} })
  expect((await run()).data[0]).toMatchObject({ person: 'p', computed_display: 'John Doe!' })
  const masked = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'deny_target', version: '1', tableFilter: entity => ({ kind: entity === 'people' ? 'none' : 'all' }) }] })
  expect((await run(masked, { entity: 'notes', limit: 10 })).data[0]).toMatchObject({ person: null, computed_display: null })
  const rowDenied = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'row_target', version: '1', tableFilter: entity => entity === 'people' ? { kind: 'where', predicate: { name: { eq: 'Outside policy' } } } : { kind: 'all' } }] })
  expect((await run(rowDenied, { entity: 'notes', limit: 10 })).data[0]).toMatchObject({ person: null, computed_display: null })
  await env.DB.prepare('INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('pb','org-b','Other org',now,now).run()
  await env.DB.prepare('UPDATE notes SET person_key=? WHERE id=?').bind('pb','n').run()
  expect((await run(kernel, { entity: 'notes', limit: 10 })).data[0]).toMatchObject({ person: null, computed_display: null })
  for (const [key, status] of [[null, 'empty'], ['missing', 'unavailable'], ['pb', 'unavailable'], ['p', 'ok']] as const) {
    await env.DB.prepare('UPDATE notes SET person_key=? WHERE id=?').bind(key, 'n').run()
    const row = (await run(kernel, { entity: 'notes', select: ['id', 'person'], labels: ['person'], limit: 10 })).data[0]
    expect(row.__labels.person.status, `computed ref key=${key}`).toBe(status)
    expect(Object.keys(row).sort()).toEqual(['__labels', 'id', 'person'])
  }
})

// Every layer must preserve absence separately from a policy-masked NULL.
it.each([{ depth: 2, source: 'computed' }, { depth: 3, source: 'computed' }, { depth: 4, source: 'computed' }, { depth: 8, source: 'computed' }, { depth: 3, source: 'stored' }, { depth: 3, source: 'scalar' }])('computed ref chains of depth $depth from $source preserve absence without revealing target existence', async ({ depth, source }) => {
  const refs = Array.from({ length: depth }, (_, index) => `person_${index}`)
  const config = defineInstance({ id: 'composed_refs', revision: 1, interactive: true, plugins: [identity, localAuth, tenancy, rbac], roles: ['viewer'],
    permissions: { viewer: { people: ['read'], notes: ['read'] } }, policies: { people: { viewer: 'all' }, notes: { viewer: 'all' } }, entities: {
      people: { displayField: 'name', fields: { name: { type: 'string' } } },
      notes: { displayField: 'title', fields: { title: { type: 'string' }, person_key: source === 'stored' ? { type: 'ref', entity: 'people' } : { type: 'string' },
        ...(source === 'scalar' ? { person_value: { type: 'string' as const, computed: Q.expr('person_key').serialize() } } : {}),
        ...Object.fromEntries(refs.map((field, index) => [field, { type: 'ref' as const, entity: 'people', computed: Q.expr(index ? refs[index - 1] : source === 'scalar' ? 'person_value' : 'person_key').serialize() }])),
      } },
    } })
  // An unconstrained legacy FK permits real dangling values in the stored case.
  await setup(source === 'stored' ? defineInstance({ ...config, entities: { ...config.entities, notes: { ...config.entities.notes, fields: { ...config.entities.notes.fields, person_key: { type: 'string' } } } } }) : config)
  await env.DB.exec("INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES ('hidden','org-a','Secret',datetime('now'),datetime('now')),('visible','org-a','Public',datetime('now'),datetime('now')),('foreign','org-b','Public',datetime('now'),datetime('now'))")
  await env.DB.exec("INSERT INTO notes(id,organization_id,title,person_key,created_at,updated_at) VALUES ('n','org-a','Note','hidden',datetime('now'),datetime('now'))")
  const kernel = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'restricted', version: '1', tableFilter: entity => entity === 'people' ? { kind: 'where', predicate: { name: { ne: 'Secret' } } } : { kind: 'all' } }] })
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-viewer-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const load = () => executeQuery(kernel, scope, env.DB, 'synthetic', { entity: 'notes', select: ['id', ...refs], labels: refs, limit: 10 }, { writeLog: () => {} })
  const forbidden = await load()
  expect(forbidden.data[0]).toEqual({ id: 'n', ...Object.fromEntries(refs.map(field => [field, null])), __labels: Object.fromEntries(refs.map(field => [field, { status: 'unavailable' }])) })
  await env.DB.exec("DELETE FROM people WHERE id='hidden'")
  expect(await load()).toEqual(forbidden)
  for (const [key, status] of [[null, 'empty'], ['missing', 'unavailable'], ['foreign', 'unavailable'], ['visible', 'ok']] as const) {
    await env.DB.prepare('UPDATE notes SET person_key=? WHERE id=?').bind(key, 'n').run()
    const row = (await load()).data[0]
    for (const ref of refs) {
      expect(row[ref], `${ref}, key=${key}`).toBe(status === 'ok' ? key : null)
      expect(row.__labels[ref].status, `${ref}, key=${key}`).toBe(status)
    }
    expect(Object.keys(row).sort()).toEqual(['__labels', 'id', ...refs].sort())
  }
})
