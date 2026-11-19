import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { setup, policyGraph, runtime } from './fixtures/policy-graph/setup'
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
