import { createFileRoute } from '@tanstack/react-router'
import { PluginPage } from '../../../console-pages'
export const Route = createFileRoute('/o/$orgId/settings/workspace-settings')({ staticData: { title: 'organizationSettings', crumb: 'organizationSettings', noLayoutContentPadding: true }, component: Screen })
function Screen() { return <PluginPage orgId={Route.useParams().orgId} id="organizations.settings" /> }
