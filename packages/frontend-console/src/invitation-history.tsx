import { MembersScreen } from './members'

// Closed invitations use their own authorized collection in the shared Members list.
export function InvitationHistory({ orgId }: { orgId: string }) {
  return <MembersScreen orgId={orgId} history />
}
