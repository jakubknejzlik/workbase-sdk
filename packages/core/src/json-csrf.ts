import { getCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'
import { SESSION_COOKIE } from './session-contract'
import type { AppEnv, RuntimeEnv } from './types'
import { assertIdentityTransport } from './identity-settings'
import { ApiError } from './errors'

/** Bearer takes precedence in Better Auth. Invalid Bearers must not fall back to cookies. */
export function jsonCookieCSRF(env: RuntimeEnv): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && getCookie(c, SESSION_COOKIE)) {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)) assertIdentityTransport(c.req.raw, c.req.path.startsWith('/auth/') ? 403 : 401)
      const authorization = c.req.header('Authorization')
      if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim()) {
        const allowed = env.IDENTITY?.baseURL ?? env.AUTH_BASE_URL ?? new URL(c.req.url).origin
        if (c.req.header('Origin') !== allowed || c.req.header('Sec-Fetch-Site') !== 'same-origin' ||
          c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(403, 'csrf_failed')
      }
    }
    await next()
  }
}
