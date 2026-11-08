import { MembersScreen } from './members'

// Workbase-only closed invitations. Pending owner decision: remove this wrapper,
// its route and the Members history link if history is dropped.
export function InvitationHistory({ orgId }: { orgId: string }) {
  return <MembersScreen orgId={orgId} history />
}
