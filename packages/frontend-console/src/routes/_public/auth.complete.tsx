import { createFileRoute } from '@tanstack/react-router'
import { Complete } from '../../screens'
export const Route = createFileRoute('/_public/auth/complete')({ staticData: { title: 'authComplete', crumb: 'authComplete' }, component: Complete })
