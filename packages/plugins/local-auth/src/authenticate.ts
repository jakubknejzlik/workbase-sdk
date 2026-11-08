import { ApiError } from '../../../core/src/errors'
import { sha256 } from '@workbasehq/core/crypto'
import { assertIdentityTransport, devLocalIdentityEnabled, identityEnvironment } from '../../../core/src/identity-settings'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { sealActor, type ResolvedActor, type AvailableOrganization } from '../../../core/src/authorization'
import type { RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig } from '@workbasehq/core/config'
import { BetterAuthIdentityProvider } from './identity-providers'
export async function resolveActor(request: Request, env: RuntimeEnv, config?: InstanceConfig): Promise<ResolvedActor> {
  assertIdentityTransport(request)
  env = identityEnvironment(env)
  const devLocal = devLocalIdentityEnabled(env, request)
  const auth = request.headers.get('Authorization')
  if (auth && !auth.startsWith('Bearer ')) throw new ApiError(401, 'unauthenticated')
  const raw = auth?.slice(7) ?? ''; const hash = await sha256(raw); const now = new Date().toISOString()
  let result: ResolvedActor; let sessionId: string | undefined
  const sessionHeaders = new Headers(request.headers)
  if (raw) sessionHeaders.delete('Cookie')
  const session = env.IDENTITY ? await new BetterAuthIdentityProvider(env, config).session(new Request(request.url, { headers: sessionHeaders })) : null
  sessionId = session?.session.id
  // An authenticated identity can exist before its domain account. Legacy
  // credentials still require their explicitly enabled compatibility projection.
  const user: { id: string; email: string; organizations?: string } | null = session ? { id: session.user.id, email: session.user.email }
    : devLocal ? await env.DB.prepare(`SELECT u.id,u.email,(SELECT json_group_array(json_object('id',o.id,'name',o.name,'role',m.role)) FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=u.id) AS organizations FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`).bind(hash, now).first() : null
  if (!user) throw new ApiError(401, 'unauthenticated')
  result = { actor: { type: 'user', id: user.id }, user: { id: user.id, email: user.email, ...(session?.user.name?.trim() ? { name: session.user.name.trim() } : {}) }, organizations: user.organizations ? JSON.parse(user.organizations) : (await env.DB.prepare('SELECT o.id,o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=?').bind(user.id).all<AvailableOrganization>()).results }
  if (config && !kernelFor(config).providers.has('organizations')) result.organizations = result.organizations.filter(org => org.id === 'instance')
  const userId = result.user?.id
  return sealActor(result, { env, hash, ...(userId ? { session: {
    recipientVerification: 'local-profile' as const,
    membershipCondition: (now: string) => ({
      sql: `EXISTS (SELECT 1 FROM "session" s WHERE s.id=? AND s."userId"=m.user_id AND s."expiresAt">?) OR (?=1 AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=m.user_id AND s.token_hash=? AND s.expires_at>?))`,
      bindings: [sessionId ?? null, now, devLocal ? 1 : 0, hash, now],
    }),
    async valid() {
      const live = await env.DB.prepare(`SELECT "userId" AS user_id FROM "session" WHERE id=? AND "expiresAt">? UNION ALL SELECT user_id FROM sessions WHERE ?=1 AND token_hash=? AND expires_at>?`).bind(sessionId ?? null, new Date().toISOString(), devLocal ? 1 : 0, hash, new Date().toISOString()).first<{ user_id: string }>()
      return live?.user_id === userId
    },
    async verified() {
      if (!sessionId && devLocal) return !!await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?').bind(hash, userId, new Date().toISOString()).first()
      return !!await env.DB.prepare(`SELECT u.id FROM "user" u JOIN "session" s ON s."userId"=u.id WHERE s.id=? AND s."expiresAt">? AND u."emailVerified"=1`).bind(sessionId ?? null, new Date().toISOString()).first()
    },
  } } : {}) })
}
