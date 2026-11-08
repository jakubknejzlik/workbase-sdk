import { createFileRoute } from '@tanstack/react-router'
import { WorkflowDetail } from '../../../workflows'
export const Route = createFileRoute('/o/$orgId/settings/workflows/$id')({ staticData: { title: 'workflowRuns', crumb: 'workflowRuns' }, component: Screen })
function Screen() { const { orgId } = Route.useParams(); const { id } = Route.useParams(); return <WorkflowDetail orgId={orgId} id={id} /> }
