import { createFileRoute, redirect } from '@tanstack/react-router'
export const Route = createFileRoute('/o/$orgId/settings/')({ beforeLoad: ({ params }) => { throw redirect({ to: '/o/$orgId/settings/profile', params, replace: true }) } })
