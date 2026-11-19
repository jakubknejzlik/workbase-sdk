import type { ReactNode } from 'react'
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
    {footer && <div data-list-slot="footer" className="border-t p-3 sm:p-4">{footer}</div>}
  </section>
}
export function ListViewTabs({ label, views, value, onChange }: { label: string; views: { id: string; label: string; count?: number }[]; value: string; onChange: (id: string) => void }) {
  return <div role="group" aria-label={label} className="flex gap-5 overflow-x-auto whitespace-nowrap">{views.map(view => <button type="button" key={view.id} aria-pressed={value === view.id} onClick={() => onChange(view.id)} className="flex min-h-12 shrink-0 items-center gap-2 border-b-2 border-transparent text-sm text-muted-foreground aria-pressed:border-primary aria-pressed:font-semibold aria-pressed:text-foreground">
    {view.label}{Number.isSafeInteger(view.count) && view.count! >= 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums">{view.count}</span>}
  </button>)}</div>
}
export interface ListFooterLabels { previous: string; next: string; loading?: string; pageSize: string; range: (start: number, end: number, total: number) => string; pageSizeOption?: (size: number) => string }
/** Exact total is server data. Unknown/error/loading never becomes zero. */
export function ListPageFooter({ total, page, limit, pageSize, maxOffset, busy, labels, onPage, onPageSize }: { total?: number; page: number; limit: number; pageSize: number; maxOffset: number; busy: boolean; labels: ListFooterLabels; onPage: (page: number) => void; onPageSize: (size: number) => void }) {
  const known = Number.isSafeInteger(total) && total! >= 0
  const pages = known ? Math.min(Math.max(1, Math.ceil(total! / limit)), Math.floor(maxOffset / limit) + 1) : 0
  const numbers = [...new Set([0, page - 2, page - 1, page, page + 1, page + 2, pages - 1])].filter(value => value >= 0 && value < pages).sort((a, b) => a - b)
  return <footer className="flex flex-wrap items-center justify-between gap-3 text-sm">
    <div data-list-page-summary="" className="flex flex-wrap items-center gap-x-4 gap-y-2">
    {busy && labels.loading && <p role="status" aria-live="polite" className="text-muted-foreground">{labels.loading}</p>}
    {known && <p data-list-range="" role={busy ? undefined : "status"} aria-live="polite" className="tabular-nums text-muted-foreground">{labels.range(total === 0 ? 0 : Math.min(page * limit + 1, total!), Math.min((page + 1) * limit, total!), total!)}</p>}
    <label className="mr-auto flex items-center gap-2 sm:mr-3">{labels.pageSize}<select aria-label={labels.pageSize} className="rounded border bg-background p-1" value={pageSize} disabled={busy} onChange={event => onPageSize(Number(event.target.value))}>{[10, 20, 30, 50, 100].map(size => <option key={size} value={size}>{labels.pageSizeOption?.(size) ?? size}</option>)}</select></label></div>
    <div data-list-paging="" className="ml-auto flex max-w-full items-center gap-1 overflow-x-auto">
      <Button type="button" variant="ghost" size="icon" aria-label={labels.previous} disabled={busy || !known || page <= 0} onClick={() => onPage(page - 1)}><ChevronLeft aria-hidden="true" className="size-4" /></Button>
      {numbers.map((number, index) => <span key={number} data-page-distance={Math.abs(number - page)} className="inline-flex shrink-0 items-center">{index > 0 && number > numbers[index - 1] + 1 && <span aria-hidden="true" className="px-1">…</span>}<Button type="button" variant={number === page ? 'secondary' : 'ghost'} className="h-8 min-w-8 px-2" aria-current={number === page ? 'page' : undefined} disabled={busy} onClick={() => onPage(number)}>{number + 1}</Button></span>)}
      <Button type="button" variant="ghost" size="icon" aria-label={labels.next} disabled={busy || !known || page + 1 >= pages} onClick={() => onPage(page + 1)}><ChevronRight aria-hidden="true" className="size-4" /></Button>
    </div>
  </footer>
}

export function ListFilterPanel({ label, children, invalid, hint, applyLabel, cancelLabel, clearLabel, onApply, onCancel, onClear }: { label: string; children: ReactNode; invalid: boolean; hint: string; applyLabel: string; cancelLabel: string; clearLabel: string; onApply: () => void; onCancel: () => void; onClear: () => void }) {
  return <form role="group" aria-label={label} className="grid gap-4" onSubmit={event => { event.preventDefault(); if (!invalid) onApply() }}>
    <div className="grid grid-cols-1 gap-4 min-[390px]:grid-cols-2 lg:grid-cols-4">{children}</div>
    <div className="flex flex-wrap items-center justify-end gap-2"><p className="mr-auto text-xs text-muted-foreground">{hint}</p><Button type="button" variant="ghost" onClick={onClear}>{clearLabel}</Button><Button type="button" variant="ghost" onClick={onCancel}>{cancelLabel}</Button><Button type="submit" disabled={invalid}>{applyLabel}</Button></div>
  </form>
}
