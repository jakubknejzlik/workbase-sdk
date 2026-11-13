import type { InstanceConfig } from './config'
import type { Scope } from './types'
import { ApiError } from './errors'
import { kernelFor } from './kernel/registry'
import { organizationPermission } from './organization-permissions'
import { userLinks } from './user-link-fields'
import { writeFilter } from './execution/policies'
import { quote } from './migrations/schema'

/** SDK mappings are explicit; historical instances retain their member target. */
export function invitationRole(config: InstanceConfig, entity: string): string {
  if (config.baseline !== 'workbase-sdk') return 'member'
  const role = config.effectiveAccess?.accountLinks?.[entity]?.invitationRole
  if (!role) throw new ApiError(400, 'invitation_role_required')
  return role
}
export function canReadAccountAccess(config: InstanceConfig, scope: Scope, entity: string): boolean {
  if (!config.effectiveAccess?.accountLinks?.[entity]) return false
  try {
    kernelFor(config).resourcePermission(scope, 'invitations.read')
    organizationPermission(config, scope, 'invitations.read')
    return true
  } catch { return false }
}
export interface AccountAccessState {
  state: 'no_account' | 'invited' | 'expired' | 'linked'
  account: { id: string; display_name: string; email: string } | null
  invitation: { id: string; email: string; expires_at: string } | null
}
/** Only public card data leaves this service. The caller checks invitations.read;
 * the row and account lookup independently retain the request's read authority. */
export async function accountAccessState(config: InstanceConfig, scope: Scope, db: D1Database, entity: string, id: string): Promise<AccountAccessState> {
  const link = userLinks(config).find(link => link.entity === entity)
  if (!link) throw new ApiError(400, 'user_link_required')
  const kernel = kernelFor(config)
  kernel.permission(scope, entity, 'read')
  const filter = writeFilter(kernel, scope, entity)
  const row = await db.prepare(`SELECT ${quote(link.field)} AS account_id FROM ${quote(entity)} WHERE organization_id=? AND id=? AND (${filter.sql})`)
    .bind(scope.organizationId, id, ...(filter.bindings ?? [])).first<{ account_id: string | null }>()
  if (!row) throw new ApiError(404, 'not_found')
  if (row.account_id) {
    const account = await db.prepare(`SELECT u.id,u.email,coalesce(nullif(trim(a.name),''),u.email) AS display_name FROM users u LEFT JOIN "user" a ON a.id=u.id WHERE u.id=? AND u.organization_id=?`)
      .bind(row.account_id, scope.organizationId).first<NonNullable<AccountAccessState['account']>>()
    return { state: 'linked', account, invitation: null }
  }
  // Select history before filtering terminal rows, so a cancelled replacement
  // never resurrects an older expired invitation.
  const latest = await db.prepare(`SELECT id,email,expires_at,expired_at,accepted_at,revoked_at,declined_at FROM invitations WHERE organization_id=? AND target_entity=? AND target_row=? ORDER BY created_at DESC,id DESC LIMIT 1`)
    .bind(scope.organizationId, entity, id).first<{ id: string; email: string; expires_at: string; expired_at: string | null; accepted_at: string | null; revoked_at: string | null; declined_at: string | null }>()
  if (!latest || latest.accepted_at || latest.revoked_at || latest.declined_at) return { state: 'no_account', account: null, invitation: null }
  return { state: latest.expired_at || latest.expires_at <= new Date().toISOString() ? 'expired' : 'invited', account: null,
    invitation: { id: latest.id, email: latest.email, expires_at: latest.expires_at } }
}
