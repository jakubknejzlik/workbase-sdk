import './better-auth-als-preseed'
import { magicLinkTokenHash } from '@workbasehq/core/crypto'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { magicLink, bearer, genericOAuth } from 'better-auth/plugins'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import { identityEnvironment } from '../../../core/src/identity-settings'
import { identityWrite } from '../../../core/src/identity-writes'
import { sendMagicLink } from './mail'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import type { ResolvedActor } from '../../../core/src/types'
import { recordExternalRegistration } from '../../identity/src/registration'
import { ApiError } from '../../../core/src/errors'
import { SESSION_COOKIE } from '@workbasehq/core/session-contract'
export { SESSION_COOKIE }
export const SESSION_SECONDS = 7 * 86400
// An instance belongs to ONE request (Workers cannot retain another request's I/O promises).
export function createIdentityAuth(env: RuntimeEnv, config: InstanceConfig | undefined, explicitLink = false, discoverOIDC = true, magicDelivery?: (email: string, url: string) => Promise<void>, confirmation?: ResolvedActor) {
  env = identityEnvironment(env)
  const settings = env.IDENTITY
  if (!settings || settings.secret.length < 32) throw new ApiError(503, 'identity_not_configured')
  const oidc = settings.oidc
  const createdUsers = new Set<string>()
  return betterAuth({
    appName: 'Workbase', baseURL: settings.baseURL, basePath: '/auth', secret: settings.secret,
    database: env.DB, // Better Auth's bundled Kysely D1 adapter.
    trustedOrigins: [new URL(settings.baseURL).origin],
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false, disableImplicitLinking: true, ...(explicitLink ? { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true } : {}) } },
    session: { expiresIn: SESSION_SECONDS, updateAge: 86400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30,
      customRules: { '/sign-in/magic-link': { window: 60, max: 5 }, '/sign-in/social': { window: 60, max: 10 }, '/callback/*': { window: 60, max: 20 }, '/link-social': { window: 60, max: 5 } } },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // Disable BA's automatic __Secure- prefix only: every cookie already uses __Host-.
      useSecureCookies: false, cookiePrefix: '__Host-workbase',
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
      cookies: { session_token: { name: SESSION_COOKIE } } },
    plugins: [bearer(), magicLink({ expiresIn: 600, storeToken: { type: 'custom-hasher', hash: magicLinkTokenHash }, sendMagicLink: async ({ email, url }) => {
      await (magicDelivery ? magicDelivery(email, url) : sendMagicLink(env, config!, email, url))
    } }), ...(oidc && discoverOIDC ? [genericOAuth({ config: [{ providerId: 'oidc', clientId: oidc.clientId, clientSecret: oidc.clientSecret,
      discoveryUrl: `${oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, accountIssuer: oidc.issuer,
      requireIdTokenVerification: true, pkce: true, scopes: ['openid', 'email', 'profile'],
    }] })] : [])],
    user: { validateUserInfo: async ({ user, source }) => {
      if (source.method !== 'oauth') return
      const profile = source.oauth?.profile
      if (!oidc || profile?.iss !== oidc.issuer || typeof profile?.sub !== 'string' || !profile.sub || user.emailVerified !== true) return { error: 'invalid_external_identity' }
      const binding = await env.DB.prepare('SELECT user_id FROM identities WHERE issuer=? AND subject=?').bind(oidc.issuer, profile.sub).first<{ user_id: string }>()
      if (binding && binding.user_id !== user.id) return { error: 'identity_binding_conflict' }
      if (source.action === 'sign-in' && !binding) return { error: 'identity_not_linked' }
      // Implicit linking is rejected by accountLinking.enabled=false above, before this hook.
      // Explicit linking is routed only after a state grant and live-session check in authRoutes.
    } },
    databaseHooks: {
      user: { create: { before: async user => {
        if (config?.registration === 'invite-only') {
          const invitation = await env.DB.prepare(`SELECT id FROM invitations WHERE lower(email)=lower(?) AND accepted_at IS NULL AND revoked_at IS NULL ${kernelFor(config!).providers.has('members') ? 'AND declined_at IS NULL AND expired_at IS NULL' : ''} AND expires_at>?`).bind(user.email, new Date().toISOString()).first()
          if (!invitation) throw new APIError('FORBIDDEN', { message: 'registration_closed' })
        }
      }, after: async user => {
        // Authentication precedes a domain account. Its org/role are granted only by
        // the private organization-create / invitation-claim transaction.
        createdUsers.add(user.id)
        if (config?.account?.entity === 'users') return
        await identityWrite(env, config!, 'user_created', [{ sql: "INSERT INTO users (id,email,password_hash,salt,created_at) VALUES (?,?,'','',?)", bindings: [user.id, user.email.toLowerCase(), user.createdAt.toISOString()], expectRows: 1 }], user.id)
      } } },
      account: { create: { after: async account => {
        if (account.providerId !== 'oidc' || !oidc || account.issuer !== oidc.issuer) throw new ApiError(403, 'invalid_external_identity')
        const user = await kernelFor(config!).identity.resolveUser(env.DB, account.userId)
        const external = { provider: account.providerId, issuer: account.issuer, subject: account.accountId, email: user.email, emailVerified: true }
        if (createdUsers.has(user.id)) await recordExternalRegistration(env, config!, user.id, external)
        else {
          if (!confirmation) throw new ApiError(403, 'identity_link_not_allowed')
          await kernelFor(config!).identity.linkExternalIdentity(env, config!, { userId: user.id, external, confirmation })
        }
      } } },
    },
    logger: { disabled: true },
  })
}
