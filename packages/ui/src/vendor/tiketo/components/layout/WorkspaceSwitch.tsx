import { type ReactNode, useMemo, useRef, useState } from 'react'
import { ChevronsUpDown, Building2, Plus } from 'lucide-react'
import { SidebarMenuButton } from '../ui/sidebar'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu'
import { Input } from '../ui/input'

export interface WorkspaceOption { id: string; name: string }
export function WorkspaceSwitch({ workspaces, activeId, onSwitch, onAdd, label, selectLabel, placeholderLabel, searchLabel, currentLabel, emptyLabel, noMatchLabel, addLabel, extraItems }: {
  workspaces: WorkspaceOption[]; activeId?: string; onSwitch: (id: string) => void; onAdd?: () => void
  label: string; selectLabel: string; placeholderLabel: string; searchLabel: string; currentLabel: string; emptyLabel: string; noMatchLabel?: string; addLabel: string; extraItems?: ReactNode
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const adding = useRef(false)
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeId) ?? (workspaces.length === 1 ? workspaces[0] : undefined)
  const filteredWorkspaces = useMemo(() => workspaces.filter(workspace => workspace.name.toLowerCase().includes(searchQuery.trim().toLowerCase())), [workspaces, searchQuery])
  return <DropdownMenu onOpenChange={open => { if (!open) setSearchQuery('') }}>
    <DropdownMenuTrigger asChild aria-haspopup="dialog"><SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
      <span className="sr-only">{label}: </span>
      <div className="bg-muted text-foreground flex aspect-square size-8 items-center justify-center rounded-lg"><Building2 className="size-4" /></div>
      <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">{activeWorkspace?.name ?? placeholderLabel}{' '}</span>{activeWorkspace && <span className="truncate text-xs">{label}</span>}</div>
      <ChevronsUpDown className="ml-auto" />
    </SidebarMenuButton></DropdownMenuTrigger>
    <DropdownMenuContent onCloseAutoFocus={event => { if (adding.current) { event.preventDefault(); adding.current = false; onAdd?.() } }} role="dialog" aria-orientation={undefined} aria-labelledby={undefined} aria-label={selectLabel} className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg" align="start" sideOffset={4}>
      <DropdownMenuLabel className="text-muted-foreground text-xs">{selectLabel}</DropdownMenuLabel>
      <div className="px-2 pb-2" onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const items = event.currentTarget.closest('[role=dialog]')?.querySelectorAll<HTMLElement>('[role=menuitem]:not([data-disabled])')
          const target = event.key === 'ArrowDown' ? items?.[0] : items?.[items.length - 1]
          target?.focus()
        }
        if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
      }}><div onClick={event => event.stopPropagation()}><Input type="search" aria-label={searchLabel} placeholder={searchLabel} value={searchQuery} onChange={event => setSearchQuery(event.target.value)} className="h-9" autoFocus /></div></div>
      <div role="menu" aria-label={selectLabel}>{filteredWorkspaces.length === 0 ? <div className="px-2 py-6 text-center text-sm text-muted-foreground">{searchQuery.trim() ? noMatchLabel ?? emptyLabel : emptyLabel}</div> : filteredWorkspaces.map(workspace => <DropdownMenuItem key={workspace.id} onSelect={() => { if (workspace.id !== activeWorkspace?.id) onSwitch(workspace.id) }} className={`gap-2 p-2 ${workspace.id === activeWorkspace?.id ? 'bg-accent text-accent-foreground' : ''}`}>
        <div className="flex size-6 items-center justify-center rounded-md border"><Building2 className="size-3.5 shrink-0" /></div>{workspace.name}{' '}{workspace.id === activeWorkspace?.id && <span className="ml-auto text-xs text-muted-foreground">{currentLabel}</span>}
      </DropdownMenuItem>)}
      {extraItems}
      {onAdd && <><DropdownMenuSeparator /><DropdownMenuItem className="gap-2 p-2" onSelect={() => { adding.current = true }}><div className="flex size-6 items-center justify-center rounded-md border bg-transparent"><Plus className="size-4" /></div><div className="text-muted-foreground font-medium">{addLabel}</div></DropdownMenuItem></>}</div>
    </DropdownMenuContent>
  </DropdownMenu>
}
