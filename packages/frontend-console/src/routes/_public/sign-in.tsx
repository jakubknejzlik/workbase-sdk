import { createFileRoute } from '@tanstack/react-router'
import { SignIn } from '../../screens'
export const Route = createFileRoute('/_public/sign-in')({ staticData: { title: 'signIn', crumb: 'signIn' }, component: SignIn })
