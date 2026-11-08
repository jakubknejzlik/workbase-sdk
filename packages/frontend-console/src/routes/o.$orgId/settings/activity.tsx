import { createFileRoute } from '@tanstack/react-router'
import { PluginPage } from '../../../console-pages'
export const Route = createFileRoute('/o/$orgId/settings/activity')({ staticData: { title: 'activity', crumb: 'activity' }, component: Screen })
function Screen() { const { orgId } = Route.useParams(); return <PluginPage orgId={orgId} id="audit.activity" /> }
