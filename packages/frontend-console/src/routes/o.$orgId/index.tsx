import { createFileRoute } from '@tanstack/react-router'
import { PluginPage } from '../../console-pages'
export const Route = createFileRoute('/o/$orgId/')({ staticData: { title: 'overview', crumb: 'overview' }, component: Home })
function Home() { const { orgId } = Route.useParams(); return <PluginPage orgId={orgId} /> }
