import { createFileRoute } from '@tanstack/react-router'
import { WorkflowList } from '../../../workflows'
import { workflowFilter } from '../../../api/workflows'
export const Route = createFileRoute('/o/$orgId/settings/workflows/')({ validateSearch: (search: Record<string, unknown>) => ({ status: workflowFilter(search.status) }), component: Screen })
function Screen() { const { orgId } = Route.useParams(); const { status } = Route.useSearch(); return <WorkflowList orgId={orgId} filter={status} /> }
