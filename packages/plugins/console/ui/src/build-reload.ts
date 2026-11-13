declare const __WORKBASE_BUILD_SHA__: string
import type { ClientRequestInit } from './client'
export const buildSHA = typeof __WORKBASE_BUILD_SHA__ === 'string' ? __WORKBASE_BUILD_SHA__ : 'unbuilt'
const hex = (sha: unknown): sha is string => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha)
type Visibility = { visibilityState: string; addEventListener(event: string, listener: () => void): void; removeEventListener(event: string, listener: () => void): void }
type Options = { sha: string; fetch: (url: string, init: ClientRequestInit) => Promise<Response>; dirty: () => boolean; storage: Pick<Storage, 'getItem' | 'setItem'>; document: Visibility; reload: () => void }
/** One watcher per mounted instance. Only public deployment metadata crosses boots. */
export function watchBuild(options: Options) {
  let pending: string | undefined, stopped = false, fetching = false
  const controller = new AbortController(), transport = options.fetch
  function flush() {
    if (stopped || options.dirty() || !pending || !hex(options.sha)) return
    const key = 'workbase.reload.' + pending
    try {
      if (options.storage.getItem(key)) return
      // Persist before reloading. If storage is disabled, decline to risk a loop.
      options.storage.setItem(key, '1')
    } catch { return }
    options.reload()
  }
  async function check() {
    if (fetching || stopped) return
    fetching = true
    try {
      const response = await transport('/build.json', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (!response.ok) return
      const value = await response.json() as { sha?: unknown }
      if (stopped) return
      pending = hex(value.sha) && value.sha.toLowerCase() !== options.sha.toLowerCase() ? value.sha.toLowerCase() : undefined
      flush()
    } catch { /* A metadata outage must never block authentication or the app. */ }
    finally { fetching = false }
  }
  const visible = () => { if (options.document.visibilityState === 'visible') void check() }
  options.document.addEventListener('visibilitychange', visible)
  void check()
  return { flush, stop() { stopped = true; controller.abort(); options.document.removeEventListener('visibilitychange', visible) } }
}

const browser = globalThis as typeof globalThis & { document: Visibility; location: { reload(): void } }
export function browserBuild(fetch: Options['fetch'], dirty: Options['dirty']) {
  return watchBuild({ sha: buildSHA, fetch, dirty, document: browser.document,
    storage: { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value) }, reload: () => browser.location.reload() })
}
