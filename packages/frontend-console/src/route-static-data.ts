import type { ReactNode } from 'react'
import type { AnyRouteMatch } from '@tanstack/react-router'
// C6a records data only. C6b consumes it; API authorization remains authoritative.
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    noLayoutContentPadding?: boolean
    hasClickableBreadcrumb?: boolean
    parentCrumbs?: { label: string; href: string }[]
    rootBreadcrumbClickable?: boolean
    title?: ReactNode
    icon?: ReactNode
    settingsActiveItem?: string
    crumb?: ReactNode | ((match: AnyRouteMatch) => ReactNode)
  }
}
