import { migrations } from './migrations/index'
import { z } from 'zod'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import type { ExternalIdentity, IdentityPort, LocalUser } from '../../../core/src/kernel/identity-port'
import { ApiError } from '../../../core/src/errors'
import { requireVerifiedSession } from '../../../core/src/authorization'
import { identityWrite } from '../../../core/src/identity-writes'
import { readProfile, updateProfile, syncProfile, prefillProfile } from './profile'
import { profileRoutes } from './routes'
export { displayIdentity } from './display-identity'

const configSchema = z.strictObject({
  trustedIssuers: z.record(z.string().url(), z.array(z.string().min(1).transform(domain => domain.toLowerCase()))).default({}),
}).default({ trustedIssuers: {} })
const externalSchema = z.object({ provider: z.string().min(1), issuer: z.string().url(), subject: z.string().min(1) })
const identityPort: IdentityPort = {
  readProfile, updateProfile, syncProfile, prefillProfile,
  async resolveUser(db, userId) {
    // The retained Better Auth user table is the shared local profile. Domain users
    // may be an optional per-organization account extension with the same stable ID.
    const user = await db.prepare('SELECT id,email,name FROM "user" WHERE id=?').bind(userId).first<LocalUser>()
    if (!user) throw new ApiError(401, 'invalid_local_identity')
    return user
  },
  async resolveExternalIdentity(db, input) {
    const { provider, issuer, subject } = externalSchema.parse(input)
    const binding = await db.prepare('SELECT user_id FROM identities WHERE provider=? AND issuer=? AND subject=?').bind(provider, issuer, subject).first<{ user_id: string }>()
    if (!binding) throw new ApiError(409, 'identity_not_linked')
    return identityPort.resolveUser(db, binding.user_id)
  },
  async linkExternalIdentity(env, config, { userId, external, confirmation }) {
    externalSchema.parse(external)
    const local = await identityPort.resolveUser(env.DB, userId)
    if (confirmation) {
      if (await requireVerifiedSession(confirmation, env.DB)) throw new ApiError(403, 'identity_link_not_allowed')
      if (confirmation.actor.type !== 'user' || confirmation.user?.id !== userId) throw new ApiError(403, 'identity_link_not_allowed')
    } else {
      const { trustedIssuers } = configSchema.parse(config.pluginConfig?.identity)
      const domain = local.email.split('@')[1]?.toLowerCase()
      if (external.emailVerified !== true || external.email.toLowerCase() !== local.email.toLowerCase() || !domain || !trustedIssuers[external.issuer]?.includes(domain)) throw new ApiError(403, 'identity_link_not_allowed')
    }
    const binding = await env.DB.prepare('SELECT user_id,provider FROM identities WHERE issuer=? AND subject=?').bind(external.issuer, external.subject).first<{ user_id: string; provider: string }>()
    if (binding) {
      if (binding.user_id !== userId || binding.provider !== external.provider) throw new ApiError(409, 'identity_binding_conflict')
      return
    }
    // Called only by an explicit server-side linking operation. Authentication
    // resolves an existing mapping and never invokes this method on email equality.
    await identityWrite(env, config, 'external_linked', [{
      sql: 'INSERT INTO identities (user_id,provider,issuer,subject,created_at) VALUES (?,?,?,?,?)',
      bindings: [userId, external.provider, external.issuer, external.subject, new Date().toISOString()], expectRows: 1,
    }], userId)
  },
}
Object.freeze(identityPort)

/** Stable local users, profiles and external mappings; no login or sessions. */
export const identity: WorkbasePlugin = builtinPlugin({
  name: 'identity', version: '0.1.0', provides: { identity: '1.x' }, configSchema,
  identity: identityPort,
  routes: profileRoutes,
  migrations,
  async checkSchema(db) {
    await db.prepare('SELECT id,email,name FROM "user" LIMIT 0').all()
    await db.prepare('SELECT user_id,provider,issuer,subject FROM identities LIMIT 0').all()
    await db.prepare('SELECT user_id,first_name,last_name,synced_at,source_provider,source_issuer,source_subject,updated_at FROM identity_profiles LIMIT 0').all()
  },
})
export type { ExternalIdentity, IdentityPort, LocalUser }
export type { SelfProfile, ProfileNames, ProfileSynchronization } from '../../../core/src/kernel/identity-port'

export type IdentityOptions = z.input<typeof configSchema>
/** Explicit factory; identity remains the compatibility descriptor. */
export function createIdentity(options?: IdentityOptions): WorkbasePlugin {
  const configuration = configSchema.parse(options)
  for (const domains of Object.values(configuration.trustedIssuers)) Object.freeze(domains)
  Object.freeze(configuration.trustedIssuers)
  Object.freeze(configuration)
  return builtinPlugin({ ...identity, configuration, configSchema: configSchema.default(configuration) })
}
