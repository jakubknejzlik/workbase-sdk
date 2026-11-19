import { createContext, useContext } from 'react'
import type { Capabilities, Model } from './read'

/** Session-local authority observation; never persisted in list configuration or views. */
export interface ReferenceAuthorityState { actor?: string; observedAt: number }
export const ReferenceAuthority = createContext<ReferenceAuthorityState | undefined>(undefined)
export const useReferenceAuthority = () => useContext(ReferenceAuthority)
export const referenceScope = (model: Model, caps: Capabilities, orgId: string, target: string, authority?: ReferenceAuthorityState) =>
  [model.instance, model.revision, orgId, caps, target, model.entities[target], authority]

/** Identity of the scope a mounted list's state and data belong to. */
export interface ListOwner { instance: string; orgId: string; actor?: string }
export const ownerKey = (owner: ListOwner) => JSON.stringify([owner.instance, owner.orgId, owner.actor ?? null])
/** Drop cached rows, counts, totals and identity-bearing access data of a scope that is no longer current. */
export function teardownScope(client: import('@tanstack/react-query').QueryClient, owner: ListOwner) {
  const key = ownerKey(owner)
  client.removeQueries({ predicate: query => {
    const parts = query.queryKey as unknown[]
    if (parts[0] === 'data-table') return parts.at(-1) === key
    return ['row-access', 'row-access-delivery', 'account-link-members'].includes(parts[0] as string) && parts[1] === (owner.actor ?? null) && parts[2] === owner.orgId
  } })
}
