import { expect, it, vi } from 'vitest'
import { changeSavedViews, clearSavedViews, loadSavedViews, restoreSavedView, savedSearchFromState, savedViewsKey, savedViewsLimits, type SavedViewsScope } from '../src/saved-views'
import { stateFromSearch, type ListState } from '../src/list-model'
import type { Model, Capabilities } from '../src/read'
const scope: SavedViewsScope = { instance: 'instance', userId: 'user', orgId: 'org' }
const model: Model = { instance: 'instance', revision: 1, limits: { root: 100, children: 100, relations: 4, exists: 4 }, entities: { entries: { fields: { id: { type: 'string' }, name: { type: 'string' }, created: { type: 'datetime' } }, columns: ['name', 'created'], relations: {}, routes: { list: '/entries', detail: '/entries/:id' }, list: { defaultSort: { key: 'created', direction: 'desc' }, views: [{ id: 'active', label: 'Active', where: { name: { contains: 'active' } }, default: true }] } } } }
const caps: Capabilities = { revision: 1, entities: { entries: { readable: ['id', 'name', 'created'], writable: [], operations: ['read'] } } }
const state: ListState = { ...stateFromSearch({}, model, 'entries', caps).state, view: 'all', sort: null, search: 'private global text', presentation: 'calendar', calendarMode: 'week', calendarDate: '2026-11-17', cursor: 'opaque', limit: 100, userFilters: [{ field: 'name', predicate: { contains: 'filter text' } }], rowAccess: 'signed_in' }
function storage() {
  const data = new Map<string, string>()
  return { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value) }), removeItem: vi.fn((key: string) => { data.delete(key) }), key: (index: number) => [...data.keys()][index] ?? null, get length() { return data.size } }
}
it('isolates instance, account, organization, and entity with unambiguous encoding', () => {
  const keys = [savedViewsKey(scope, 'entries'), ...(['instance', 'userId', 'orgId'] as const).map(field => savedViewsKey({ ...scope, [field]: scope[field] + ':other' }, 'entries')), savedViewsKey(scope, 'other')]
  expect(new Set(keys).size).toBe(5)
  expect(savedViewsKey({ ...scope, instance: 'a:b', userId: 'c' }, 'entries')).not.toBe(savedViewsKey({ ...scope, instance: 'a', userId: 'b:c' }, 'entries'))
  expect(savedViewsKey({ ...scope, userId: '%3A' }, 'entries')).not.toBe(savedViewsKey({ ...scope, userId: ':' }, 'entries'))
  expect(keys[0]).toBe('workbase:saved-views:v1:instance:user:org:entries')
  const store = storage()
  changeSavedViews(scope, 'entries', { kind: 'save', name: 'Mine', state }, store)
  expect(loadSavedViews({ ...scope, userId: 'other' }, 'entries', store).entries).toEqual([])
  expect(store.getItem.mock.calls.at(-1)).toEqual([savedViewsKey({ ...scope, userId: 'other' }, 'entries')])
})
it('persists only allowed settings in the v1 envelope and preserves explicit all/none', () => {
  const store = storage()
  const result = changeSavedViews(scope, 'entries', { kind: 'save', name: '  Mine  ', state }, store)
  expect(result.error).toBeUndefined()
  expect(result.entries[0]).toMatchObject({ name: 'Mine', search: { filters: state.userFilters, rowAccess: 'signed_in', view: 'all', sort: 'none' } })
  const raw = store.getItem(savedViewsKey(scope, 'entries'))!
  expect(JSON.parse(raw)).toEqual({ v: 1, entries: result.entries })
  expect(Object.keys(result.entries[0].search).sort()).toEqual(['filters', 'rowAccess', 'sort', 'view'])
  for (const forbidden of ['opaque', 'private global text', 'calendarDate', 'pageSize', 'rows', 'labels']) expect(raw).not.toContain(forbidden)
  const restored = restoreSavedView(result.entries[0].search, model, 'entries', caps)
  expect(restored.search).toMatchObject({ view: 'all', sort: 'none', pageSize: 30 })
})
it('supports fresh catalogue CRUD without overwriting another tab', () => {
  const store = storage()
  const first = changeSavedViews(scope, 'entries', { kind: 'save', name: 'One', state }, store).entries[0]
  changeSavedViews(scope, 'entries', { kind: 'save', name: 'Two', state }, store)
  expect(changeSavedViews(scope, 'entries', { kind: 'rename', id: first.id, name: ' Renamed ' }, store).entries.map(e => e.name)).toEqual(['Renamed', 'Two'])
  expect(changeSavedViews(scope, 'entries', { kind: 'update', id: first.id, state: { ...state, sort: { key: 'created', direction: 'asc' } } }, store).entries[0].search.sort).toBe('created')
  expect(changeSavedViews(scope, 'entries', { kind: 'delete', id: first.id }, store).entries.map(e => e.name)).toEqual(['Two'])
  expect(changeSavedViews(scope, 'entries', { kind: 'rename', id: first.id, name: 'Gone' }, store).error).toBe('invalid')
})
it.each(['null', '[]', '1', '{}', '{', '{"v":2,"entries":[]}', '{"v":1,"entries":null}', '{"v":1,"entries":[null]}', ...[null, [], 'bad', 1].map(search => JSON.stringify({ v: 1, entries: [{ id: 'id', name: 'Name', search }] })), JSON.stringify({ v: 1, entries: [{ id: 'id', name: 'Name', search: {} }, { id: 'id', name: 'Other', search: {} }] })])('rejects untrusted envelope/entry %s safely', raw => {
  const store = storage(); store.setItem(savedViewsKey(scope, 'entries'), raw)
  expect(loadSavedViews(scope, 'entries', store)).toEqual({ entries: [], error: 'invalid' })
  expect(changeSavedViews(scope, 'entries', { kind: 'save', name: 'New', state }, store).error).toBe('invalid')
  expect(store.getItem(savedViewsKey(scope, 'entries'))).toBe(raw)
})
it.each([null, [], 1, 'bad', { filters: [null, { field: 'name', predicate: null }] }, { filters: [{ field: 'created', predicate: { gte: { toString: null } } }] }])('guards malformed search before rebuilding: %j', search => {
  const restored = restoreSavedView(search, model, 'entries', caps)
  expect(restored.dropped).toBe(true)
  expect(restored.search.filters).toBeUndefined()
})
it('strips injected non-settings on load and restores with current permissions', () => {
  const store = storage()
  store.setItem(savedViewsKey(scope, 'entries'), JSON.stringify({ v: 1, entries: [{ id: 'id', name: 'Mine', search: { filters: state.userFilters, sort: 'created', direction: 'desc', view: 'active', search: 'secret', pageSize: 100, cursor: 'opaque' } }] }))
  const loaded = loadSavedViews(scope, 'entries', store).entries[0]
  expect(loaded.search.search).toBeUndefined()
  const reduced = { ...caps, entities: { entries: { ...caps.entities.entries, readable: ['id'] } } }
  expect(restoreSavedView(loaded.search, model, 'entries', reduced)).toEqual({ search: { sort: 'none', view: 'all', pageSize: 30 }, dropped: true })
})
it.each(['', '   ', 'n'.repeat(81)])('rejects invalid trimmed name %j', name => {
  const store = storage()
  expect(changeSavedViews(scope, 'entries', { kind: 'save', name, state }, store).error).toBe('name')
  expect(store.setItem).not.toHaveBeenCalled()
})
it('allows an 80-character name and rejects a 21st view without eviction', () => {
  const store = storage()
  for (let i = 0; i < 20; i++) expect(changeSavedViews(scope, 'entries', { kind: 'save', name: 'n'.repeat(80), state }, store).error).toBeUndefined()
  const before = store.getItem(savedViewsKey(scope, 'entries'))
  expect(changeSavedViews(scope, 'entries', { kind: 'save', name: 'Extra', state }, store).error).toBe('limit')
  expect(store.getItem(savedViewsKey(scope, 'entries'))).toBe(before)
})
it('enforces UTF-8 entry and namespace limits without eviction', () => {
  const store = storage()
  const bigState = { ...state, userFilters: [{ field: 'name', predicate: { contains: 'é'.repeat(8300) } }] }
  expect(changeSavedViews(scope, 'entries', { kind: 'save', name: 'Big', state: bigState }, store).error).toBe('limit')
  const medium = { ...state, userFilters: [{ field: 'name', predicate: { contains: 'a'.repeat(15000) } }] }
  for (let i = 0; i < 8; i++) expect(changeSavedViews(scope, 'entries', { kind: 'save', name: 'Medium', state: medium }, store).error).toBeUndefined()
  const before = store.getItem(savedViewsKey(scope, 'entries'))
  expect(changeSavedViews(scope, 'entries', { kind: 'save', name: 'Overflow', state: medium }, store).error).toBe('limit')
  expect(store.getItem(savedViewsKey(scope, 'entries'))).toBe(before)
})
it.each(['entry', 'namespace', 'count'])('guards oversized stored %s', kind => {
  const store = storage(), entry = { id: 'id', name: 'Mine', search: { filters: [{ field: 'name', predicate: { contains: 'a'.repeat(savedViewsLimits.entryBytes) } }] } }
  const raw = kind === 'namespace' ? ' '.repeat(savedViewsLimits.namespaceBytes + 1) : JSON.stringify({ v: 1, entries: kind === 'count' ? Array.from({ length: 21 }, (_, i) => ({ ...entry, id: String(i), search: {} })) : [entry] })
  store.setItem(savedViewsKey(scope, 'entries'), raw)
  expect(loadSavedViews(scope, 'entries', store).error).toBe('limit')
})
it('handles denied storage and quota errors while preserving the existing collection', () => {
  const store = storage(); changeSavedViews(scope, 'entries', { kind: 'save', name: 'First', state }, store)
  store.setItem.mockImplementation(() => { throw new Error('QuotaExceededError') })
  expect(changeSavedViews(scope, 'entries', { kind: 'save', name: 'Second', state }, store)).toMatchObject({ error: 'storage', entries: [{ name: 'First' }] })
  store.getItem.mockImplementation(() => { throw new Error('SecurityError') })
  expect(loadSavedViews(scope, 'entries', store).error).toBe('storage')
  expect(() => clearSavedViews(scope, store)).not.toThrow()
})
it('cleans only the signed-out account across organizations/entities, preserving unrelated keys', () => {
  const store = storage()
  const own = [savedViewsKey(scope, 'entries'), savedViewsKey({ ...scope, orgId: 'other' }, 'other')]
  const retained = [savedViewsKey({ ...scope, userId: 'user-extra' }, 'entries'), savedViewsKey({ ...scope, instance: 'other' }, 'entries'), 'console-language', 'workbase:language', 'unrelated']
  for (const key of [...own, ...retained]) store.setItem(key, 'keep')
  clearSavedViews(scope, store)
  for (const key of own) expect(store.getItem(key)).toBeNull()
  for (const key of retained) expect(store.getItem(key)).toBe('keep')
  clearSavedViews(undefined, store)
  expect(store.length).toBe(3)
  for (const key of retained.slice(2)) expect(store.getItem(key)).toBe('keep')
})
it('keeps direction from canonical state', () => {
  expect(savedSearchFromState({ ...state, sort: { key: 'created', direction: 'desc' } })).toMatchObject({ sort: 'created', direction: 'desc' })
})
