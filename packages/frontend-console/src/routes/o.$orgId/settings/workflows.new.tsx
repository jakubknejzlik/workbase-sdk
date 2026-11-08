import { createFileRoute } from '@tanstack/react-router'
import { WorkflowStart } from '../../../workflows'
export const Route = createFileRoute('/o/$orgId/settings/workflows/new')({ staticData: { title: 'workflowStart', crumb: 'workflowStart' }, component: Screen })
function Screen() { const { orgId } = Route.useParams(); return <WorkflowStart orgId={orgId} /> }
