import { expect, it } from 'vitest'
import { filterKind, filterableFields, filterMapping } from '../src/filter-kinds'
import { stateFromSearch, toQueryDocument } from '../src/list-model'
import { listSearchableFields, type Model, type Capabilities } from '../src/read'

const model: Model = { instance: 'v2', revision: 1, limits: { root: 100, children: 100, relations: 4, exists: 4 }, entities: {
  workers: { rowInvitations: true, displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, code: { type: 'string' }, team_id: { type: 'ref', entity: 'teams' }, enabled: { type: 'bool', required: false }, created_at: { type: 'datetime' } },
    columns: ['name', 'code', 'team_id', 'enabled', 'created_at'], relations: { team: { entity: 'teams', field: 'team_id', cardinality: 'n:1' } }, routes: { list: '', detail: '' },
    list: { columns: [{ field: 'name', secondary: 'code' }], relatedColumns: { location: { via: 'team_id', field: 'location_id' } }, filter: {
      team_id: { kind: 'relation', placement: 'toolbar', operators: ['in'] },
      enabled: { kind: 'boolean', placement: 'panel', operators: ['eq', 'isNull'] },
      created_at: { kind: 'date', placement: 'panel', operators: ['gte'] }, location: { kind: 'text', placement: 'panel', operators: ['contains'] },
    }, views: [{ id: 'all', label: 'All', where: {}, default: true }, { id: 'invited', label: 'Invited', where: {}, rowAccess: 'invited' }] },
  },
  teams: { fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
} }
const caps: Capabilities = { revision: 1, resources: { 'invitations.read': true }, entities: {
  workers: { readable: Object.keys(model.entities.workers.fields), writable: [], operations: ['read'] },
  teams: { readable: ['id', 'name'], writable: [], operations: ['read'] },
} }
it('honors explicit relation filters while unconfigured references retain label-text behavior', () => {
  expect(filterKind(model, 'workers', 'team_id', caps)).toBe('relation')
  const plain = structuredClone(model); delete plain.entities.workers.list!.filter!.team_id
  expect(filterKind(plain, 'workers', 'team_id', caps)).toBe('text')
  const denied = structuredClone(caps); denied.entities.teams.operations = []
  expect(filterKind(model, 'workers', 'team_id', denied)).toBeUndefined()
})
it('discovers and restores configured non-column and related-column filters, without changing search scope', () => {
  expect(filterableFields(model, 'workers', caps)).toEqual(['name', 'team_id', 'enabled', 'created_at', 'location'])
  expect(listSearchableFields(model, 'workers', caps)).toEqual(['name'])
  const { state, dropped } = stateFromSearch({ filters: [{ field: 'team_id', predicate: { in: ['team'] } }, { field: 'location', predicate: { contains: 'Place' } }] }, model, 'workers', caps)
  expect(dropped).toBe(false)
  expect(state.userFilters).toHaveLength(2)
  const query = toQueryDocument(state, model, 'workers', caps)
  expect(query.where).toMatchObject({ and: [{}, { team_id: { in: ['team'] } }] })
  expect(query.labelWhere).toEqual({ location: { contains: 'Place' } })
})
it('enforces narrowed operators on restore and compound date/nullable boolean emissions', () => {
  const { state, dropped } = stateFromSearch({ filters: [{ field: 'created_at', predicate: { lte: '2026-11-19' } }] }, model, 'workers', caps)
  expect(dropped).toBe(true); expect(state.userFilters).toEqual([])
  const from = stateFromSearch({ filters: [{ field: 'created_at', predicate: { gte: '2026-11-19' } }, { field: 'enabled', predicate: { in: [false, null] } }] }, model, 'workers', caps)
  expect(from.dropped).toBe(false)
  expect(toQueryDocument(from.state, model, 'workers', caps).where).toMatchObject({ and: [{}, { created_at: { gte: expect.stringContaining('T') } }, { or: [{ enabled: { eq: false } }, { enabled: { isNull: true } }] }] })
  expect(filterMapping('date', { type: 'datetime' }, undefined, ['gte', 'lt']).toPredicate({ value: '2026-11-19' }, true)).toEqual({ gte: expect.any(String), lt: expect.any(String) })
  expect(filterMapping('boolean', { type: 'bool', required: false }, undefined, ['eq']).toPredicate(false)).toBeUndefined()
})
it('applies view rowAccess with precedence and drops inaccessible views as a whole', () => {
  const { state } = stateFromSearch({ view: 'invited', rowAccess: 'expired' }, model, 'workers', caps)
  expect(toQueryDocument(state, model, 'workers', caps).rowAccess).toBe('invited')
  const denied = structuredClone(caps); denied.resources!['invitations.read'] = false
  const restored = stateFromSearch({ view: 'invited' }, model, 'workers', denied)
  expect(restored.dropped).toBe(true); expect(restored.state.view).toBe('all')
  expect(toQueryDocument({ ...state, view: 'invited' }, model, 'workers', denied)).not.toHaveProperty('rowAccess')
})
