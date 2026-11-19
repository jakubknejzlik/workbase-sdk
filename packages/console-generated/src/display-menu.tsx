import { Button } from '@workbasehq/ui/components/ui/button'
import { Checkbox } from '@workbasehq/ui/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@workbasehq/ui/components/ui/popover'

export interface DisplayColumn { id: string; label: string; visible: boolean }
export interface DisplayLabels { trigger: string; heading: string; hint: string; compact: string; reset: string }
/** Controlled, session-local display preference. It is not a permission and never reaches the query or saved views. */
export function DisplayMenu({ columns, compact, labels, onToggle, onCompact, onReset }: { columns: DisplayColumn[]; compact: boolean; labels: DisplayLabels; onToggle: (id: string, visible: boolean) => void; onCompact: (compact: boolean) => void; onReset: () => void }) {
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="outline">{labels.trigger}</Button></PopoverTrigger>
    <PopoverContent role="dialog" aria-label={labels.heading} align="end" className="grid w-72 max-w-[calc(100vw-1.5rem)] gap-2">
      <div><p className="text-sm font-semibold">{labels.heading}</p><p className="text-xs text-muted-foreground">{labels.hint}</p></div>
      {columns.map(column => <label key={column.id} className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={column.visible} onCheckedChange={value => onToggle(column.id, value === true)} />{column.label}</label>)}
      <hr />
      <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={compact} onCheckedChange={value => onCompact(value === true)} />{labels.compact}</label>
      <Button type="button" variant="ghost" className="justify-start" onClick={onReset}>{labels.reset}</Button>
    </PopoverContent>
  </Popover>
}
