import { createFileRoute } from '@tanstack/react-router'
import { ProfileSettings } from '../../profile'
export const Route = createFileRoute('/settings/profile')({ staticData: { title: 'profileSettings', crumb: 'profileSettings', noLayoutContentPadding: true }, component: ProfileSettings })
