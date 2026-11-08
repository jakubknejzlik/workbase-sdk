import { X } from 'lucide-react'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
export interface ActiveFilterChip { id: string; column: string; value: string; removeLabel: string; onRemove: () => void }
export function DataTableActiveFilters({ filters, label, clearLabel, onClear }: { filters: ActiveFilterChip[]; label: string; clearLabel: string; onClear: () => void }) {
  if (!filters.length) return null
  return (
    <div className="flex flex-wrap items-center gap-2 p-2 border-b bg-muted/30" aria-label={label} role="group">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      {filters.map(filter => (
        <Badge key={filter.id} variant="secondary" className="min-w-0 max-w-full whitespace-normal pr-1.5 text-xs font-normal">
          <span className="min-w-0 [overflow-wrap:anywhere]">{filter.column}: {filter.value}</span>
          <Button variant="ghost" type="button" size="sm" className="ml-1 h-auto p-0 hover:bg-transparent" onClick={filter.onRemove} aria-label={filter.removeLabel}>
            <X className="h-3 w-3" aria-hidden="true" />
          </Button>
        </Badge>
      ))}
      <Button variant="ghost" type="button" size="sm" onClick={onClear} className="ml-auto text-xs">{clearLabel}</Button>
    </div>
  )
}
