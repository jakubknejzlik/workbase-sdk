import { useQuery } from '@tanstack/react-query'
import { authDestination } from './auth-destination'
import { safeReturnTo } from './client'
import { invitationInboxOptions, invitationTarget } from './invitation-inbox'
import type { Membership } from './queries'

/** An explicit destination wins; eligible inbox entry precedes organization creation. */
export function useInvitationDestination(saved: string | null, memberships: Membership[] | undefined) {
  const explicit = saved !== null && safeReturnTo(saved) === saved
  const discover = !!memberships && memberships.length === 0 && !explicit
  const validateInvitation = !!memberships && !!invitationTarget(saved)
  const needsInbox = discover || validateInvitation
  const inbox = useQuery({ ...invitationInboxOptions, enabled: needsInbox, retry: false })
  return { error: needsInbox ? inbox.error : null, target: !memberships || needsInbox && !inbox.data ? null
    : discover && inbox.data?.data.length ? inbox.data.data[0].navigation_target : authDestination(saved, memberships, validateInvitation ? inbox.data : undefined) }
}
