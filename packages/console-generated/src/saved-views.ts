import { searchFromState, stateFromSearch, validateListSearch, type ListSearch, type ListState } from './list-model'
import type { Capabilities, Model } from './read'
import { changeSavedViews as changeStoredViews, type SavedViewsChange as StoredChange } from '@workbasehq/plugins/console/ui/saved-views'
export { clearSavedViews, loadSavedViews, onSavedViewsCleared, savedViewsKey, savedViewsLimits, type SavedViewsScope, type SavedView, type SavedViewsResult, type SavedViewsError } from '@workbasehq/plugins/console/ui/saved-views'

/** Persist settings only, retaining explicit all/none instead of reintroducing defaults. */
export function savedSearchFromState(state: ListState): ListSearch {
  const { filters, sort, direction, view, rowAccess } = searchFromState(state)
  return { ...(filters ? { filters } : {}), ...(sort ? { sort } : {}), ...(direction ? { direction } : {}), ...(view ? { view } : {}), ...(rowAccess ? { rowAccess } : {}) }
}
export type SavedViewsChange = Exclude<StoredChange, { search: unknown }> | { kind: 'save'; name: string; state: ListState } | { kind: 'update'; id: string; state: ListState }
export function changeSavedViews(scope: import('@workbasehq/plugins/console/ui/saved-views').SavedViewsScope, entity: string, change: SavedViewsChange, store?: Parameters<typeof changeStoredViews>[3]) {
  return changeStoredViews(scope, entity, 'state' in change ? { ...change, search: savedSearchFromState(change.state) as Record<string, unknown> } : change, store)
}
/** Validate untrusted stored search before rebuilding through the current authority model. */
export function restoreSavedView(search: unknown, model: Model, entity: string, caps: Capabilities) {
  const object = !!search && typeof search === 'object' && !Array.isArray(search)
  const allowed = ['filters', 'sort', 'direction', 'view', 'rowAccess']
  const validated = object ? validateListSearch(Object.fromEntries(Object.entries(search).filter(([key]) => allowed.includes(key)))) : { invalidSettings: true }
  try {
    const restored = stateFromSearch(validated, model, entity, caps)
    return { search: searchFromState(restored.state), dropped: restored.dropped }
  } catch {
    // A malformed predicate must never take down the ordinary list.
    const restored = stateFromSearch({ invalidSettings: true }, model, entity, caps)
    return { search: searchFromState(restored.state), dropped: true }
  }
}
