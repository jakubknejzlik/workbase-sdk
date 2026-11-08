import { getCookie, setCookie } from 'hono/cookie'
import type { AppContext } from './types'
import { SESSION_COOKIE } from './session-contract'
import { equalHash, randomToken } from './crypto'
import { ApiError } from './errors'
import { assertIdentityTransport } from './identity-settings'

const LOGIN_CSRF_COOKIE = '__Host-workbase.csrf'
/** Credentials crossing the browser adapter are cookies only, never a forwarded Bearer. */
export function browserRequest(c: AppContext) {
  const headers = new Headers(c.req.raw.headers)
  headers.delete('Authorization')
  headers.delete('X-Organization-Id')
  return new Request(c.req.url, { headers })
}
export async function csrfToken(c: AppContext, secret: string) {
  const session = getCookie(c, SESSION_COOKIE)
  if (!session) {
    let token = getCookie(c, LOGIN_CSRF_COOKIE)
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      token = randomToken()
      setCookie(c, LOGIN_CSRF_COOKIE, token, { secure: true, httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600 })
    }
    return token
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`workbase.admin.csrf\0${session}`))
  return [...new Uint8Array(signed)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export async function adminForm(c: AppContext, secret: string) {
  // Check provenance before credentials/body. Forwarded headers are never an authority.
  const origin = c.req.header('Origin')
  const site = c.req.header('Sec-Fetch-Site')
  if ((origin && origin !== new URL(c.req.url).origin) || (site && site !== 'same-origin') || (!origin && site !== 'same-origin')) throw new ApiError(403, 'csrf_failed')
  assertIdentityTransport(c.req.raw, 403)
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new ApiError(403, 'csrf_failed')
  const form = new URLSearchParams(new TextDecoder().decode(await c.req.arrayBuffer()))
  const submitted = form.get('_csrf') ?? ''
  // No token issuance on POST: login requires the cookie issued by GET /admin/login.
  if (!getCookie(c, SESSION_COOKIE) && !/^[a-f0-9]{64}$/.test(getCookie(c, LOGIN_CSRF_COOKIE) ?? '')) throw new ApiError(403, 'csrf_failed')
  if (!submitted || !equalHash(submitted, await csrfToken(c, secret))) throw new ApiError(403, 'csrf_failed')
  return form
}
export function isLoopbackDev(request: Request, stage?: string) {
  const url = new URL(request.url)
  const host = request.headers.get('host')
  return (!stage || stage === 'local') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && (!host || host === url.host)
}

/** Random form keys are signed with the session CSRF token, never a public session ID. */
async function submissionSignature(csrf: string, nonce: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(csrf), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`workbase.admin.command\0${nonce}`))
  return [...new Uint8Array(signed)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export async function submissionKey(csrf: string) {
  const nonce = randomToken().slice(0, 32)
  return `${nonce}.${await submissionSignature(csrf, nonce)}`
}
export async function verifySubmissionKey(csrf: string, key: string) {
  if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(key) || !equalHash(key.slice(33), await submissionSignature(csrf, key.slice(0, 32)))) throw new ApiError(403, 'csrf_failed')
  return key
}
