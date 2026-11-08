import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '../components/ui/button'
export interface PaginationLabels {
  previous: string; next: string; pageSize: string; range: (start: number, end: number) => string
  previousText?: string; nextText?: string; pageSizeOption?: (size: number) => string
}
/** Cursor histories prove adjacent pages only. Never derive a total or a last page. */
export function CursorPagination({ page, limit, range, length, hasNext, busy, labels, onPage }: { page: number; limit: number; range?: { page: number; limit: number }; length: number; hasNext: boolean; busy: boolean; labels: PaginationLabels; onPage: (direction: 'previous' | 'next') => void }) {
  const offset = (range?.page ?? page) * (range?.limit ?? limit)
  return <>
    {length > 0 && <p role="status" aria-live="polite" className="sr-only">{labels.range(offset + 1, offset + length)}</p>}
    <Button type="button" variant="ghost" disabled={!page || busy} aria-label={labels.previous} onClick={() => onPage('previous')}><ChevronLeft className="size-4" aria-hidden="true" /><span className="hidden lg:inline">{labels.previousText ?? labels.previous}</span></Button>
    {page > 0 && <Button type="button" variant="ghost" className="hidden sm:inline-flex" disabled={busy} onClick={() => onPage('previous')}>{page}</Button>}
    <Button type="button" variant="outline" aria-current="page" aria-disabled="true">{page + 1}</Button>
    {hasNext && <Button type="button" variant="ghost" className="hidden sm:inline-flex" disabled={busy} onClick={() => onPage('next')}>{page + 2}</Button>}
    <Button type="button" variant="ghost" disabled={!hasNext || busy} aria-label={labels.next} onClick={() => onPage('next')}><span className="hidden lg:inline">{labels.nextText ?? labels.next}</span><ChevronRight className="size-4" aria-hidden="true" /></Button>
  </>
}
