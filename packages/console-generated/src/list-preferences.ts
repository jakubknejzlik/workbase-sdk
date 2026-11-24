import type { SavedViewsScope } from './saved-views'

export interface ListPreferences { visible: string[]; density: 'default' | 'compact' }
export interface ListDisplayConfig { columns: { id: string; defaultVisible?: boolean }[]; primary?: string; compact: boolean }
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
type Account = Pick<SavedViewsScope, 'instance' | 'userId'>
const prefix = 'workbase:list-prefs:v1:'
// Retain the last known choices; only failed writes override otherwise accessible storage.
const memory = new Map<string, unknown>()
const pending = new Set<string>()
// A failed cleanup must not resurrect stale disk data later in this document.
const cleared = new Set<string>()
const wasCleared = (key: string) => [...cleared].some(match => key.startsWith(match))
const listeners = new Set<(account?: Account) => void>()
function accountPrefix(scope: Account) { return `${prefix}${encodeURIComponent(scope.instance)}:${encodeURIComponent(scope.userId)}:` }
export function listPreferencesKey(scope: SavedViewsScope, entity: string) {
  return `${accountPrefix(scope)}${encodeURIComponent(scope.orgId)}:${encodeURIComponent(entity)}`
}
export function normalizeListPreferences(value: unknown, config: ListDisplayConfig): ListPreferences {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const visible = Array.isArray(object.visible) && object.visible.every(id => typeof id === 'string') ? new Set(object.visible) : undefined
  return {
    visible: config.columns.filter(column => column.id === config.primary || (visible ? visible.has(column.id) : column.defaultVisible !== false)).map(column => column.id),
    density: object.density === 'compact' || object.density === 'default' ? object.density : config.compact ? 'compact' : 'default',
  }
}
export function loadListPreferences(scope: SavedViewsScope, entity: string, config: ListDisplayConfig, store?: Store) {
  const key = listPreferencesKey(scope, entity)
  let value: unknown = memory.get(key)
  if (!pending.has(key) && !wasCleared(key)) {
    try { value = JSON.parse((store ?? globalThis.localStorage).getItem(key) ?? 'null'); memory.set(key, value) } catch { /* Keep the last in-memory choice. */ }
  }
  return { preferences: normalizeListPreferences(value, config), stored: value != null }
}
export function saveListPreferences(scope: SavedViewsScope, entity: string, preferences: ListPreferences | null, store?: Store) {
  const key = listPreferencesKey(scope, entity)
  memory.set(key, preferences)
  try {
    const target = store ?? globalThis.localStorage
    if (preferences) target.setItem(key, JSON.stringify(preferences))
    else target.removeItem(key)
    if (wasCleared(key)) pending.add(key)
    else pending.delete(key)
  } catch { pending.add(key) }
}
export function onListPreferencesCleared(listener: (account?: Account) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
/** Explicit logout only, across every organization/entity belonging to the verified account. */
export function clearListPreferences(account?: Account, store?: Store) {
  for (const listener of listeners) { try { listener(account) } catch { /* Logout must complete. */ } }
  const match = account ? accountPrefix(account) : prefix
  for (const key of memory.keys()) if (key.startsWith(match)) { memory.delete(key); pending.delete(key) }
  try {
    const target = store ?? globalThis.localStorage, keys: string[] = []
    for (let index = 0; index < target.length; index++) { const key = target.key(index); if (key?.startsWith(match)) keys.push(key) }
    for (const key of keys) {
      try { target.removeItem(key) } catch { memory.set(key, null); pending.add(key) }
    }
  } catch { cleared.add(match) /* Unavailable storage must not block logout or resurrect disk data. */ }
}
