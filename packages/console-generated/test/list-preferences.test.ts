import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearListPreferences, listPreferencesKey, loadListPreferences, normalizeListPreferences, saveListPreferences } from '../src/list-preferences'
const scope = { instance: 'instance', userId: 'user', orgId: 'org' }
const config = { columns: [{ id: 'name', defaultVisible: false }, { id: 'code' }, { id: 'hidden', defaultVisible: false }], primary: 'name', compact: true }
function storage() {
  const data = new Map<string, string>()
  return { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value) }), removeItem: vi.fn((key: string) => { data.delete(key) }), key: (index: number) => [...data.keys()][index] ?? null, get length() { return data.size } }
}
beforeEach(({ task }) => { scope.userId = task.name })
afterEach(() => { vi.unstubAllGlobals() })
it('honors configured defaults and treats malformed data as defaults', () => {
  const store = storage()
  expect(loadListPreferences(scope, 'entries', config, store).preferences).toEqual({ visible: ['name', 'code'], density: 'compact' })
  for (const raw of ['null', '{', '[]', '{"visible":[3],"density":"bad"}']) {
    store.setItem(listPreferencesKey(scope, 'entries'), raw)
    expect(loadListPreferences(scope, 'entries', config, store).preferences).toEqual({ visible: ['name', 'code'], density: 'compact' })
  }
  expect(normalizeListPreferences({ visible: ['hidden', 'removed', 'hidden'], density: 'default' }, config)).toEqual({ visible: ['name', 'hidden'], density: 'default' })
})
it('persists in a separate namespace and isolates every verified scope dimension, including encoded delimiters', () => {
  const store = storage(), prefs = { visible: ['name'], density: 'default' as const }
  saveListPreferences(scope, 'entries', prefs, store)
  expect(loadListPreferences(scope, 'entries', config, store).preferences).toEqual(prefs)
  for (const other of [{ ...scope, orgId: 'other' }, { ...scope, instance: 'other' }, { ...scope, userId: 'other' }]) {
    expect(loadListPreferences(other, 'entries', config, store).preferences.visible).toEqual(['name', 'code'])
  }
  expect(loadListPreferences(scope, 'other', config, store).preferences.visible).toEqual(['name', 'code'])
  expect(listPreferencesKey({ ...scope, instance: 'a:b', userId: 'c' }, 'entries')).not.toBe(listPreferencesKey({ ...scope, instance: 'a', userId: 'b:c' }, 'entries'))
  expect(store.getItem('workbase:saved-views:v1:instance:user:org:entries')).toBeNull()
})
it('retains choices and reset in memory when reads/writes or the storage getter fail', () => {
  const store = storage(), prefs = { visible: ['name'], density: 'default' as const }
  store.getItem.mockImplementation(() => { throw new Error('denied') })
  store.setItem.mockImplementation(() => { throw new Error('quota') })
  store.removeItem.mockImplementation(() => { throw new Error('denied') })
  saveListPreferences(scope, 'entries', prefs, store)
  expect(loadListPreferences(scope, 'entries', config, store).preferences).toEqual(prefs)
  saveListPreferences(scope, 'entries', null, store)
  expect(loadListPreferences(scope, 'entries', config, store).preferences.visible).toEqual(['name', 'code'])
  vi.stubGlobal('localStorage', undefined)
  saveListPreferences(scope, 'entries', prefs)
  expect(loadListPreferences(scope, 'entries', config).preferences).toEqual(prefs)
  clearListPreferences(scope)
  expect(loadListPreferences(scope, 'entries', config).preferences.visible).toEqual(['name', 'code'])
})
it('clears the account across organizations/entities while preserving other users, instances and features', () => {
  const store = storage(), prefs = { visible: ['name'], density: 'default' as const }
  const own = [listPreferencesKey(scope, 'entries'), listPreferencesKey({ ...scope, orgId: 'second' }, 'other')]
  const other = [listPreferencesKey({ ...scope, userId: 'other' }, 'entries'), listPreferencesKey({ ...scope, instance: 'other' }, 'entries'), 'workbase:saved-views:v1:instance:user:org:entries', 'console-language']
  for (const key of [...own, ...other]) store.setItem(key, JSON.stringify(prefs))
  clearListPreferences(scope, store)
  for (const key of own) expect(store.getItem(key)).toBeNull()
  for (const key of other) expect(store.getItem(key)).not.toBeNull()
  clearListPreferences(undefined, store)
  expect(store.getItem(other[0])).toBeNull(); expect(store.getItem('console-language')).not.toBeNull()
})

it('does not resurrect old disk preferences after logout even when enumeration/removal fails', () => {
  const store = storage(), account = { ...scope, userId: 'cleanup-denied' }
  saveListPreferences(account, 'entries', { visible: ['name'], density: 'default' }, store)
  Object.defineProperty(store, 'length', { get() { throw new Error('denied') } })
  expect(() => clearListPreferences(account, store)).not.toThrow()
  expect(loadListPreferences(account, 'entries', config, store).preferences.visible).toEqual(['name', 'code'])
})

it('keeps the last successful choice when storage becomes inaccessible before remount', () => {
  const store = storage(), account = { ...scope, userId: 'later-denied' }, prefs = { visible: ['name'], density: 'default' as const }
  saveListPreferences(account, 'entries', prefs, store)
  store.getItem.mockImplementation(() => { throw new Error('denied') })
  expect(loadListPreferences(account, 'entries', config, store).preferences).toEqual(prefs)
  clearListPreferences(account, store)
})
