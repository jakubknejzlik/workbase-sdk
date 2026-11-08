import { createFileRoute } from '@tanstack/react-router'
import { AcceptInvitation } from '../../screens'
export const Route = createFileRoute('/_public/invitation')({ staticData: { title: 'acceptInvitation', crumb: 'acceptInvitation' }, component: AcceptInvitation })
