import { createFileRoute, Outlet } from '@tanstack/react-router'
export const Route = createFileRoute('/o/$orgId')({ staticData: { title: 'organizations', crumb: 'organizations' }, component: OrganizationOutlet })
function OrganizationOutlet() {
  const { orgId } = Route.useParams()
  // Preserved routes must start with fresh filters, cursors and action/form state.
  return <Outlet key={orgId} />
}
