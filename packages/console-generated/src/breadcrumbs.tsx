import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { displayName, recordLabel, type Capabilities, type Model } from './read'

export interface RecordBreadcrumbState {
  orgId: string
  entity: string
  id: string
  status: 'pending' | 'ready' | 'unavailable'
  label?: string
}
type Kind = 'detail' | 'edit'
type PublishedState = RecordBreadcrumbState & { owner: symbol }
type BreadcrumbState = Partial<Record<Kind, PublishedState>>
type Publish = (kind: Kind, owner: symbol, state?: RecordBreadcrumbState) => void
const StateContext = createContext<BreadcrumbState>({})
const PublishContext = createContext<Publish>(() => {})

/** Only presentation state is published. The page remains the sole query owner. */
export function RecordBreadcrumbProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BreadcrumbState>({})
  const publish = useCallback<Publish>((kind, owner, next) => setState(previous => {
    if (!next && previous[kind]?.owner !== owner) return previous
    return { ...previous, [kind]: next ? { ...next, owner } : undefined }
  }), [])
  return <PublishContext.Provider value={publish}><StateContext.Provider value={state}>{children}</StateContext.Provider></PublishContext.Provider>
}

export const useRecordBreadcrumbs = () => useContext(StateContext)

/** Layout effects clear the previous record before a route or grant change paints. */
export function usePublishRecordBreadcrumb(state: RecordBreadcrumbState | undefined, kind: Kind = 'detail') {
  const publish = useContext(PublishContext)
  const owner = useMemo(() => Symbol('record-breadcrumb'), [])
  const { orgId, entity, id, status, label } = state ?? {}
  useLayoutEffect(() => {
    if (orgId && entity && id && status) publish(kind, owner, { orgId, entity, id, status, label })
    return () => publish(kind, owner)
  }, [publish, owner, kind, orgId, entity, id, status, label])
}

/** SR-64's short-ID exception applies only to an authorized, loaded record. */
export function breadcrumbRecordLabel(model: Model, entity: string, row: Record<string, any>, caps: Capabilities, locale: string, t: (key: string, options?: any) => string) {
  const grant = caps.entities[entity]
  if (!grant?.operations.includes('read') || !grant.readable.includes('id')) return ''
  return displayName(model.entities[entity], row, grant)
    ? recordLabel(model, entity, row, caps, locale, t)
    : String(row.id ?? '').slice(-8)
}
