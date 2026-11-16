import { memberIdentities, canReadMembers } from './member-identities'
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
/** The caller checks invitation and row read authority before looking up history. */
export async function latestRowInvitation(db: D1Database, organizationId: string, entity: string, id: string): Promise<(NonNullable<AccountAccessState['invitation']> & { expired_at: string | null }) | null> {
  // Select history before filtering terminal rows, so a cancelled replacement
  // never resurrects an older expired invitation.
  const latest = await db.prepare(`SELECT id,email,expires_at,expired_at,accepted_at,revoked_at,declined_at FROM invitations WHERE organization_id=? AND target_entity=? AND target_row=? ORDER BY created_at DESC,id DESC LIMIT 1`)
    .bind(organizationId, entity, id).first<{ id: string; email: string; expires_at: string; expired_at: string | null; accepted_at: string | null; revoked_at: string | null; declined_at: string | null }>()
  if (!latest || latest.accepted_at || latest.revoked_at || latest.declined_at) return null
  return { id: latest.id, email: latest.email, expires_at: latest.expires_at, expired_at: latest.expired_at }
}
/** Only public card data leaves this service. The caller checks invitations.read;
 * row read and Members identity disclosure retain independent authority. */
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
    const member = kernel.fieldMask(entity, scope).includes(link.field) && canReadMembers(config, scope)
      ? (await memberIdentities(config, scope, db, row.account_id))[0] : undefined
    const account = member ? { id: member.user_id, display_name: member.display_name ?? member.email, email: member.email } : null
    return { state: 'linked', account, invitation: null }
  }
  const latest = await latestRowInvitation(db, scope.organizationId, entity, id)
  if (!latest) return { state: 'no_account', account: null, invitation: null }
  return { state: latest.expired_at || latest.expires_at <= new Date().toISOString() ? 'expired' : 'invited', account: null,
    invitation: { id: latest.id, email: latest.email, expires_at: latest.expires_at } }
}
