import { createFileRoute, redirect } from '@tanstack/react-router'
export const Route = createFileRoute('/o/$orgId/invitations')({ beforeLoad: ({ params }) => { throw redirect({ to: '/o/$orgId/settings/invitations', params, replace: true }) } })
