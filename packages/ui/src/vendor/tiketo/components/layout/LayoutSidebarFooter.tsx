import { SidebarFooter, SidebarMenu, SidebarMenuItem } from '../ui/sidebar'
import { type PropsWithChildren } from 'react'

export const LayoutSidebarFooter = ({ children }: PropsWithChildren) => (
  <SidebarFooter data-slot="account"><SidebarMenu><SidebarMenuItem>{children}</SidebarMenuItem></SidebarMenu></SidebarFooter>
)
