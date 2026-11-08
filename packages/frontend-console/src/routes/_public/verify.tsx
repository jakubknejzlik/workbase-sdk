import { createFileRoute } from '@tanstack/react-router'
import { Verify } from '../../screens'
export const Route = createFileRoute('/_public/verify')({ staticData: { title: 'verify', crumb: 'verify' }, component: Verify })
