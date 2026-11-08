import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceSettingsLayout } from '../../settings'
export const Route = createFileRoute('/o/$orgId/settings')({ staticData: { title: 'settings', crumb: 'settings', hasClickableBreadcrumb: false, noLayoutContentPadding: true }, component: Screen })
function Screen() { return <WorkspaceSettingsLayout orgId={Route.useParams().orgId} /> }
