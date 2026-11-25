import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '../components/ui/button'

/** Controlled page slots; query metadata, confirmed state and drafts belong to the host. */
export function ListPageComposition({ tabs, toolbar, panel, chips, children, footer }: { tabs?: ReactNode; toolbar: ReactNode; panel?: ReactNode; chips?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return <section data-slot="list-page" className="min-w-0 max-w-full overflow-hidden rounded-xl border bg-background">
    {tabs && <div data-list-slot="tabs" className="min-w-0 border-b px-3 sm:px-4">{tabs}</div>}
    <div data-list-slot="toolbar" className="flex min-w-0 flex-wrap items-center gap-3 border-b p-3 sm:p-4">{toolbar}</div>
    {panel && <div data-list-slot="panel" className="border-b bg-muted/30 p-3 sm:p-4">{panel}</div>}
    {chips && <div data-list-slot="chips" className="px-3 sm:px-4">{chips}</div>}
    <div data-list-slot="table" className="min-w-0">{children}</div>
    {footer && <div data-list-slot="footer" className="border-t">{footer}</div>}
  </section>
}
function revealViewTab(tab: HTMLElement) {
  const scroller = tab.parentElement!
  const clip = scroller.getBoundingClientRect(), box = tab.getBoundingClientRect()
  const style = getComputedStyle(scroller)
  const left = clip.left + scroller.clientLeft + parseFloat(style.paddingLeft)
  const right = clip.left + scroller.clientLeft + scroller.clientWidth - parseFloat(style.paddingRight)
  // Only this row scrolls; immediate movement also respects reduced motion.
  if (box.left < left) scroller.scrollLeft += box.left - left
  else if (box.right > right) scroller.scrollLeft += box.right - right
}
export function ListViewTabs({ label, views, value, onChange }: { label: string; views: { id: string; label: string; count?: number }[]; value: string; onChange: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const previousValue = useRef<string | undefined>(undefined)
  const anchor = useRef<{ tab: HTMLElement; scrollLeft: number } | null>(null)
  const reveal = (tab: HTMLElement) => {
    revealViewTab(tab)
    anchor.current = { tab, scrollLeft: scroller.current!.scrollLeft }
  }
  useLayoutEffect(() => {
    const group = scroller.current!
    const selectionChanged = previousValue.current !== value
    previousValue.current = value
    // Navigation chooses the selected tab; keyboard focus chooses its own tab.
    // Preserve that anchor as counts change widths, including on initial load.
    // Manual scrolling cancels an unfocused anchor instead of snapping back.
    const target = selectionChanged ? group.querySelector<HTMLElement>('[aria-pressed="true"]')
      : anchor.current && group.contains(anchor.current.tab) && (anchor.current.tab === document.activeElement || anchor.current.scrollLeft === group.scrollLeft) ? anchor.current.tab : null
    if (target) reveal(target)
    else anchor.current = null
  }, [value, views])
  // Padding exposes the focus outline; negative margins preserve the row's
  // existing tab positions and height when labels already fit. Inset the
  // outline at the panel's top edge, where the rounded panel also clips.
  return <div ref={scroller} role="group" aria-label={label} onFocusCapture={event => reveal(event.target)} className="-my-1 -ml-1 flex gap-5 overflow-x-auto scroll-p-1 whitespace-nowrap p-1">{views.map(view => <button type="button" key={view.id} aria-pressed={value === view.id} onClick={() => onChange(view.id)} className="flex min-h-12 max-w-full shrink-0 items-center gap-2 border-b-2 border-transparent text-sm text-muted-foreground focus-visible:-outline-offset-1 aria-pressed:border-primary aria-pressed:font-semibold aria-pressed:text-foreground">
    <span className="min-w-0 whitespace-normal">{view.label}</span>{Number.isSafeInteger(view.count) && view.count! >= 0 && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums">{view.count}</span>}
  </button>)}</div>
}
export interface ListFooterLabels { previous: string; next: string; loading?: string; pageSize: string; range: (start: number, end: number, total: number) => string; pageSizeOption?: (size: number) => string }
/** Exact total is server data. Unknown/error/loading never becomes zero. */
export function ListPageFooter({ total, page, limit, pageSize, maxOffset, busy, labels, onPage, onPageSize }: { total?: number; page: number; limit: number; pageSize: number; maxOffset: number; busy: boolean; labels: ListFooterLabels; onPage: (page: number) => void; onPageSize: (size: number) => void }) {
  const known = Number.isSafeInteger(total) && total! >= 0
  const pages = known ? Math.min(Math.max(1, Math.ceil(total! / limit)), Math.floor(maxOffset / limit) + 1) : 0
  const numbers = [...new Set([0, page - 2, page - 1, page, page + 1, page + 2, pages - 1])].filter(value => value >= 0 && value < pages).sort((a, b) => a - b)
  return <footer className="list-page-footer @container/list-footer flex flex-wrap items-center justify-between gap-3 text-sm">
    <div data-list-page-summary="" className="flex min-w-0 max-w-full flex-wrap items-center gap-x-4 gap-y-2">
      {busy && labels.loading && <p role="status" aria-live="polite" className="text-muted-foreground">{labels.loading}</p>}
      {known && <p data-list-range="" role={busy ? undefined : "status"} aria-live="polite" className="tabular-nums text-muted-foreground">{labels.range(total === 0 ? 0 : Math.min(page * limit + 1, total!), Math.min((page + 1) * limit, total!), total!)}</p>}
      <label className="mr-auto flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:mr-3">{labels.pageSize}<select aria-label={labels.pageSize} className="min-w-max shrink-0 rounded border bg-background p-1" value={pageSize} disabled={busy} onChange={event => onPageSize(Number(event.target.value))}>{[10, 20, 30, 50, 100].map(size => <option key={size} value={size}>{labels.pageSizeOption?.(size) ?? size}</option>)}</select></label>
    </div>
    {/* Keep focus rings inside the clip and reachable at both scroll limits. */}
    <div data-list-paging="" className="ml-auto flex max-w-full items-center gap-1 overflow-x-auto p-1 scroll-p-1" onFocusCapture={event => {
      if (event.currentTarget.scrollWidth > event.currentTarget.clientWidth) event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }}>
      {known && <span data-list-page-counter="" className="shrink-0 tabular-nums">{page + 1} / {pages}</span>}
      <Button type="button" variant="ghost" size="icon" aria-label={labels.previous} disabled={busy || !known || page <= 0} onClick={() => onPage(page - 1)}><ChevronLeft aria-hidden="true" className="size-4" /></Button>
      {/* Reserve room for three/four-digit pages through the supported 10,000
          offset at 10 rows/page, scaling with enlarged text. display:none
          removes collapsed numbers from the tab order; overflow stays scrollable. */}
      {numbers.map((number, index) => <span key={number} data-page-distance={Math.abs(number - page)} className={`${number === page ? 'inline-flex' : 'hidden @min-[28rem]/list-footer:inline-flex'} shrink-0 items-center`}>{index > 0 && number > numbers[index - 1] + 1 && <span aria-hidden="true" className="px-1">…</span>}<Button type="button" variant={number === page ? 'secondary' : 'ghost'} className="h-8 min-w-8 px-2" aria-current={number === page ? 'page' : undefined} disabled={busy} onClick={() => onPage(number)}>{number + 1}</Button></span>)}
      <Button type="button" variant="ghost" size="icon" aria-label={labels.next} disabled={busy || !known || page + 1 >= pages} onClick={() => onPage(page + 1)}><ChevronRight aria-hidden="true" className="size-4" /></Button>
    </div>
  </footer>
}

export function ListFilterPanel({ label, children, invalid, hint, applyLabel, cancelLabel, clearLabel, onApply, onCancel, onClear }: { label: string; children: ReactNode; invalid: boolean; hint: string; applyLabel: string; cancelLabel: string; clearLabel: string; onApply: () => void; onCancel: () => void; onClear: () => void }) {
  return <form role="group" aria-label={label} className="grid gap-4" onSubmit={event => { event.preventDefault(); if (!invalid) onApply() }}>
    <div className="grid grid-cols-1 items-start gap-4 min-[390px]:grid-cols-2 lg:grid-cols-4">{children}</div>
    <div className="flex flex-wrap items-center justify-end gap-2"><p className="mr-auto text-xs text-muted-foreground">{hint}</p><Button type="button" variant="ghost" onClick={onClear}>{clearLabel}</Button><Button type="button" variant="ghost" onClick={onCancel}>{cancelLabel}</Button><Button type="submit" disabled={invalid}>{applyLabel}</Button></div>
  </form>
}
