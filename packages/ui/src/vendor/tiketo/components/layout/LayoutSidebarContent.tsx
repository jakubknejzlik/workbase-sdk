import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type PropsWithChildren, type ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { SidebarContent, SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from '../ui/sidebar'

/** Host supplies the dynamic hierarchy after role/capability filtering. */
export const LayoutSidebarContent = ({ children }: PropsWithChildren) => (
  <SidebarContent><SidebarGroup><SidebarGroupContent>{children}</SidebarGroupContent></SidebarGroup></SidebarContent>
)
export function LayoutNavigationItem({ active, children }: { active?: boolean; children: ReactNode }) {
  return <SidebarMenuItem><SidebarMenuButton asChild isActive={active} className="data-[active=true]:bg-primary data-[active=true]:text-primary-foreground">{children}</SidebarMenuButton></SidebarMenuItem>
}
export function LayoutNavigationSubItem({ active, children }: { active?: boolean; children: ReactNode }) {
  return <SidebarMenuSubItem><SidebarMenuSubButton asChild isActive={active} className="data-[active=true]:bg-primary data-[active=true]:text-primary-foreground">{children}</SidebarMenuSubButton></SidebarMenuSubItem>
}
export function LayoutNavigationGroup({ label, active, children, icon }: { label: string; active: boolean; children: ReactNode; icon?: ReactNode }) {
  const [open, setOpen] = useState(active)
  useEffect(() => { if (active) setOpen(true) }, [active])
  return <Collapsible asChild className="group/collapsible" open={open} onOpenChange={setOpen}>
    <SidebarMenuItem><CollapsibleTrigger asChild><SidebarMenuButton>{icon}<span className="text-sm">{label}</span><ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" /></SidebarMenuButton></CollapsibleTrigger>
      <CollapsibleContent><SidebarMenuSub>{children}</SidebarMenuSub></CollapsibleContent>
    </SidebarMenuItem>
  </Collapsible>
}
export { SidebarMenu }
