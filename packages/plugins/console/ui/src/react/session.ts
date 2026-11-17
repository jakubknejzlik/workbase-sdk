import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { ApiFailure, canonicalJSON } from '../client'
import { parseCapabilities, type Capabilities } from '../gate'
import { ConsoleProvider, type ProviderProps } from './index'
class RemovedMembership extends Error {}
type ActorDocument = { actor: { id: string }; memberships: { organization_id: string }[] }
function parseActor(value: unknown): ActorDocument {
  const actor = value as Partial<ActorDocument> | null
  if (!actor || typeof actor.actor?.id !== 'string' || !Array.isArray(actor.memberships) || !actor.memberships.every(m => m && typeof m.organization_id === 'string')) throw new Error('Invalid session')
  return actor as ActorDocument
}
export type SessionState = { kind: 'loading' | 'unauthenticated' | 'removed' | 'failed' } | { kind: 'ready'; actorId: string; caps: Capabilities }
type Props = Omit<ProviderProps, 'identity' | 'caps' | 'onAuthorizationFailure'> & { orgId: string; timeoutMs?: number; onState?: (kind: SessionState['kind']) => void }
const environment = globalThis as typeof globalThis & { document?: { visibilityState: string; addEventListener(event: string, fn: () => void): void; removeEventListener(event: string, fn: () => void): void } }
/** Only a successful parallel boot may mount any data observer or navigation. */
export function Session({ orgId, timeoutMs = 10000, onState, ...props }: Props) {
  const transport = props.fetch ?? globalThis.fetch, baseURL = props.baseURL ?? ''
  const scope = canonicalJSON([baseURL, orgId]), generation = useRef(0), controller = useRef<AbortController | null>(null)
  // Session owns this latch so dropping the provider and both caches cannot rearm it.
  const recovery = useRef<{ scope: string; attempted: boolean } | null>(null)
  const [snapshot, setSnapshot] = useState<{ scope: string; state: SessionState }>({ scope, state: { kind: 'loading' } })
  const publish = useCallback((state: SessionState) => setSnapshot({ scope, state }), [scope])
  const refresh = useCallback(async (drop: boolean) => {
    const ticket = ++generation.current
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort
    if (drop) publish({ kind: 'loading' })
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectTerminal: (error: unknown) => void = () => {}
    const terminal = new Promise<never>((_, reject) => { rejectTerminal = reject })
    async function get(path: string) {
      const response = await transport(baseURL.replace(/\/$/, '') + path, { signal: abort.signal, credentials: 'same-origin', cache: 'no-store', headers: { 'X-Organization-Id': orgId } })
      if (!response.ok) {
        const error = new ApiFailure(response.status, 'session')
        if (response.status === 401) rejectTerminal(error)
        throw error
      }
      const value = await response.json()
      if (path === '/me') {
        const actor = parseActor(value)
        if (!actor.memberships.some(m => m.organization_id === orgId)) rejectTerminal(new RemovedMembership())
        return actor
      }
      return value
    }
    try {
      const [meResult, capsResult] = await Promise.race([
        Promise.allSettled([get('/me'), get('/o/' + encodeURIComponent(orgId) + '/capabilities')]),
        terminal,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Session timeout')), timeoutMs) }),
      ])
      if (ticket !== generation.current) return
      for (const result of [meResult, capsResult]) if (result.status === 'rejected' && result.reason instanceof ApiFailure && result.reason.status === 401) throw result.reason
      if (meResult.status === 'rejected') throw meResult.reason
      const actor = parseActor(meResult.value)
      if (!actor.memberships.some(m => m.organization_id === orgId)) { publish({ kind: 'removed' }); return }
      if (capsResult.status === 'rejected') throw capsResult.reason
      const caps = parseCapabilities(capsResult.value)
      const readyScope = canonicalJSON([baseURL, actor.actor.id, orgId, caps])
      if (recovery.current?.scope !== readyScope) recovery.current = { scope: readyScope, attempted: false }
      publish({ kind: 'ready', actorId: actor.actor.id, caps })
    } catch (error) {
      if (ticket === generation.current) publish({ kind: error instanceof RemovedMembership ? 'removed' : error instanceof ApiFailure && error.status === 401 ? 'unauthenticated' : 'failed' })
    } finally { clearTimeout(timer); abort.abort() }
  }, [transport, baseURL, orgId, timeoutMs, publish])
  useEffect(() => {
    void refresh(true)
    const visible = () => { if (environment.document?.visibilityState === 'visible') void refresh(false) }
    environment.document?.addEventListener('visibilitychange', visible)
    return () => { generation.current++; controller.current?.abort(); environment.document?.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  const state = snapshot.scope === scope ? snapshot.state : { kind: 'loading' as const }
  useEffect(() => { onState?.(state.kind) }, [onState, state.kind])
  const readyScope = state.kind === 'ready' ? canonicalJSON([baseURL, state.actorId, orgId, state.caps]) : null
  const authorizationFailure = useCallback((status: 401 | 403) => {
    if (status === 403) {
      if (!recovery.current || recovery.current.scope !== readyScope || recovery.current.attempted) return
      recovery.current.attempted = true
      void refresh(true)
    }
    else { generation.current++; controller.current?.abort(); publish({ kind: 'unauthenticated' }) }
  }, [refresh, publish, readyScope])
  if (state.kind === 'ready') return h(ConsoleProvider, { ...props, caps: state.caps, identity: { actorId: state.actorId, orgId }, onAuthorizationFailure: authorizationFailure }, props.children)
  return h('div', { role: state.kind === 'loading' ? 'status' : 'alert' }, props.t('sdk:' + state.kind), state.kind === 'failed' && h('button', { type: 'button', onClick: () => { recovery.current = null; void refresh(true) } }, props.t('sdk:retry')))
}
