import { createFileRoute, redirect } from '@tanstack/react-router'
export const Route = createFileRoute('/o/$orgId/members')({ beforeLoad: ({ params }) => { throw redirect({ to: '/o/$orgId/settings/workspace-members', params, replace: true }) } })
