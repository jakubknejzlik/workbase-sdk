import type { InstanceConfig } from './config'
import { ApiError } from './errors'
import { quote } from './migrations/schema'
import { userLinks } from './user-link-fields'
import type { SqlStatement } from './execution/types'

/** Workspace membership and the account's workspace must both match.
 * Shared by the picker read, the Link preflight and its atomic write-time check. */
export function linkableMembers(organizationId: string, userId?: string): SqlStatement {
  return {
    sql: `SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id WHERE ${userId === undefined ? '' : 'u.id=? AND '}u.organization_id=?`,
    bindings: [...(userId === undefined ? [] : [userId]), organizationId],
  }
}

/** Uniqueness is per configured entity and workspace, excluding the target row.
 * The read uses only the fixed Members candidate alias; clients cannot supply SQL.
 * Keep this separate from membership preflight so duplicates remain HTTP 409. */
export function accountLinkUnique(config: InstanceConfig, organizationId: string, target: { entity: string; row: string }, candidate: { userId: string } | { member: true }): SqlStatement {
  const link = userLinks(config).find(link => link.entity === target.entity)
  if (!link) throw new ApiError(400, 'user_link_required')
  return {
    sql: `NOT EXISTS (SELECT 1 FROM ${quote(link.entity)} other WHERE other.organization_id=? AND other.${quote(link.field)}=${'userId' in candidate ? '?' : 'u.id'} AND other.id<>?)`,
    bindings: [organizationId, ...('userId' in candidate ? [candidate.userId] : []), target.row],
  }
}
