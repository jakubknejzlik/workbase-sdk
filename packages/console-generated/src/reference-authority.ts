import { createContext, useContext } from 'react'
import type { Capabilities, Model } from './read'

/** Session-local authority observation; never persisted in list configuration or views. */
export const ReferenceAuthority = createContext<string | undefined>(undefined)
export const useReferenceAuthority = () => useContext(ReferenceAuthority)
export const referenceScope = (model: Model, caps: Capabilities, orgId: string, target: string, authority?: string) =>
  [model.instance, model.revision, orgId, caps, target, model.entities[target], authority]
