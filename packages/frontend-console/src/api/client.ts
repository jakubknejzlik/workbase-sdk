import type { QueryClient } from '@tanstack/react-query'

export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) { super(code) }
}
/** Only console-local paths can become a post-authentication destination. */
export function safeReturnTo(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\u0000-\u0020]/.test(value)) return fallback
  // Explicit invitation returns use only the recipient-authorized opaque ID.
  if (/^\/invitation\?id=[A-Za-z0-9_-]+$/.test(value)) return value
  try {
    const url = new URL(value, 'https://console.invalid')
    if (url.origin !== 'https://console.invalid' || /%2f|%5c/i.test(value) || !/^\/(organizations|settings(?:\/profile)?|o\/[^/]+(?:\/.*)?)?(?:\/)?$/.test(url.pathname)) return fallback
    return url.pathname + url.search + url.hash
  } catch { return fallback }
}
export function signInLocation(returnTo = window.location.pathname + window.location.search) {
  return '/sign-in?returnTo=' + encodeURIComponent(safeReturnTo(returnTo))
}
// Keep this set until the document unloads: late reads can finish after assign().
let loggingOut = false
export async function logoutSession(client: QueryClient): Promise<void> {
  loggingOut = true
  try {
    await client.cancelQueries()
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch (error) {
      // An expired session is already signed out; finish the same cache/navigation cleanup.
      if (!(error instanceof ApiError && error.status === 401)) throw error
    }
    window.location.assign('/sign-in')
    client.clear()
  } catch (error) {
    loggingOut = false
    throw error
  }
}
const scopes = new Map<string, AbortController>()
export function discardTransportScope(org: string) {
  scopes.get(org)?.abort(); scopes.set(org, new AbortController())
}
export async function api<T>(path: string, options: { method?: string; body?: unknown; orgId?: string; redirect401?: boolean; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  const org = options.orgId ?? /^\/o\/([^/]+)\//.exec(path)?.[1]
  if (org && !scopes.has(org)) scopes.set(org, new AbortController())
  const signal = AbortSignal.any([...(org ? [scopes.get(org)!.signal] : []), ...(options.signal ? [options.signal] : [])])
  signal.throwIfAborted()
  const method = options.method ?? 'GET'
  const mutation = !['GET', 'HEAD'].includes(method)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  if (options.orgId) headers['X-Organization-Id'] = options.orgId
  if (mutation) Object.assign(headers, { Origin: window.location.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' })
  // Browsers supply the forbidden Origin/Sec-Fetch-Site headers themselves; declaring them
  // here also preserves the contract for fetch adapters. Same-origin credentials are explicit.
  const response = await fetch(path, { signal, method, credentials: 'same-origin', headers, ...(mutation ? { body: JSON.stringify(options.body ?? {}) } : {}) })
  signal.throwIfAborted()
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string }
    signal.throwIfAborted()
    if (response.status === 401 && options.redirect401 !== false && !loggingOut) window.location.assign(signInLocation())
    throw new ApiError(response.status, data.error ?? data.code ?? 'request_failed', data)
  }
  const value = response.status === 204 ? undefined as T : await response.json() as T
  signal.throwIfAborted()
  return value
}
