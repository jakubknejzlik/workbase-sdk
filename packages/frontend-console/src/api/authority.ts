import { actionContext, type ActionContext } from '../../../console-generated/src/action-context'
export type { ActionContext } from '../../../console-generated/src/action-context'
export { parseCapabilities as parseConsoleCapabilities } from '@workbasehq/core/console-page'
import { useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { discardTransportScope } from './client'

const states = new WeakMap<QueryClient, Map<string, number>>()
const epochs = new WeakMap<QueryClient, number>()
const listeners = new WeakMap<QueryClient, Set<() => void>>()
export const authorityGeneration = (client: QueryClient, org: string) => states.get(client)?.get(org) ?? 0
/** Keep asynchronous actions bound to the authority they started under. */
export function authorityGuard(client: QueryClient, org: string) {
  const generation = authorityGeneration(client, org)
  return () => {
    if (generation !== authorityGeneration(client, org)) throw new DOMException('Superseded authority', 'AbortError')
  }
}
const actions = new WeakMap<QueryClient, Set<{ org?: string; controller: AbortController }>>()
/** One context owns the entire action, including error and completion continuations.
 * Account actions retire on any scope change; organization actions on their own.
 * run checks both sides of an async boundary, even for adapters ignoring abort. */
export async function runAuthorityAction<T>(client: QueryClient, org: string | undefined, action: (ctx: ActionContext) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const generation = org === undefined ? epochs.get(client) ?? 0 : authorityGeneration(client, org)
  let active = actions.get(client); if (!active) actions.set(client, active = new Set())
  const entry = { org, controller }; active.add(entry)
  const assertCurrent = () => {
    const current = org === undefined ? epochs.get(client) ?? 0 : authorityGeneration(client, org)
    if (current !== generation) controller.abort(new DOMException('Superseded authority', 'AbortError'))
    controller.signal.throwIfAborted()
  }
  const ctx = actionContext(controller.signal, assertCurrent)
  try { return await ctx.run(() => action(ctx)) } finally { active.delete(entry) }
}
export function useAuthorityAction(org?: string) {
  const client = useQueryClient()
  return <T,>(action: (ctx: ActionContext) => Promise<T>) => runAuthorityAction(client, org, action)
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
  epochs.set(client, (epochs.get(client) ?? 0) + 1)
  for (const entry of actions.get(client) ?? []) if (!entry.org || entry.org === org) entry.controller.abort(new DOMException('Superseded authority', 'AbortError'))
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
