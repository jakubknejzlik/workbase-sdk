import type { RuntimeEnv } from './types'
import { ApiError } from './errors'
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Dev credentials require the real request boundary, never just a copied baseURL.
 * Forwarded headers are deliberately not trusted. Browser requests must also be same-origin. */
export function devLocalIdentityEnabled(env: RuntimeEnv, request?: Request): boolean {
  return !!env.IDENTITY?.localPassword && !!request && loopbackIdentityRequest(request)
}
function loopbackIdentityRequest(request: Request): boolean {
  const url = new URL(request.url)
  if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname)) return false
  const host = request.headers.get('host')
  const origin = request.headers.get('origin')
  return (!host || host.toLowerCase() === url.host) && (!origin || origin === url.origin)
}
/** Inspect the actual URL before reading credentials. Never trust Forwarded headers. */
export function assertIdentityTransport(request: Request, status: 401 | 403 = 401): void {
  if (new URL(request.url).protocol === 'https:' || loopbackIdentityRequest(request)) return
  throw new ApiError(status, 'insecure_identity_transport')
}
/** SST injects flat bindings. The object form is for in-process adapters/tests. */
export function identityEnvironment(env: RuntimeEnv): RuntimeEnv {
  if (env.IDENTITY) {
    const settings = env.IDENTITY
    const origin = new URL(settings.baseURL)
    const loopback = loopbackHosts.has(origin.hostname)
    // HTTP is permitted only for loopback development; cookies remain Secure even there.
    if (origin.origin !== settings.baseURL || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) throw new ApiError(503, 'invalid_identity_origin')
    if (settings.localPassword && !loopback) throw new ApiError(503, 'dev_identity_requires_loopback')
    if (settings.oidc) {
      const issuer = new URL(settings.oidc.issuer)
      if (issuer.username || issuer.password || issuer.search || issuer.hash || (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && loopbackHosts.has(issuer.hostname)))) throw new ApiError(503, 'invalid_oidc_issuer')
    }
    return env
  }
  if (!env.AUTH_BASE_URL && !env.BETTER_AUTH_SECRET) return env
  if (!env.AUTH_BASE_URL || !env.BETTER_AUTH_SECRET) throw new ApiError(503, 'identity_not_configured')
  const oidcValues = [env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET]
  if (oidcValues.some(Boolean) && !oidcValues.every(Boolean)) throw new ApiError(503, 'oidc_not_configured')
  return identityEnvironment({ ...env, IDENTITY: { baseURL: env.AUTH_BASE_URL, secret: env.BETTER_AUTH_SECRET, localPassword: env.DEV_LOCAL_IDENTITY === 'true',
    ...(env.OIDC_ISSUER ? { oidc: { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID!, clientSecret: env.OIDC_CLIENT_SECRET! } } : {}) } })
}
