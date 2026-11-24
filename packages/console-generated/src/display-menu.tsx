import { Button } from '@workbasehq/ui/components/ui/button'
import { ColumnsIcon } from '@workbasehq/ui'
import { Checkbox } from '@workbasehq/ui/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@workbasehq/ui/components/ui/popover'
import { useLayoutEffect, useRef } from 'react'

export interface DisplayColumn { id: string; label: string; visible: boolean }
export interface DisplayLabels { trigger: string; heading: string; hint: string; compact: string; reset: string; moveUp: (column: string) => string; moveDown: (column: string) => string }
/** Controlled, session-local display preference. It is not a permission and never reaches the query or saved views. */
export function DisplayMenu({ columns, compact, labels, onToggle, onMove, onCompact, onReset }: { columns: DisplayColumn[]; compact: boolean; labels: DisplayLabels; onToggle: (id: string, visible: boolean) => void; onMove: (id: string, direction: -1 | 1) => void; onCompact: (compact: boolean) => void; onReset: () => void }) {
  const rows = useRef(new Map<string, HTMLDivElement>())
  const moved = useRef<{ id: string; direction: -1 | 1 } | null>(null)
  const visible = columns.filter(column => column.visible)
  useLayoutEffect(() => {
    if (!moved.current) return
    const row = rows.current.get(moved.current.id)
    // At an end the activated button becomes disabled; keep focus on the same column's other control.
    const target = row?.querySelector<HTMLButtonElement>(`[data-move="${moved.current.direction}"]:not(:disabled)`) ?? row?.querySelector<HTMLButtonElement>('button[data-move]:not(:disabled)')
    target?.focus()
    moved.current = null
  }, [columns])
  return <Popover>
    <PopoverTrigger asChild><Button type="button" title={labels.trigger} variant="outline"><ColumnsIcon aria-hidden="true" className="size-4" />{labels.trigger}</Button></PopoverTrigger>
    <PopoverContent data-list-display="" role="dialog" aria-label={labels.heading} align="end" className="flex max-h-[min(75dvh,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2 overflow-hidden">
      <div className="shrink-0"><p className="text-sm font-semibold">{labels.heading}</p><p className="text-xs text-muted-foreground">{labels.hint}</p></div>
      <div data-list-display-columns="" className="grid max-h-[37dvh] min-h-0 gap-2 overflow-y-auto">
        {columns.map(column => <div key={column.id} ref={row => { if (row) rows.current.set(column.id, row); else rows.current.delete(column.id) }} className="flex min-h-8 items-center gap-2 text-sm">
          <label className="flex min-w-0 flex-1 items-center gap-2"><Checkbox checked={column.visible} onCheckedChange={value => onToggle(column.id, value === true)} /><span className="min-w-0 break-words [overflow-wrap:anywhere]">{column.label}</span></label>
          {([-1, 1] as const).map(direction => <Button key={direction} data-move={direction} type="button" variant="ghost" size="icon-sm" aria-label={direction === -1 ? labels.moveUp(column.label) : labels.moveDown(column.label)} disabled={!column.visible || visible.indexOf(column) + direction < 0 || visible.indexOf(column) + direction >= visible.length} onClick={() => { moved.current = { id: column.id, direction }; onMove(column.id, direction) }}><svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={direction === -1 ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} /></svg></Button>)}
        </div>)}
      </div>
      <div className="grid shrink-0 gap-2">
        <hr />
        <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={compact} onCheckedChange={value => onCompact(value === true)} />{labels.compact}</label>
        <Button type="button" variant="ghost" className="justify-start" onClick={onReset}>{labels.reset}</Button>
      </div>
    </PopoverContent>
  </Popover>
}
