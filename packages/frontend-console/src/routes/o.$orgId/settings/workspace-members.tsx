import { createFileRoute } from '@tanstack/react-router'
import { PluginPage } from '../../../console-pages'
export const Route = createFileRoute('/o/$orgId/settings/workspace-members')({ staticData: { title: 'members', crumb: 'members', noLayoutContentPadding: true }, component: Screen })
function Screen() { return <PluginPage orgId={Route.useParams().orgId} id="members.list" /> }
