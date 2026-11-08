import type { ReactNode } from 'react'
import { ResourcePageLayout, type ResourcePageLayoutProps } from '../components/resource-page/ResourcePageLayout'
export { ResourcePageLayout } from '../components/resource-page/ResourcePageLayout'
/** Compatibility API for config-driven callers; the shared composition owns the markup. */
export function ResourcePage({ title, actions, children, ...primaryAction }: { title: string; actions?: ReactNode; children: ReactNode } & Pick<ResourcePageLayoutProps, 'actionLabel' | 'onAction' | 'actionDisabled' | 'actionDisabledTooltip'>) {
  return <ResourcePageLayout title={title} headerActions={actions} {...primaryAction}>{children}</ResourcePageLayout>
}
