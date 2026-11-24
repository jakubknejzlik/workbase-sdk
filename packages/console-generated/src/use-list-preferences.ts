import { useEffect, useRef, useState } from 'react'
import type { SavedViewsScope } from './saved-views'
import { listPreferencesKey, loadListPreferences, normalizeListPreferences, onListPreferencesCleared, saveListPreferences, type ListDisplayConfig, type ListPreferences } from './list-preferences'

/** Presentation only. The verified host scope is shared with D7, never its storage or list state. */
export function useListPreferences(scope: SavedViewsScope | undefined, entity: string, config: ListDisplayConfig) {
  const identity = JSON.stringify([scope ? listPreferencesKey(scope, entity) : null, config])
  const load = () => ({ identity, ...(scope ? loadListPreferences(scope, entity, config) : { preferences: normalizeListPreferences(null, config), stored: false }), active: true })
  const [state, setState] = useState(load)
  const current = state.identity === identity ? state : load()
  if (current !== state) setState(current)
  const owner = useRef(current)
  owner.current = current
  useEffect(() => {
    // Commit normalized preferences so removed/unreadable IDs cannot return after a capability change.
    if (scope && current.stored && current.active) saveListPreferences(scope, entity, current.preferences)
    return onListPreferencesCleared(account => {
      if (scope && account.instance === scope.instance && account.userId === scope.userId) {
        const latest = owner.current
        if (latest.identity !== identity) return
        latest.active = false // Invalidate already captured callbacks synchronously.
        setState({ ...latest, preferences: normalizeListPreferences(null, config), stored: false, active: false })
      }
    })
  }, [identity])
  const change = (value: ListPreferences | null) => {
    if (owner.current !== current || !current.active) return
    const preferences = normalizeListPreferences(value, config)
    if (scope) saveListPreferences(scope, entity, value ? preferences : null)
    setState({ ...current, preferences, stored: value !== null })
  }
  return {
    visible: (id: string) => current.preferences.visible.includes(id),
    compact: current.preferences.density === 'compact',
    toggle: (id: string, visible: boolean) => change({ ...current.preferences, visible: visible ? [...current.preferences.visible, id] : current.preferences.visible.filter(column => column !== id) }),
    setCompact: (compact: boolean) => change({ ...current.preferences, density: compact ? 'compact' : 'default' }),
    reset: () => change(null),
  }
}
