/** Supplied only by an authenticated host after /me and organization authorization. */
export interface SavedViewsScope { instance: string; userId: string; orgId: string }
export interface SavedView { id: string; name: string; search: Record<string, unknown> }
export type SavedViewsError = 'storage' | 'invalid' | 'limit' | 'name'
export type SavedViewsResult = { entries: SavedView[]; error?: SavedViewsError }
export const savedViewsLimits = { count: 20, name: 80, entryBytes: 16 * 1024, namespaceBytes: 128 * 1024 } as const
const browser = globalThis as typeof globalThis & { crypto: { randomUUID(): string } }
const prefix = 'workbase:saved-views:'
const fields = ['filters', 'sort', 'direction', 'view', 'rowAccess'] as const
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
type Account = Pick<SavedViewsScope, 'instance' | 'userId'>
const cleanupListeners = new Set<(scope?: Account) => void>()
export function onSavedViewsCleared(listener: (scope?: Account) => void) {
  cleanupListeners.add(listener)
  return () => { cleanupListeners.delete(listener) }
}
function accountPrefix(scope: Account) { return `${prefix}v1:${encodeURIComponent(scope.instance)}:${encodeURIComponent(scope.userId)}:` }
export function savedViewsKey(scope: SavedViewsScope, entity: string) {
  return `${accountPrefix(scope)}${encodeURIComponent(scope.orgId)}:${encodeURIComponent(entity)}`
}
function storage(store?: Store): Store { return store ?? globalThis.localStorage }
function bytes(value: string) { return new TextEncoder().encode(value).byteLength }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function allowedSearch(search: Record<string, unknown>) {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(search, field)).map(field => [field, search[field]]))
}
function validName(value: unknown): value is string { return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= savedViewsLimits.name }
function parse(raw: string | null): SavedViewsResult {
  if (raw === null) return { entries: [] }
  if (bytes(raw) > savedViewsLimits.namespaceBytes) return { entries: [], error: 'limit' }
  try {
    const value: unknown = JSON.parse(raw)
    if (!object(value) || value.v !== 1 || !Array.isArray(value.entries)) return { entries: [], error: 'invalid' }
    if (value.entries.length > savedViewsLimits.count) return { entries: [], error: 'limit' }
    const ids = new Set<string>(), entries: SavedView[] = []
    for (const entry of value.entries) {
      if (!object(entry) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 128 || ids.has(entry.id) || !validName(entry.name) || !object(entry.search)) return { entries: [], error: 'invalid' }
      if (bytes(JSON.stringify(entry)) > savedViewsLimits.entryBytes) return { entries: [], error: 'limit' }
      ids.add(entry.id)
      // Keep permitted raw values until Apply, so current capabilities determine what is dropped.
      entries.push({ id: entry.id, name: entry.name, search: allowedSearch(entry.search) })
    }
    return { entries }
  } catch { return { entries: [], error: 'invalid' } }
}
export function loadSavedViews(scope: SavedViewsScope, entity: string, store?: Store): SavedViewsResult {
  try { return parse(storage(store).getItem(savedViewsKey(scope, entity))) }
  catch { return { entries: [], error: 'storage' } }
}
export type SavedViewsChange = { kind: 'save'; name: string; search: Record<string, unknown> } | { kind: 'rename'; id: string; name: string } | { kind: 'update'; id: string; search: Record<string, unknown> } | { kind: 'delete'; id: string }
/** Read fresh on each mutation; failed or over-limit writes never evict entries. */
export function changeSavedViews(scope: SavedViewsScope, entity: string, change: SavedViewsChange, store?: Store): SavedViewsResult {
  let current: SavedViewsResult = { entries: [] }
  try {
    const target = storage(store)
    current = loadSavedViews(scope, entity, target)
    if (current.error) return current
    if ('name' in change && !validName(change.name.trim())) return { ...current, error: 'name' }
    if ('id' in change && !current.entries.some(entry => entry.id === change.id)) return { ...current, error: 'invalid' }
    const entries = change.kind === 'save'
      ? [...current.entries, { id: browser.crypto.randomUUID(), name: change.name.trim(), search: allowedSearch(change.search) }]
      : current.entries.flatMap(entry => entry.id !== change.id ? [entry] : change.kind === 'delete' ? [] : [{ ...entry, ...(change.kind === 'rename' ? { name: change.name.trim() } : { search: allowedSearch(change.search) }) }])
    const raw = JSON.stringify({ v: 1, entries })
    if (entries.length > savedViewsLimits.count || entries.some(entry => bytes(JSON.stringify(entry)) > savedViewsLimits.entryBytes) || bytes(raw) > savedViewsLimits.namespaceBytes) return { ...current, error: 'limit' }
    target.setItem(savedViewsKey(scope, entity), raw)
    return { entries }
  } catch { return { ...current, error: 'storage' } }
}
/** Explicit sign-out only. Unknown verified scope falls back to this feature's keys. */
export function clearSavedViews(scope?: Account, store?: Store): void {
  // Invalidate mounted callbacks even when storage is inaccessible.
  for (const listener of cleanupListeners) { try { listener(scope) } catch { /* Cleanup must not block sign-out. */ } }
  try {
    const target = storage(store), match = scope ? accountPrefix(scope) : prefix
    const keys: string[] = []
    for (let index = 0; index < target.length; index++) { const key = target.key(index); if (key?.startsWith(match)) keys.push(key) }
    for (const key of keys) { try { target.removeItem(key) } catch { /* Try the remaining feature keys. */ } }
  } catch { /* Disabled storage must not block sign-out. */ }
}
