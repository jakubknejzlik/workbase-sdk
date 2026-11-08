import { ConsolePageGate } from '../../../console-pages'
import { createFileRoute, Outlet } from '@tanstack/react-router'
// List search validation belongs to the index, so its default never enters child URLs.
export const Route = createFileRoute('/o/$orgId/settings/workflows')({ staticData: { title: 'workflowRuns', crumb: 'workflowRuns', settingsActiveItem: 'workflowRuns' }, component: Screen })

function Screen() { return <ConsolePageGate orgId={Route.useParams().orgId} id="core.workflows"><Outlet /></ConsolePageGate> }
