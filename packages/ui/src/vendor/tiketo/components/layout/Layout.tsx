import { SidebarInset, SidebarProvider } from '../ui/sidebar'
import { type PropsWithChildren, type ReactNode } from 'react'
import { LayoutHeader } from './LayoutHeader'
import { LayoutSidebar } from './LayoutSidebar'
import { LayoutSidebarFooter } from './LayoutSidebarFooter'
import { LayoutSidebarHeader } from './LayoutSidebarHeader'
import { LayoutSidebarContent } from './LayoutSidebarContent'
import { LayoutContent } from './LayoutContent'

export function LayoutBase({ children }: PropsWithChildren) {
  return <div className="[--header-height:calc(--spacing(14))]"><SidebarProvider><div className="flex flex-1 min-w-0 w-full">{children}</div></SidebarProvider></div>
}

/** Route, capability and focus controllers are host-owned slots. */
export function Layout({ sidebar, header, children, noContentPadding }: PropsWithChildren<{
  sidebar: { props: React.ComponentProps<typeof LayoutSidebar>; header?: ReactNode; content: ReactNode; footer?: ReactNode }
  header: ReactNode; noContentPadding?: boolean
}>) {
  return <>
    <LayoutSidebar {...sidebar.props}>
      <LayoutSidebarHeader>{sidebar.header}</LayoutSidebarHeader>
      <LayoutSidebarContent>{sidebar.content}</LayoutSidebarContent>
      <LayoutSidebarFooter>{sidebar.footer}</LayoutSidebarFooter>
    </LayoutSidebar>
    <SidebarInset>
      {header}
      <LayoutContent noPadding={noContentPadding}>{children}</LayoutContent>
    </SidebarInset>
  </>
}
export { LayoutHeader }
