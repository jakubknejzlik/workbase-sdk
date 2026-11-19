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
  expect(filterableFields(model, 'workers', caps)).toEqual(['team_id', 'enabled', 'created_at', 'location', 'name'])
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

it('URL and saved-view restore share pruning of removed definitions, kinds and source permissions', async () => {
  const { restoreSavedView } = await import('../src/saved-views')
  const filters = [{ field: 'team_id', predicate: { in: ['target-a', 'target-b'] } }, { field: 'enabled', predicate: { eq: true } }]
  for (const changed of ['none', 'removed', 'kind', 'unreadable', 'disabled'] as const) {
    const next = structuredClone(model), grant = structuredClone(caps)
    if (changed === 'removed') delete next.entities.workers.list!.filter!.team_id
    if (changed === 'kind') next.entities.workers.list!.filter!.team_id = { kind: 'text', placement: 'panel', operators: ['contains'] }
    if (changed === 'unreadable') grant.entities.workers.readable = grant.entities.workers.readable.filter(field => field !== 'team_id')
    if (changed === 'disabled') next.entities.workers.list!.filter!.team_id = false
    const url = stateFromSearch({ filters }, next, 'workers', grant)
    const saved = restoreSavedView({ filters }, next, 'workers', grant)
    expect(saved.dropped).toBe(url.dropped)
    expect(saved.search.filters).toEqual(url.state.userFilters)
    expect(url.state.userFilters).toEqual(changed === 'none' ? filters : filters.slice(1))
    expect(url.state.cursor).toBeUndefined()
  }
})
it('never converts label text to IDs or emits a stale kind after configuration changes', () => {
  const text = { field: 'team_id', predicate: { contains: 'Same label' } }
  const restored = stateFromSearch({ filters: [text] }, model, 'workers', caps)
  expect(restored.dropped).toBe(true)
  const query = toQueryDocument({ ...restored.state, userFilters: [text] }, model, 'workers', caps)
  expect(query.labelWhere).toBeUndefined()
  expect(JSON.stringify(query.where)).not.toContain('Same label')
  const exact = stateFromSearch({ filters: [{ field: 'team_id', predicate: { in: ['target-a', 'target-b'] } }] }, model, 'workers', caps)
  expect(toQueryDocument(exact.state, model, 'workers', caps).where).toMatchObject({ and: [{}, { team_id: { in: ['target-a', 'target-b'] } }] })
})

it('uses the server view operand for offset rows/counts and retains manual access separately', () => {
  const { state } = stateFromSearch({ view: 'invited', rowAccess: 'expired', search: 'Ada' }, model, 'workers', caps)
  const query = toQueryDocument({ ...state, offset: 30 }, model, 'workers', caps)
  expect(query).toMatchObject({ view: 'invited', rowAccess: 'expired', offset: 30, includeTotal: true, includeViewTotals: true })
  expect(query.where).toBeUndefined()
  expect(query.cursor).toBeUndefined()
})
it('uses explicit search sources independently of table columns without broadening calendar behavior', () => {
  const configured = structuredClone(model); configured.entities.workers.list!.search = ['code']
  expect(listSearchableFields(configured, 'workers', caps)).toEqual(['code'])
  expect(toQueryDocument({ ...stateFromSearch({ search: 'PR' }, configured, 'workers', caps).state, offset: 0 }, configured, 'workers', caps).search?.fields).toEqual(['code'])
})
