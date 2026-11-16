import type { SqlStatement } from './execution/types'

/** Workspace membership and the account's workspace must both match.
 * Shared by the picker read, the Link preflight and its atomic write-time check. */
export function linkableMembers(organizationId: string, userId?: string): SqlStatement {
  return {
    sql: `SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id WHERE ${userId === undefined ? '' : 'u.id=? AND '}u.organization_id=?`,
    bindings: [...(userId === undefined ? [] : [userId]), organizationId],
  }
}
