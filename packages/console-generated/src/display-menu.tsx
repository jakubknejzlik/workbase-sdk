import { Button } from '@workbasehq/ui/components/ui/button'
import { ColumnsIcon } from '@workbasehq/ui'
import { Checkbox } from '@workbasehq/ui/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@workbasehq/ui/components/ui/popover'

export interface DisplayColumn { id: string; label: string; visible: boolean }
export interface DisplayLabels { trigger: string; heading: string; hint: string; compact: string; reset: string }
/** Controlled display preference. It is not a permission and never reaches the query or saved views. */
export function DisplayMenu({ columns, compact, labels, onToggle, onCompact, onReset }: { columns: DisplayColumn[]; compact: boolean; labels: DisplayLabels; onToggle: (id: string, visible: boolean) => void; onCompact: (compact: boolean) => void; onReset: () => void }) {
  return <Popover>
    <PopoverTrigger asChild><Button type="button" title={labels.trigger} variant="outline"><ColumnsIcon aria-hidden="true" className="size-4" />{labels.trigger}</Button></PopoverTrigger>
    <PopoverContent data-list-display="" role="dialog" aria-label={labels.heading} align="end" className="flex max-h-[min(75dvh,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2 overflow-hidden">
      <div className="shrink-0"><p className="text-sm font-semibold">{labels.heading}</p><p className="text-xs text-muted-foreground">{labels.hint}</p></div>
      <div data-list-display-columns="" className="grid max-h-[37dvh] min-h-0 gap-2 overflow-y-auto">
        {columns.map(column => <label key={column.id} className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={column.visible} onCheckedChange={value => onToggle(column.id, value === true)} />{column.label}</label>)}
      </div>
      <div className="grid shrink-0 gap-2">
        <hr />
        <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={compact} onCheckedChange={value => onCompact(value === true)} />{labels.compact}</label>
        <Button type="button" variant="ghost" className="justify-start" onClick={onReset}>{labels.reset}</Button>
      </div>
    </PopoverContent>
  </Popover>
}
