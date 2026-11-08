import { createFileRoute } from '@tanstack/react-router'
import { PluginPage } from '../../console-pages'
export const Route = createFileRoute('/o/$orgId/$')({ component: Screen })
function Screen() { return <PluginPage orgId={Route.useParams().orgId} /> }
