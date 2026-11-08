import { createFileRoute } from '@tanstack/react-router'
import { Organizations } from '../screens'
export const Route = createFileRoute('/organizations')({ staticData: { title: 'organizations', crumb: 'organizations' }, component: Organizations })
