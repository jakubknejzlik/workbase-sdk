import * as React from 'react'
import { FilterIcon } from 'lucide-react'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '../../lib/utils'

export interface DataTableFilterDropdownProps {
  label: string; active: boolean; activeLabel: string
  open: boolean; onOpenChange: (open: boolean) => void
  children: React.ReactNode
}
export const DataTableFilterDropdown: React.FC<DataTableFilterDropdownProps> = ({ label, active, activeLabel, open, onOpenChange, children }) => (
  <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" data-filter-trigger=""
        className={cn('h-8 w-8 p-0 relative group shrink-0', 'md:h-8 md:w-8', 'touch:h-10 touch:w-10')}
        aria-label={label} aria-description={active ? activeLabel : undefined}
        aria-expanded={open} aria-haspopup="dialog" title={label}>
        <FilterIcon aria-hidden="true" className={cn('h-4 w-4 transition-all', active && 'fill-current')} />
        {active && <span className="sr-only">{activeLabel}</span>}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" aria-label={label} className="w-80 max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto p-3"
      onInteractOutside={event => { if ((event.target as HTMLElement).closest('[role="dialog"],[role="listbox"]')) event.preventDefault() }}>
      {children}
    </PopoverContent>
  </Popover>
)
