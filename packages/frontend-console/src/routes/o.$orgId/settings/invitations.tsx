import { createFileRoute } from '@tanstack/react-router'
import { InvitationHistory } from '../../../invitation-history'
export const Route = createFileRoute('/o/$orgId/settings/invitations')({ staticData: { settingsActiveItem: 'members', title: 'inviteHistory', crumb: 'inviteHistory', noLayoutContentPadding: true }, component: Screen })
function Screen() { return <InvitationHistory orgId={Route.useParams().orgId} /> }
