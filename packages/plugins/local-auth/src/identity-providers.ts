import { z } from 'zod'
import type { RuntimeEnv } from '../../../core/src/types'
import { equalHash, passwordHash } from '@workbasehq/core/crypto'
import type { InstanceConfig } from '@workbasehq/core/config'
import { assertIdentityTransport, devLocalIdentityEnabled, identityEnvironment } from '../../../core/src/identity-settings'
import { createIdentityAuth } from './better-auth'
import { ApiError } from '../../../core/src/errors'

export interface IdentityProvider {
  readonly id: string
  authenticate(credentials: unknown): Promise<{ userId: string }>
  // A future provider resolves an existing issuer/subject binding, or starts an explicit linking flow.
  // External identities MUST NEVER auto-link to a user by matching an e-mail address.
  linkExternal?(issuer: string, subject: string): Promise<{ userId: string }>
}
import { emailSchema } from '@workbasehq/core/identity-providers'
export { emailSchema }
export class LocalIdentityProvider implements IdentityProvider {
  readonly id = 'local'
  constructor(private env: RuntimeEnv, private request?: Request) { this.env = identityEnvironment(env) }
  async authenticate(credentials: unknown) {
    if (!devLocalIdentityEnabled(this.env, this.request)) throw new ApiError(404, 'provider_not_enabled')
    const body = z.strictObject({ email: emailSchema, password: z.string().max(200) }).parse(credentials)
    const user = await this.env.DB.prepare(`SELECT u.id,u.password_hash,u.salt FROM users u
      JOIN identities i ON i.user_id=u.id AND i.provider='local' AND i.issuer='local' AND i.subject=u.id
      WHERE lower(u.email)=?`).bind(body.email).first<{ id: string; password_hash: string; salt: string }>()
    const hash = await passwordHash(body.password, user?.salt ?? '0'.repeat(32))
    if (!user || !equalHash(user.password_hash, hash)) throw new ApiError(401, 'invalid_credentials')
    return { userId: user.id }
  }
}
// Better Auth owns login flows and session verification; roles remain local and live.
export class BetterAuthIdentityProvider implements IdentityProvider {
  readonly id = 'better-auth'
  constructor(private env: RuntimeEnv, private config?: InstanceConfig) { this.env = identityEnvironment(env) }
  async authenticate(credentials: unknown) {
    if (!(credentials instanceof Request)) throw new ApiError(400, 'request_required')
    const session = await this.session(credentials)
    if (!session) throw new ApiError(401, 'unauthenticated')
    return { userId: session.user.id }
  }
  session(request: Request) {
    assertIdentityTransport(request)
    return createIdentityAuth(this.env, this.config, false, false).api.getSession({ headers: request.headers })
  }
}
export const identityProviders = (env: RuntimeEnv, config?: InstanceConfig, request?: Request): readonly IdentityProvider[] => {
  env = identityEnvironment(env)
  return [
  ...(env.IDENTITY ? [new BetterAuthIdentityProvider(env, config)] : []),
  ...(devLocalIdentityEnabled(env, request) ? [new LocalIdentityProvider(env, request)] : []),
  ]
}
