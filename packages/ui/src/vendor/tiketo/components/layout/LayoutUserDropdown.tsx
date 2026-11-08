import type { ReactNode } from 'react'
import { ChevronsUpDown, LogOut, Loader2 } from 'lucide-react'
import { Avatar, AvatarFallback } from '../ui/avatar'
import { SidebarMenuButton, useSidebar } from '../ui/sidebar'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem } from '../ui/dropdown-menu'
export function LayoutUserDropdown({ user, label, signOutLabel, signOut, pending, pendingLabel, children, build, onCloseAutoFocus }: {
  user?: { name?: string; email?: string }; label: string; signOutLabel: string; signOut: () => void; pending?: boolean; pendingLabel?: string; children?: ReactNode; build?: ReactNode; onCloseAutoFocus?: (event: Event) => void
}) {
  const { isMobile } = useSidebar()
  const name = user?.name?.trim() || user?.email || label
  const identity = () => <><Avatar aria-hidden="true" className="h-8 w-8 rounded-lg"><AvatarFallback className="rounded-lg text-foreground">{name.charAt(0)}</AvatarFallback></Avatar><div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">{name}</span><span className="truncate text-xs">{user?.email}</span></div></>
  return <DropdownMenu><DropdownMenuTrigger asChild><SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"><span className="sr-only">{label}{' '}</span>{identity()}<ChevronsUpDown className="ml-auto size-4" /></SidebarMenuButton></DropdownMenuTrigger>
    <DropdownMenuContent onCloseAutoFocus={onCloseAutoFocus} className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg" side={isMobile ? 'bottom' : 'right'} align="end" sideOffset={4}>
      <DropdownMenuLabel className="p-0 font-normal"><div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{identity()}</div></DropdownMenuLabel><DropdownMenuSeparator />
      {children}{children && <DropdownMenuSeparator />}<DropdownMenuItem disabled={pending} onSelect={event => { event.preventDefault(); signOut() }} className="cursor-pointer"><LogOut className="size-4" />{pending ? <><Loader2 className="size-4 animate-spin" aria-hidden="true" />{pendingLabel ?? signOutLabel}</> : signOutLabel}</DropdownMenuItem>
      <DropdownMenuSeparator /><div className="px-2 py-1.5 text-xs text-muted-foreground text-center">{build}</div>
    </DropdownMenuContent>
  </DropdownMenu>
}
