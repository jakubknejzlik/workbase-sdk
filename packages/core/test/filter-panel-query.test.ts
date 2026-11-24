import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { setup, policyGraph, runtime } from './fixtures/policy-graph/setup'
import { defineInstance, baseFields } from '../src/config'
import { createApp } from '../src/app'
import { request, json } from '@workbasehq/test-support/helpers'
import { stateFromSearch, toQueryDocument } from '../../console-generated/src/list-model'
import { pickerQuery } from '../../console-generated/src/write'
import type { Model, Capabilities } from '../../console-generated/src/read'

const model: Model = { instance: 'panel-query', revision: 1, limits: { root: 100, children: 100, exists: 4, relations: 4 }, entities: {
  records: { fields: { id: { type: 'string' }, name: { type: 'string' }, team_id: { type: 'ref', entity: 'teams' } }, columns: ['id'], relations: { team: { entity: 'teams', field: 'team_id', cardinality: 'n:1' } }, routes: { list: '', detail: '' }, list: { columns: [{ field: 'id' }], filter: { name: { kind: 'text', placement: 'panel', operators: ['contains'] }, team_id: { kind: 'relation', placement: 'panel', operators: ['in'] } } } },
  teams: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
} }
const caps: Capabilities = { revision: 1, entities: { records: { readable: ['id', 'name', 'team_id'], writable: [], operations: ['read'] }, teams: { readable: ['id', 'name'], writable: [], operations: ['read'] } } }
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
it('hidden scalar and relation operands filter server rows by exact IDs even when labels coincide', async () => {
  await env.DB.exec("UPDATE teams SET name = 'Same label' WHERE organization_id = 'org-a'")
  const lookup = await json(await request(app, '/query', 'POST', pickerQuery(model, 'teams', caps), 'administrator'))
  expect(lookup.data.map((row: any) => row.name)).toEqual(['Same label', 'Same label'])
  for (const [id, expected] of [['team-a', ['record-colleague', 'record-own']], ['team-b', ['record-CANARY_ROW']]] as const) {
    const { state, dropped } = stateFromSearch({ filters: [{ field: 'team_id', predicate: { in: [id] } }] }, model, 'records', caps)
    expect(dropped).toBe(false)
    const query = toQueryDocument(state, model, 'records', caps)
    expect(query.where).toEqual({ and: [{ team_id: { in: [id] } }] })
    expect(query.labelWhere).toBeUndefined()
    const response = await request(app, '/query', 'POST', query, 'administrator')
    expect(response.status).toBe(200)
    expect((await json(response)).data.map((row: any) => row.id)).toEqual(expected)
  }
  const scalar = stateFromSearch({ filters: [{ field: 'name', predicate: { contains: 'colleague' } }] }, model, 'records', caps)
  const response = await request(app, '/query', 'POST', toQueryDocument(scalar.state, model, 'records', caps), 'administrator')
  expect((await json(response)).data.map((row: any) => row.id)).toEqual(['record-colleague'])
  expect(model.entities.records.list!.columns).toEqual([{ field: 'id' }])
})
it.each([{}, { search: 'CANARY_TEAM' }, { ids: ['team-a', 'team-b', 'team-canary'] }])('target read denial exposes no option rows or canary labels through picker queries: %j', async options => {
  const denied = createApp({ ...policyGraph, permissions: { ...policyGraph.permissions, reviewer: { ...policyGraph.permissions.reviewer, teams: [] } } }, runtime())
  // Bypass the client gate deliberately: the server must independently enforce the grant.
  const response = await request(denied, '/query', 'POST', pickerQuery(model, 'teams', caps, options), 'reviewer')
  expect(response.status).toBe(403)
  const body = await json(response)
  expect(body.data).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain('CANARY_TEAM')
  expect(JSON.stringify(body)).not.toContain('CANARY_ORG')
})

// Same public scalar payload as the picker, with a deliberately colliding relation.
async function collisionApp(options: { field?: boolean; target?: boolean; targetName?: boolean; targetId?: boolean; views?: boolean } = {}) {
  await env.DB.exec("ALTER TABLE records ADD COLUMN client TEXT; UPDATE records SET client=team_id;")
  const source = defineInstance({ ...policyGraph,
    plugins: [...policyGraph.plugins!, ...(options.targetId === false ? [{ name: 'mask-target-id', version: '1',
      fieldMask: (entity: string) => entity === 'teams' ? ['name'] : [...baseFields, ...Object.keys(policyGraph.entities[entity].fields), ...(entity === 'records' ? ['client'] : [])],
    }] : [])], entities: { ...policyGraph.entities,
    records: { ...policyGraph.entities.records, fields: { ...policyGraph.entities.records.fields, client: { type: 'ref', entity: 'teams' } },
      relations: { ...policyGraph.entities.records.relations, client: { entity: 'teams', field: 'client' } } },
  }, policies: { ...policyGraph.policies,
    records: { ...policyGraph.policies!.records, ...(options.field === false ? { administrator: { where: {}, fields: ['id', 'name', 'team_id'] } } : {}) },
    teams: { ...policyGraph.policies!.teams, ...(options.targetName === false ? { administrator: { where: {}, fields: ['id'] } } : {}) },
  }, permissions: { ...policyGraph.permissions, ...(options.target === false ? { administrator: { ...policyGraph.permissions.administrator, teams: [] } } : {}) },
    ui: { entities: { records: { list: { columns: ['name'], filter: { client: { kind: 'relation', placement: 'panel', operators: ['in'] } }, views: options.views ? [
      { id: 'scalar', label: 'Scalar', where: { client: { in: ['team-a'] } } },
      { id: 'relation', label: 'Relation', where: { client: { name: { eq: 'A' } } } },
    ] : [] } } } },
  })
  return createApp(source, runtime())
}
it.each([
  [{ client: { in: ['team-a'] } }, ['record-colleague', 'record-own']],
  [{ client: { id: { in: ['team-a'] } } }, ['record-colleague', 'record-own']],
  [{ client: { eq: null } }, []], [{ client: { isNull: true } }, []],
  [{ client: { ne: null } }, ['record-CANARY_ROW', 'record-colleague', 'record-own']],
  [{ not: { client: { in: ['team-a'] } } }, ['record-CANARY_ROW']],
  [{ and: [{ client: { ne: 'team-b' } }, { client: { id: { eq: 'team-a' } } }] }, ['record-colleague', 'record-own']],
  [{ or: [{ client: { in: [] } }, { client: { in: ['team-b'] } }] }, ['record-CANARY_ROW']],
])('collision HTTP scalar/relation contract: %j', async (where, expected) => {
  const collision = await collisionApp()
  const response = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 100, includeTotal: true, where }, 'administrator')
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body.data.map((row: any) => row.id)).toEqual(expected)
  expect(body.total).toBe(expected.length)
})
it.each([{ client: { in: ['team-a'] } }, { client: { id: { in: ['team-a'] } } }])('collision HTTP preserves tenant and row scope: %j', async where => {
  const collision = await collisionApp()
  await env.DB.exec("UPDATE records SET client='team-b' WHERE id='record-colleague'")
  const response = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 100, where }, 'reviewer')
  expect(response.status).toBe(200)
  expect((await json(response)).data.map((row: any) => row.id)).toEqual(['record-own'])
  for (const id of ['team-b', 'team-canary']) {
    const deniedWhere = 'in' in where.client ? { client: { in: [id] } } : { client: { id: { in: [id] } } }
    const denied = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 100, where: deniedWhere }, 'reviewer')
    expect(denied.status).toBe(200); expect((await json(denied)).data).toEqual([])
  }
})
it.each([{ field: false }, { target: false }, { targetName: false }, { targetId: false }])('collision projection prunes whole hidden predicates: %j', async options => {
  const collision = await collisionApp({ ...options, views: true })
  const response = await request(collision, '/o/org-a/console-model', 'GET', undefined, 'administrator')
  expect(response.status).toBe(200)
  const body = await json(response)
  const views = body.model.entities.records.list?.views ?? []
  expect(views.some((view: any) => view.id === 'relation')).toBe(false)
  expect(views.some((view: any) => view.id === 'scalar')).toBe(options.targetName === false)
  if (options.field === false || options.target === false || options.targetId === false) expect(body.model.entities.records.list?.filter?.client).toBeUndefined()
  if (options.field === false) for (const client of [{ in: ['team-a'] }, { id: { in: ['team-a'] } }]) {
    const denied = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 1, where: { client } }, 'administrator')
    expect(denied.status).toBe(403)
  }
  if (options.targetName === false) {
    const denied = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 1, where: { client: { name: { eq: 'A' } } } }, 'administrator')
    expect(denied.status).toBe(403)
  }
  const hiddenView = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 1, view: 'relation' }, 'administrator')
  expect(hiddenView.status).toBe(400)
  expect(await json(hiddenView)).toEqual({ error: 'query_invalid', path: ['view'] })
  if (options.target === false || options.targetId === false) {
    const denied = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 1, where: { client: { id: { in: ['team-a'] } } } }, 'administrator')
    expect(denied.status).toBe(403)
    const scalar = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 1, where: { client: { in: ['team-a'] } } }, 'administrator')
    expect(scalar.status).toBe(200); expect((await json(scalar)).data).toEqual([])
  }
})
it('collision mixed scalar/relation operand fails closed with the existing documented query_invalid error', async () => {
  const collision = await collisionApp()
  const response = await request(collision, '/query', 'POST', { entity: 'records', limit: 1, where: { client: { in: ['team-a'], id: { eq: 'team-a' } } } }, 'administrator')
  expect(response.status).toBe(400)
  expect(await json(response)).toEqual({ error: 'query_invalid', path: ['where', 'client'] })
})

it('collision picker selection produces the unchanged scalar payload and correct HTTP rows', async () => {
  const collision = await collisionApp()
  const definition = structuredClone(model), grant = structuredClone(caps)
  definition.entities.records.fields.client = { type: 'ref', entity: 'teams' }
  definition.entities.records.relations.client = { entity: 'teams', field: 'client', cardinality: 'n:1' }
  definition.entities.records.list!.filter = { client: { kind: 'relation', placement: 'panel', operators: ['in'] } }
  grant.entities.records.readable.push('client')
  const lookup = await request(collision, '/query', 'POST', pickerQuery(definition, 'teams', grant), 'administrator')
  expect(lookup.status).toBe(200)
  const selected = (await json(lookup)).data[0].id
  const { state, dropped } = stateFromSearch({ filters: [{ field: 'client', predicate: { in: [selected] } }] }, definition, 'records', grant)
  expect(dropped).toBe(false)
  const query = toQueryDocument(state, definition, 'records', grant)
  expect(query.where).toEqual({ and: [{ client: { in: [selected] } }] })
  const response = await request(collision, '/query', 'POST', query, 'administrator')
  expect(response.status).toBe(200)
  expect((await json(response)).data.map((row: any) => row.id)).toEqual(['record-colleague', 'record-own'])
})
it.each([
  [{ client: { eq: null } }, ['record-colleague']],
  [{ client: { in: [null, 'team-a'] } }, ['record-colleague', 'record-own']],
  [{ client: { ne: null } }, ['record-own']],
  [{ client: { ne: 'team-a' } }, []],
  [{ not: { client: { in: ['team-a'] } } }, []],
  [{ or: [{ client: { isNull: true } }, { client: { id: { eq: 'team-a' } } }] }, ['record-colleague', 'record-own']],
])('collision nullable scalar semantics remain scoped under reviewer: %j', async (where, expected) => {
  const collision = await collisionApp()
  await env.DB.exec("UPDATE records SET client=NULL WHERE id='record-colleague'")
  const response = await request(collision, '/query', 'POST', { entity: 'records', select: ['id'], limit: 100, where }, 'reviewer')
  expect(response.status).toBe(200)
  expect((await json(response)).data.map((row: any) => row.id)).toEqual(expected)
})
