import { invitationTarget, type InvitationInbox } from './invitation-inbox'
import { safeReturnTo } from './client'
import type { Membership } from './queries'
import { scopeHomeDestination } from '../../../console-generated/src/scope-home'

/** The completion screen shares this decision with an already signed-in landing. */
export function authDestination(saved: string | null, memberships: Membership[], inbox?: InvitationInbox, organizationsEnabled?: boolean) {
  const home = scopeHomeDestination({ memberships, organizationsEnabled })
  let target = safeReturnTo(saved, home)
  if (invitationTarget(target) && inbox && !inbox.data.some(row => row.navigation_target === target)) target = home
  if (target === '/' || target === '/organizations' || target === home) {
    if (!memberships.length && inbox) return invitationTarget(inbox.next) ?? home
    return home
  }
  return target
}
