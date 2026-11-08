import { createFileRoute, redirect } from '@tanstack/react-router'
export const Route = createFileRoute('/o/$orgId/tokens')({ beforeLoad: ({ params }) => { throw redirect({ to: '/o/$orgId/settings/api-tokens', params, replace: true }) } })
