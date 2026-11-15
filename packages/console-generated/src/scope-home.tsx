import { createContext, useContext } from 'react'

interface ScopeMemberships { organizationsEnabled?: boolean; memberships: { organization_id: string }[] }
/** Recovery uses the only scope directly; multi-organization accounts keep the chooser. */
export function scopeHomeDestination(me?: ScopeMemberships, activeScope?: string): string {
  if (me?.memberships.length === 1) return `/o/${encodeURIComponent(me.memberships[0].organization_id)}`
  if (me?.organizationsEnabled === false) {
    const scope = activeScope ?? me.memberships[0]?.organization_id
    return scope ? `/o/${encodeURIComponent(scope)}` : '/'
  }
  return '/organizations'
}

export const ScopeHomeContext = createContext('/organizations')
export const useScopeHome = () => useContext(ScopeHomeContext)
