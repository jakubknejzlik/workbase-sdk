import { createContext, useContext, useEffect, useRef } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { Capabilities, Model } from './read'

/** Session-local authority observation; never persisted in list configuration or views. */
export interface ReferenceAuthorityState { actor?: string; observedAt: number }
export const ReferenceAuthority = createContext<ReferenceAuthorityState | undefined>(undefined)
export const useReferenceAuthority = () => useContext(ReferenceAuthority)
export const referenceScope = (model: Model, caps: Capabilities, orgId: string, target: string, authority?: ReferenceAuthorityState) =>
  [model.instance, model.revision, orgId, caps, target, model.entities[target], authority]

/** Identity of the scope a mounted list's state and data belong to. */
export interface ListOwner { instance?: string; orgId: string; actor?: string }
export const ownerKey = (owner: ListOwner) => JSON.stringify([owner.instance ?? null, owner.orgId, owner.actor ?? null])
/** Drop cached rows, counts, totals and identity-bearing access data of an org/actor that is no longer current. */
export function teardownScope(client: QueryClient, owner: ListOwner) {
  const actor = owner.actor ?? null
  client.removeQueries({ predicate: query => {
    const parts = query.queryKey as unknown[]
    if (parts[0] === 'data-table') {
      try { const [instance, orgId, queryActor] = JSON.parse(String(parts.at(-1))) as [unknown, unknown, unknown]; return (owner.instance === undefined || instance === owner.instance) && orgId === owner.orgId && queryActor === actor } catch { return false }
    }
    return ['row-access', 'row-access-delivery', 'account-link-members'].includes(parts[0] as string) && parts[1] === actor && parts[2] === owner.orgId
  } })
}
/** For hosts that remount by key: the replaced org/actor's data is purged, while an actor merely being established is not a change. */
export function useScopeTeardown(client: QueryClient, owner: Pick<ListOwner, 'orgId' | 'actor'>) {
  // The last verified actor is remembered across a transient gap: A -> unknown -> B is still a replacement.
  const known = useRef(owner)
  useEffect(() => {
    const before = known.current
    const changed = before.orgId !== owner.orgId || owner.actor !== undefined && before.actor !== undefined && owner.actor !== before.actor
    if (changed) teardownScope(client, before)
    known.current = { orgId: owner.orgId, actor: owner.actor ?? (changed ? undefined : before.actor) }
  }, [owner.orgId, owner.actor])
}
