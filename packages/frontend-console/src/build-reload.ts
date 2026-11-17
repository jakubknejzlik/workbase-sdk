import { getMutationSafetySnapshot, subscribeMutationSafety, type MutationSafetySnapshot } from '@workbasehq/ui'

interface BuildObservation { sha?: string }
interface ReloadDependencies {
  safety: () => MutationSafetySnapshot
  subscribe: (listener: () => void) => () => void
  readBuild: () => Promise<BuildObservation | undefined>
  reload: () => void
  storage: () => Pick<Storage, 'getItem' | 'setItem'>
  storageKey: string
  navigationSettled: () => boolean
  defer: (callback: () => void) => () => void
}
const buildId = (value: unknown) => typeof value === 'string' && value.trim() && value.trim() !== 'unbuilt' ? value.trim() : undefined

/** Document-owned state, deliberately independent of query caches and route lifetime. */
export function createBuildReloadCoordinator(deps: ReloadDependencies) {
  let baseline: string | undefined
  let pending: string | undefined
  let cancelDrain: (() => void) | undefined
  let mounted = false
  let reading: Promise<void> | undefined
  const attempted = new Set<string>() // Synchronous latch, also works without storage.
  const reconcileAttempts = () => {
    try {
      const stored: unknown = JSON.parse(deps.storage().getItem(deps.storageKey) ?? '[]')
      if (Array.isArray(stored)) for (const sha of stored) { const id = buildId(sha); if (id) attempted.add(id) }
    } catch { /* Storage can be unavailable or contain an invalid record. */ }
  }
  const recheck = () => {
    if (!mounted || cancelDrain) return
    cancelDrain = deps.defer(() => {
      cancelDrain = undefined
      const safety = deps.safety()
      if (!pending || safety.dirty || safety.submitting || !deps.navigationSettled()) return
      reconcileAttempts()
      const target = pending
      pending = undefined
      if (attempted.has(target)) return
      attempted.add(target)
      try { deps.storage().setItem(deps.storageKey, JSON.stringify([...attempted])) } catch { /* In-memory latch remains active. */ }
      deps.reload()
    })
  }
  const observe = (build: BuildObservation | null | undefined) => {
    const sha = buildId(build?.sha)
    if (!sha) return
    if (!baseline) baseline = sha
    else pending = sha === baseline ? undefined : sha
    recheck()
  }
  const refresh = () => {
    if (!reading) reading = (async () => {
      try { observe(await deps.readBuild()) } catch { /* Failed metadata reads are not observations. */ }
    })().finally(() => { reading = undefined })
    return reading
  }
  return {
    observe, refresh, recheck,
    mount: () => {
      mounted = true; reconcileAttempts()
      const unsubscribe = deps.subscribe(recheck)
      recheck()
      return () => { mounted = false; unsubscribe(); cancelDrain?.(); cancelDrain = undefined }
    },
    pageShow: (event: Pick<PageTransitionEvent, 'persisted'>) => {
      if (!event.persisted) return
      reconcileAttempts(); recheck(); void refresh()
    },
  }
}

let navigationSettled = () => true

// Two tasks allow React's commit and accepted router/back navigation to start.
// The final read also checks the router; its settled notification retries the drain.
export const buildReload = createBuildReloadCoordinator({
  safety: getMutationSafetySnapshot,
  subscribe: subscribeMutationSafety,
  readBuild: async () => {
    const response = await fetch('/build.json', { cache: 'no-store' })
    if (!response.ok) return
    return response.json()
  },
  reload: () => window.location.reload(),
  storage: () => window.sessionStorage,
  storageKey: 'workbase:frontend-console:reload-attempted-shas',
  navigationSettled: () => navigationSettled(),
  defer: callback => {
    let timer = setTimeout(() => { timer = setTimeout(callback, 0) }, 0)
    return () => clearTimeout(timer)
  },
})
/** Installed by the single persistent root host. */
export function setReloadNavigationCheck(check: () => boolean) { navigationSettled = check }
