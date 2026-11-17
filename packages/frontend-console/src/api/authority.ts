export { parseCapabilities as parseConsoleCapabilities } from '@workbasehq/core/console-page'
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { discardTransportScope } from './client'

const states = new WeakMap<QueryClient, Map<string, number>>()
const listeners = new WeakMap<QueryClient, Set<() => void>>()
export const authorityGeneration = (client: QueryClient, org: string) => states.get(client)?.get(org) ?? 0
/** Keep asynchronous actions bound to the authority they started under. */
export function authorityGuard(client: QueryClient, org: string) {
  const generation = authorityGeneration(client, org)
  return () => {
    if (generation !== authorityGeneration(client, org)) throw new DOMException('Superseded authority', 'AbortError')
  }
}
export function useAuthorityGeneration(client: QueryClient, org: string) {
  return useSyncExternalStore(listener => {
    let set = listeners.get(client); if (!set) listeners.set(client, set = new Set())
    set.add(listener); return () => { set.delete(listener) }
  }, () => authorityGeneration(client, org))
}
// Account/public metadata and the in-flight authority reads survive; all private
// row/widget/command caches (including inactive queries for other orgs) are dropped.
const retained = new Set(['me', 'profile', 'instance', 'build', 'capabilities', 'console-model'])
export function discardAuthority(client: QueryClient, org: string) {
  let scopes = states.get(client); if (!scopes) states.set(client, scopes = new Map())
  scopes.set(org, authorityGeneration(client, org) + 1)
  discardTransportScope(org)
  const privateQuery = { predicate: (query: { queryKey: readonly unknown[] }) => !retained.has(String(query.queryKey[0])) }
  void client.cancelQueries(privateQuery)
  client.removeQueries(privateQuery)
  for (const listener of listeners.get(client) ?? []) listener()
}
/** Revision alone is build metadata, not an authority change. */
export function authorityKey(caps: object): string {
  const { revision: _revision, ...authority } = caps as { revision?: number }
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])])) : value
  return JSON.stringify(stable(authority))
}
