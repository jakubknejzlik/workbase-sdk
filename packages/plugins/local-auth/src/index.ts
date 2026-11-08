import { z } from 'zod'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import { createIdentityAuth } from './better-auth'
import { authenticateIssuedSession, revokeIssuedSession } from './session-authentication'
import { ApiError } from '../../../core/src/errors'
import { authRoutes } from './auth'
import { resolveActor } from './authenticate'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
/** Better Auth magic links and sessions, including invitation mailbox proof. */
export const localAuth: WorkbasePlugin = builtinPlugin({
  name: 'local-auth', version: '0.1.0', provides: { login: '1.x' }, requires: { identity: '^1' }, optionalRequires: { 'mail-outbox': '^1' },
  async authenticate(request, env) {
    if (request.headers.get('Authorization')?.startsWith('Bearer wb_')) return null
    if (!request.headers.has('Authorization') && !/(?:^|;\s*)__Host-workbase\.session=/.test(request.headers.get('Cookie') ?? '')) return null
    return resolveActor(request, env, this.config)
  },
  async signInInvitation(email, request, env) {
    let verifyURL = ''
    const auth = createIdentityAuth(env, this.config, false, false, async (_email, url) => { verifyURL = url })
    await auth.api.signInMagicLink({ headers: request.headers, body: { email, callbackURL: '/auth/complete' } })
    // Keep the caller's rate-limit identity across this internal verification request.
    // Do not forward cookies/authorization: the invitation verifies its own recipient.
    const headers = new Headers()
    const clientIp = request.headers.get('cf-connecting-ip')
    if (clientIp) headers.set('cf-connecting-ip', clientIp)
    const response = await auth.handler(new Request(verifyURL, { headers }))
    const bearer = response.headers.get('set-auth-token')
    if (!bearer) throw new ApiError(403, 'invitation_sign_in_failed')
    const actor = await authenticateIssuedSession(bearer, request.url, env, this.config)
    return { actor, response, revoke: () => revokeIssuedSession(bearer, env, this.config) }
  }, routes: authRoutes,
  async checkSchema(db) {
    await db.prepare('SELECT id,"userId","expiresAt" FROM "session" LIMIT 0').all()
    await db.prepare('SELECT id,identifier,value,"expiresAt" FROM verification LIMIT 0').all()
    await db.prepare('SELECT state_hash,user_id,session_id,expires_at FROM identity_link_grants LIMIT 0').all()
  },
})

const methods = z.strictObject({ methods: z.tuple([z.literal('magic-link')]) })
export type LocalAuthOptions = z.input<typeof methods>
/** Baseline supports magic-link; retained environment adapters remain explicit. */
export function createLocalAuth(options?: LocalAuthOptions): WorkbasePlugin {
  const parsed = methods.parse(options ?? { methods: ['magic-link'] })
  const configuration = Object.freeze({ methods: Object.freeze(parsed.methods) })
  return builtinPlugin({ ...localAuth, configuration, configSchema: methods.default(parsed) })
}
