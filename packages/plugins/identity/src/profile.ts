import { z } from 'zod'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import type { ExternalIdentity, ProfileNames, SelfProfile } from '../../../core/src/kernel/identity-port'
import { ApiError } from '../../../core/src/errors'
import { identityWrite } from '../../../core/src/identity-writes'
import { RuleFailed } from '../../../core/src/execution/errors'
import { displayIdentity } from './display-identity'

const name = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed')
export const profileNamesSchema = z.strictObject({ firstName: name, lastName: name })
async function authority(db: D1Database, config: InstanceConfig, userId: string): Promise<SelfProfile['authority']> {
  const bindings = (await db.prepare("SELECT provider,issuer,subject FROM identities WHERE user_id=? AND provider<>'local' ORDER BY provider,issuer,subject").bind(userId).all<ExternalIdentity>()).results
  if (!bindings.length) return { kind: 'local', provider: null, synchronization: null }
  // Never select the first linked provider by plugin or SQL order.
  if (bindings.length !== 1) throw new ApiError(409, 'profile_authority_ambiguous')
  const provider = bindings[0].provider
  const policies = config.plugins?.filter(p => p.provides?.login && p.profileAuthority?.provider === provider).map(p => p.profileAuthority!) ?? []
  if (policies.length > 1) throw new ApiError(409, 'profile_authority_ambiguous')
  const synchronization = policies[0]?.synchronization ?? null
  if (synchronization) z.strictObject({ method: z.string().trim().min(1), maxLatencySeconds: z.number().int().nonnegative() }).parse(synchronization)
  return { kind: 'idp', provider, synchronization }
}
export async function readProfile(db: D1Database, config: InstanceConfig, userId: string): Promise<SelfProfile> {
  const row = await db.prepare(`SELECT u.id,u.email,u.name,p.first_name AS firstName,p.last_name AS lastName,p.synced_at AS syncedAt,
    EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider=p.source_provider AND i.issuer=p.source_issuer AND i.subject=p.source_subject) AS sourceLinked
    FROM "user" u LEFT JOIN identity_profiles p ON p.user_id=u.id WHERE u.id=?`).bind(userId).first<{ id: string; email: string; name: string | null; firstName: string | null; lastName: string | null; syncedAt: string | null; sourceLinked: number }>()
  if (!row) throw new ApiError(401, 'invalid_local_identity')
  const owner = await authority(db, config, userId)
  if (owner.kind === 'local') row.syncedAt = null
  if (owner.kind === 'idp' && (!row.syncedAt || !row.sourceLinked)) {
    row.firstName = null; row.lastName = null; row.syncedAt = null
  }
  const missingFields = (['firstName', 'lastName'] as const).filter(field => !row[field]?.trim())
  return { id: row.id, email: row.email, firstName: row.firstName, lastName: row.lastName, displayName: displayIdentity(row).displayName,
    authority: owner, capabilities: { canEditNames: owner.kind === 'local', canEditEmail: false },
    completeness: { complete: missingFields.length === 0, missingFields }, syncedAt: row.syncedAt }
}
async function persist(env: RuntimeEnv, config: InstanceConfig, userId: string, names: ProfileNames, external?: ExternalIdentity) {
  const { firstName, lastName } = profileNamesSchema.parse(names)
  const now = new Date().toISOString()
  const guard = external
    ? { sql: 'EXISTS (SELECT 1 FROM identities WHERE user_id=? AND provider=? AND issuer=? AND subject=?) AND (SELECT count(*) FROM identities WHERE user_id=? AND provider<>\'local\')=1', values: [userId, external.provider, external.issuer, external.subject, userId] }
    : { sql: "NOT EXISTS (SELECT 1 FROM identities WHERE user_id=? AND provider<>'local')", values: [userId] }
  try {
    await identityWrite(env, config, external ? 'profile_synced' : 'profile_updated', [{
      sql: `INSERT INTO identity_profiles (user_id,first_name,last_name,synced_at,source_provider,source_issuer,source_subject,updated_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM "user" WHERE id=?) AND ${guard.sql}
        ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,synced_at=excluded.synced_at,
          source_provider=excluded.source_provider,source_issuer=excluded.source_issuer,source_subject=excluded.source_subject,updated_at=excluded.updated_at`,
      bindings: [userId, firstName, lastName, external ? now : null, external?.provider ?? null, external?.issuer ?? null, external?.subject ?? null, now, userId, ...guard.values], expectRows: 1,
    }, {
      sql: 'UPDATE "user" SET name=?,"updatedAt"=? WHERE id=? AND changes()=1', bindings: [`${firstName} ${lastName}`, now, userId], expectRows: 1,
    }], userId)
  } catch (error) {
    if (error instanceof RuleFailed) throw new ApiError(409, 'profile_conflict')
    throw error
  }
}
export async function updateProfile(env: RuntimeEnv, config: InstanceConfig, userId: string, names: ProfileNames) {
  if ((await readProfile(env.DB, config, userId)).authority.kind !== 'local') throw new ApiError(403, 'profile_read_only')
  await persist(env, config, userId, names)
  return readProfile(env.DB, config, userId)
}
export async function syncProfile(env: RuntimeEnv, config: InstanceConfig, external: ExternalIdentity, names: ProfileNames) {
  const row = await env.DB.prepare('SELECT user_id FROM identities WHERE provider=? AND issuer=? AND subject=?').bind(external.provider, external.issuer, external.subject).first<{ user_id: string }>()
  if (!row) throw new ApiError(409, 'identity_not_linked')
  const policy = await authority(env.DB, config, row.user_id)
  if (policy.kind !== 'idp' || !policy.synchronization) throw new ApiError(409, 'profile_sync_unavailable')
  await persist(env, config, row.user_id, names, external)
}

/** Optional server-owned invitation hint. The insert and authority guard are atomic. */
export async function prefillProfile(env: RuntimeEnv, config: InstanceConfig, userId: string, names: ProfileNames) {
  const { firstName, lastName } = profileNamesSchema.parse(names)
  if ((await readProfile(env.DB, config, userId)).authority.kind !== 'local'
    || await env.DB.prepare('SELECT 1 FROM identity_profiles WHERE user_id=?').bind(userId).first()) return
  // Do not update user.name: readProfile derives the display name from the profile.
  await identityWrite(env, config, 'profile_prefilled', [{
    sql: `INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM "user" WHERE id=?)
        AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id=? AND provider<>'local')
      ON CONFLICT(user_id) DO NOTHING`,
    bindings: [userId, firstName, lastName, new Date().toISOString(), userId, userId],
  }], userId)
}
