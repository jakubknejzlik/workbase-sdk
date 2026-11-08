import { invitationTarget, type InvitationInbox } from './invitation-inbox'
import { safeReturnTo } from './client'
import type { Membership } from './queries'

/** The completion screen shares this decision with an already signed-in landing. */
export function authDestination(saved: string | null, memberships: Membership[], inbox?: InvitationInbox) {
  let target = safeReturnTo(saved)
  if (invitationTarget(target) && inbox && !inbox.data.some(row => row.navigation_target === target)) target = '/organizations'
  if (target === '/organizations' && !memberships.length && inbox) return invitationTarget(inbox.next) ?? target
  return target === '/organizations' && memberships.length === 1
    ? `/o/${encodeURIComponent(memberships[0].organization_id)}` : target
}
