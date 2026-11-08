import { SidebarHeader, SidebarMenu, SidebarMenuItem } from '../ui/sidebar'
import { type PropsWithChildren } from 'react'

/** Workspace controller replaces the source's optional static brand link. */
export const LayoutSidebarHeader = ({ children }: PropsWithChildren) => (
  <SidebarHeader><SidebarMenu><SidebarMenuItem data-slot="workspace">{children}</SidebarMenuItem></SidebarMenu></SidebarHeader>
)
