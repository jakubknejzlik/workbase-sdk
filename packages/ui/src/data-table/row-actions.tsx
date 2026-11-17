import { useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '../components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../components/ui/dropdown-menu'
export interface RowAction { id: string; label: string; destructive?: boolean; icon?: ReactNode }
/** Source row-menu pattern. One dialog outside the menu preserves the mutation session. */
export function RowActions({ label, items, disabled, children }: { label: string; items: RowAction[]; disabled?: boolean; children: (action: RowAction, close: () => void, restoreFocus: (event: Event) => void) => ReactNode }) {
  const [selected, setSelected] = useState<string>()
  const trigger = useRef<HTMLButtonElement>(null)
  const requested = useRef<string | undefined>(undefined)
  const action = items.find(item => item.id === selected)
  if (!items.length) return null
  const restoreFocus = (event: Event) => { event.preventDefault(); trigger.current?.focus() }
  return <div data-row-actions="" onClick={event => event.stopPropagation()}>
    <DropdownMenu><DropdownMenuTrigger asChild><Button ref={trigger} type="button" variant="ghost" size="icon" disabled={disabled} aria-label={label}><MoreHorizontal className="size-4" aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (requested.current) { event.preventDefault(); const id = requested.current; requested.current = undefined; setSelected(id) } }}>
        {items.map((item, index) => <div key={item.id}>{item.destructive && index > 0 && <DropdownMenuSeparator />}<DropdownMenuItem variant={item.destructive ? 'destructive' : 'default'} onSelect={() => { requested.current = item.id }}>{item.icon}{item.label}</DropdownMenuItem></div>)}
      </DropdownMenuContent>
    </DropdownMenu>
    {action && children(action, () => setSelected(undefined), restoreFocus)}
  </div>
}
