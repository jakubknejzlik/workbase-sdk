import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceSettingsLayout } from '../settings'
export const Route = createFileRoute('/settings')({ staticData: { title: 'settings', crumb: 'settings', hasClickableBreadcrumb: false, noLayoutContentPadding: true }, component: () => <WorkspaceSettingsLayout /> })
