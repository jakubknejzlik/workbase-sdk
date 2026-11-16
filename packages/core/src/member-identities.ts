import type { InstanceConfig } from './config'
import type { Scope } from './types'
import { kernelFor } from './kernel/registry'
import { organizationPermission } from './organization-permissions'
import { displayIdentity } from './display-identity'
import { linkableMembers } from './user-link-eligibility'

/** Same gates as the Members read route, including attenuated token authority. */
export function requireMembersRead(config: InstanceConfig, scope: Scope) {
  kernelFor(config).resourcePermission(scope, 'members.read')
  organizationPermission(config, scope, 'members.read')
}
export function canReadMembers(config: InstanceConfig, scope: Scope): boolean {
  if (!kernelFor(config).providers.has('members')) return false
  try { requireMembersRead(config, scope); return true } catch { return false }
}
/** One workspace-scoped source for Members, linked identity and the Link picker.
 * Email is already part of the Members projection under these exact gates.
 * The optional id narrows a lookup; it never substitutes for the membership join.
 * Only the Link picker opts into the writer's account eligibility filter.
 */
export async function memberIdentities(config: InstanceConfig, scope: Scope, db: D1Database, userId?: string, linkableOnly = false) {
  requireMembersRead(config, scope)
  const eligible = linkableOnly ? linkableMembers(scope.organizationId) : undefined
  const rows = await db.prepare(`SELECT m.user_id,u.email,m.role,a.name,p.first_name AS firstName,p.last_name AS lastName
    FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN "user" a ON a.id=u.id
    LEFT JOIN identity_profiles p ON p.user_id=u.id AND (
      NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider<>'local')
      OR (p.synced_at IS NOT NULL
        AND (SELECT count(*) FROM identities i WHERE i.user_id=u.id AND i.provider<>'local')=1
        AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider=p.source_provider AND i.issuer=p.source_issuer AND i.subject=p.source_subject)))
    WHERE m.organization_id=?${userId === undefined ? '' : ' AND m.user_id=?'}${eligible ? ` AND m.user_id IN (${eligible.sql})` : ''} ORDER BY m.user_id`)
    .bind(scope.organizationId, ...(userId === undefined ? [] : [userId]), ...(eligible?.bindings ?? []))
    .all<{ user_id: string; email: string; role: string; name: string | null; firstName: string | null; lastName: string | null }>()
  return rows.results.map(({ name, firstName, lastName, ...row }) => ({ ...row,
    display_name: displayIdentity({ name, firstName, lastName, email: row.email }).displayName,
  }))
}
