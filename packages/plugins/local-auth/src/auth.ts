import { authenticateIssuedSession } from './session-authentication'
import { z } from 'zod'
import type { App, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig } from '@workbasehq/core/config'
import { randomToken, sha256 } from '@workbasehq/core/crypto'
import { identityProviders, LocalIdentityProvider } from './identity-providers'
import { createIdentityAuth } from './better-auth'
import { identityWrite } from '../../../core/src/identity-writes'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { ApiError } from '../../../core/src/errors'
import { assertIdentityTransport, devLocalIdentityEnabled, identityEnvironment } from '../../../core/src/identity-settings'
export function authRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const kernel = kernelFor(config)
  app.use('/auth/*', async (c, next) => {
    assertIdentityTransport(c.req.raw, 403)
    if (c.req.path === '/auth/get-session' || (c.req.path !== '/auth/providers' && (c.req.header('Authorization') || c.req.header('Cookie')?.includes('__Host-workbase.session=')))) {
      let actor
      try { actor = await kernel.authenticate(c.req.raw, env) }
      catch (error) {
        // An expired browser cookie may recover through login/callback flows.
        // Null claims and ambiguous claims still deny, as do explicit bearers.
        const recovery = ['/auth/register', '/auth/error', '/auth/login', '/auth/sign-in/magic-link', '/auth/magic-link/verify', '/auth/sign-in/social', '/auth/callback/oidc'].includes(c.req.path)
        if (!recovery || !(error instanceof ApiError) || error.code !== 'unauthenticated' || c.req.header('Authorization')) throw error
        await next(); return
      }
      if (!actor) throw new ApiError(401, 'unauthenticated')
    }
    await next()
  })
  app.get('/auth/providers', c => c.json({ providers: [...identityProviders(env, config, c.req.raw).map(provider => ({ id: provider.id })), ...(identityEnvironment(env).IDENTITY?.oidc ? [{ id: 'oidc' }] : [])] }))
  // Compatibility PBKDF2 provider is an explicitly enabled dev/test facility only.
  app.post('/auth/login', async c => {
    if (!devLocalIdentityEnabled(env, c.req.raw)) throw new ApiError(404, 'provider_not_enabled')
    const { userId } = await new LocalIdentityProvider(env, c.req.raw).authenticate(await c.req.json())
    const token = randomToken(); const expires = new Date(Date.now() + 7 * 86400000).toISOString()
    await identityWrite(env, config, 'dev_session_created', [{ sql: 'INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', bindings: [await sha256(token), userId, expires], expectRows: 1 }], userId)
    await kernel.requireActor(new Request(c.req.url, { headers: { Authorization: `Bearer ${token}` } }), env)
    return c.json({ token, expires_at: expires })
  })
  app.post('/auth/logout', async c => {
    const resolved = await kernel.requireActor(c.req.raw, env)
    if (!resolved.user) throw new ApiError(403, 'user_required')
    const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
    if (devLocalIdentityEnabled(env, c.req.raw) && token) await identityWrite(env, config, 'dev_session_revoked', [{ sql: 'DELETE FROM sessions WHERE token_hash=?', bindings: [await sha256(token)] }], resolved.user.id)
    const response = await createIdentityAuth(env, config, false, false).handler(new Request(new URL('/auth/sign-out', c.req.url), { method: 'POST', headers: c.req.raw.headers }))
    if (!response.ok) return response
    const headers = new Headers(response.headers)
    return new Response(null, { status: 204, headers })
  })
  app.post('/auth/revoke-all', async c => {
    const actor = await kernel.requireActor(c.req.raw, env)
    if (!actor.user) throw new ApiError(403, 'user_required')
    // Better Auth owns its table; compatibility sessions are removed by the atomic adapter.
    const response = await createIdentityAuth(env, config, false, false).handler(new Request(new URL('/auth/revoke-sessions', c.req.url), { method: 'POST', headers: c.req.raw.headers }))
    const devLocal = devLocalIdentityEnabled(env, c.req.raw)
    if (response.status >= 400 && !devLocal) return response
    if (devLocal) await identityWrite(env, config, 'dev_sessions_revoked', [{ sql: 'DELETE FROM sessions WHERE user_id=?', bindings: [actor.user.id] }], actor.user.id)
    return c.body(null, 204)
  })
  app.post('/auth/link', async c => {
    const actor = await kernel.requireActor(c.req.raw, env)
    if (!actor.user) throw new ApiError(403, 'user_required')
    const auth = createIdentityAuth(env, config)
    const session = await createIdentityAuth(env, config, false, false).api.getSession({ headers: c.req.raw.headers })
    if (!session?.user.emailVerified) throw new ApiError(403, 'verified_session_required')
    const { provider } = z.strictObject({ provider: z.literal('oidc') }).parse(await c.req.json())
    const response = await auth.handler(new Request(new URL('/auth/link-social', c.req.url), { method: 'POST', headers: c.req.raw.headers,
      body: JSON.stringify({ provider, callbackURL: '/me', errorCallbackURL: '/auth/error', disableRedirect: true }) }))
    if (!response.ok) return response
    const { url } = await response.clone().json() as { url: string }
    const state = new URL(url).searchParams.get('state')!
    await identityWrite(env, config, 'link_started', [{ sql: 'INSERT INTO identity_link_grants (state_hash,user_id,session_id,expires_at) VALUES (?,?,?,?)',
      bindings: [await sha256(state), actor.user.id, session.session.id, new Date(Date.now() + 600000).toISOString()], expectRows: 1 }], actor.user.id)
    return response
  })
  app.all('/auth/*', async (c, next) => {
    // Keep the product surface small: profile changes, arbitrary linking, ID-token login and unlinking are not exposed.
    const path = c.req.path.slice('/auth'.length)
    if (path === '/register' && kernel.providers.has('members')) return next()
    if (!['/sign-in/magic-link', '/magic-link/verify', '/sign-in/social', '/callback/oidc', '/get-session', '/error'].includes(path)) throw new ApiError(404, 'not_found')
    let explicit = false
    let confirmation: Awaited<ReturnType<typeof kernel.requireActor>> | undefined
    if (path === '/callback/oidc') {
      const state = c.req.query('state')
      if (!state) throw new ApiError(400, 'invalid_state')
      const stateHash = await sha256(state)
      const grant = await env.DB.prepare('SELECT user_id,session_id,expires_at FROM identity_link_grants WHERE state_hash=?').bind(stateHash).first<{ user_id: string; session_id: string; expires_at: string }>()
      if (grant) {
        const current = await createIdentityAuth(env, config, false, false).api.getSession({ headers: c.req.raw.headers })
        if (!current || current.user.id !== grant.user_id || current.session.id !== grant.session_id || grant.expires_at <= new Date().toISOString()) throw new ApiError(400, 'invalid_state')
        await identityWrite(env, config, 'link_consumed', [{ sql: 'DELETE FROM identity_link_grants WHERE state_hash=? AND expires_at>?', bindings: [stateHash, new Date().toISOString()], expectRows: 1 }], current.user.id)
        confirmation = await kernel.requireActor(c.req.raw, env)
        explicit = true
      }
    }
    // Only server-selected provider/code flows are accepted. Better Auth validates Origin, callbackURL, state, nonce and PKCE.
    let incoming = c.req.raw
    if (path === '/magic-link/verify' && env.EMAIL && !new URL(c.req.url).searchParams.has('callbackURL')) {
      const url = new URL(c.req.url)
      // Delivered links contain only the token; select the browser destination on the server.
      url.searchParams.set('callbackURL', '/auth/complete')
      incoming = new Request(url, c.req.raw)
    }
    if (path === '/sign-in/social') {
      const body = z.strictObject({ provider: z.literal('oidc'), callbackURL: z.enum(['/me', '/auth/complete']).optional() }).parse(await c.req.json())
      incoming = new Request(c.req.raw, { body: JSON.stringify({ ...body, callbackURL: body.callbackURL ?? '/me', errorCallbackURL: body.callbackURL === '/auth/complete' ? '/sign-in?error=oidc' : '/auth/error', disableRedirect: true }) })
    }
    const response = await createIdentityAuth(env, config, explicit, path === '/sign-in/social' || path.startsWith('/callback/'), undefined, confirmation).handler(incoming)
    const bearer = response.headers.get('set-auth-token')
    if (bearer) await authenticateIssuedSession(bearer, c.req.url, env, config, path !== '/get-session')
    const location = response.headers.get('location')
    if (path.startsWith('/callback/') && location) {
      const error = new URL(location, c.req.url).searchParams.get('error')
      if (error === 'account_not_linked' || error === 'identity_not_linked') throw new ApiError(409, 'identity_not_linked', 'Sign in using your existing method, then explicitly link this identity.')
      if (error) throw new ApiError(400, error.includes('state') ? 'invalid_state' : 'invalid_external_identity')
    }
    return response
  })
}
