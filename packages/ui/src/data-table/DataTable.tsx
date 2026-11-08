import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { getCoreRowModel, useReactTable, type ColumnDef, type HeaderContext, type CellContext } from '@tanstack/react-table'
import { DataTableProvider } from '../vendor/tiketo/components/data-table/DataTableProvider'
import { DataTableContent } from '../vendor/tiketo/components/data-table/DataTableContent'
import { DataTableFooter } from '../vendor/tiketo/components/data-table/DataTableFooter'
import { mapColumn } from '../vendor/tiketo/components/data-table/DataTableColumn'
import { TablePresentationContext } from './presentation'
import { DataTableSearch } from './DataTableSearch'
import { CursorPagination, type PaginationLabels } from './cursor-pagination'
import { Button } from '../components/ui/button'
export interface DataTableState { search: string; sort: { key: string; direction: 'asc' | 'desc' } | null; limit: number }
export interface ServerColumn<T> { id: string; label: string; sortable?: boolean; filter?: ReactNode; cell: (row: T) => ReactNode }
interface ServerMeta<T> { compact?: boolean; serverColumn: ServerColumn<T>; labelId: string; sortLabel: string }
/** Stable React render types retain focused headers and open mutation sessions across query updates. */
function ServerFilter({ column }: { column: { filterOptions?: { renderFilter?: () => ReactNode } } }) { return column.filterOptions?.renderFilter?.() }
function ServerHeader<T>(context: HeaderContext<T, unknown>) {
  const meta = context.column.columnDef.meta as ServerMeta<T>
  const column = meta.serverColumn
  const definition = mapColumn({ id: column.id, title: column.label, type: column.id === '_actions' ? 'actions' : 'string', filterable: !!column.filter, filterOptions: { renderFilter: () => column.filter } }, {
    labelId: meta.labelId, sortLabel: () => meta.sortLabel, enableFilters: true, FilterDropdown: ServerFilter,
  })
  return (definition.header as (context: HeaderContext<T, unknown>) => ReactNode)(context)
}
function ServerCell<T>({ column, row }: CellContext<T, unknown>) {
  const config = (column.columnDef.meta as ServerMeta<T>).serverColumn
  return column.id === '_actions' ? config.cell(row.original) : <div className={(column.columnDef.meta as ServerMeta<T>).compact ? "whitespace-normal break-words" : "truncate"} ref={node => { if (node) node.title = node.textContent ?? '' }}>{config.cell(row.original)}</div>
}
/** Workbase owns server state; the source provider renders it without local filtering/paging. */
export function DataTable<T extends { id?: unknown }>({ rows, columns, state, onStateChange, page, range, onPage, nextCursor, isFetching, label, labels, onRowClick, searchDescription, searchAvailable = true, pendingSearch = false, staleLabel, clearFilters, onClearFilters, error, compact = false, mobileCards = false }: {
  compact?: boolean; mobileCards?: boolean
  rows: T[]; columns: ServerColumn<T>[]; state: DataTableState; onStateChange: (state: DataTableState, change: 'search' | 'sort' | 'limit') => void
  page: number; range?: { page: number; limit: number }; onPage: (direction: 'previous' | 'next') => void; nextCursor?: string | null; isFetching: boolean; label: string
  labels: PaginationLabels & { search: string; clearSearch: string; noResults: string; sort: (column: string) => string; sortAndFilter?: string; sortStates?: { asc: string; desc: string; none: string }; error?: string }
  onRowClick: (row: T) => void; searchDescription?: string; searchAvailable?: boolean; pendingSearch?: boolean; staleLabel?: string; clearFilters?: string; onClearFilters?: () => void; error?: Error | null
}) {
  const narrow = useSyncExternalStore(callback => {
    const media = window.matchMedia('(max-width: 480px)'); media.addEventListener('change', callback)
    return () => media.removeEventListener('change', callback)
  }, () => window.matchMedia('(max-width: 480px)').matches, () => false) && !mobileCards && columns.some(column => column.id === '_actions')
  const labelPrefix = useId()
  const [controlsOpen, setControlsOpen] = useState(false)
  const [searchPending, setSearchPending] = useState(false)
  const stale = isFetching || searchPending || pendingSearch || !!staleLabel
  const definitions: ColumnDef<T, unknown>[] = columns.map(column => {
    const actions = column.id === '_actions'
    return { id: column.id, accessorFn: () => undefined,
      enableSorting: !!column.sortable, enableHiding: false,
      ...(actions ? { size: 72 } : {}),
      meta: { compact, fixedWidth: actions, serverColumn: column, labelId: `${labelPrefix}-${column.id}`, sortLabel: labels.sort(column.label) },
      header: ServerHeader, cell: ServerCell,
    }
  })
  const table = useReactTable({ data: rows, columns: definitions, getCoreRowModel: getCoreRowModel(), getRowId: (row, index) => String(row.id ?? index),
    enableMultiSort: false, manualSorting: true, manualFiltering: true, manualPagination: true,
    state: { columnVisibility: narrow ? Object.fromEntries(columns.slice(1).filter(column => column.id !== '_actions').map(column => [column.id, false])) : {}, sorting: state.sort ? [{ id: state.sort.key, desc: state.sort.direction === 'desc' }] : [], pagination: { pageIndex: page, pageSize: state.limit }, columnPinning: { right: columns.some(column => column.id === '_actions') ? ['_actions'] : [] } },
    onSortingChange: updater => { const next = typeof updater === 'function' ? updater(table.getState().sorting) : updater; onStateChange({ ...state, sort: next[0] ? { key: next[0].id, direction: next[0].desc ? 'desc' : 'asc' } : null }, 'sort') },
    onPaginationChange: updater => { const next = typeof updater === 'function' ? updater(table.getState().pagination) : updater; if (next.pageSize !== state.limit) onStateChange({ ...state, limit: next.pageSize }, 'limit') },
  })
  const visibleCount = table.getVisibleLeafColumns().length
  // Keep the W44 primary + Actions layout without removing the other columns'
  // server sort/filter operations. Only authorized, configured columns reach here.
  const hiddenControls = narrow ? table.getAllLeafColumns().filter(column => !column.getIsVisible() && (column.getCanSort() || (column.columnDef.meta as ServerMeta<T>).serverColumn.filter)) : []
  return <TablePresentationContext.Provider value={{ tableClass: narrow ? 'w-full' : compact ? 'w-full min-w-[900px] md:min-w-0' : visibleCount <= 2 ? 'min-w-[320px]' : visibleCount <= 3 ? 'min-w-[600px]' : visibleCount <= 5 ? 'min-w-[900px]' : visibleCount <= 8 ? 'min-w-[1400px]' : 'min-w-[2200px]', label, headerId: id => `${labelPrefix}-${id}`, stale, busy: stale,
    errorLabel: labels.error ?? 'Failed to load data', emptyContent: <div className="space-y-2 p-6 text-center text-muted-foreground"><p>{labels.noResults}</p>{onClearFilters && <Button type="button" variant="outline" onClick={onClearFilters}>{clearFilters}</Button>}</div>,
    pageSizeLabel: labels.pageSize, pageSizes: [10, 20, 30, 50, 100], pageSizeOption: size => labels.pageSizeOption?.(size) ?? String(size),
    pagination: <CursorPagination range={range} page={page} limit={state.limit} length={rows.length} hasNext={!!nextCursor} busy={stale} labels={labels} onPage={onPage} />,
  }}><DataTableProvider table={table} isLoading={isFetching} error={error} onRowClick={onRowClick}>
    <div className={`w-full min-w-0 max-w-full ${compact ? 'compact-data-table' : ''}`} data-slot="data-table">
      {searchAvailable && <div className="flex flex-wrap items-center gap-3 py-4"><DataTableSearch value={state.search} onChange={search => onStateChange({ ...state, search }, 'search')} label={labels.search} clearLabel={labels.clearSearch} description={searchDescription} onPendingChange={setSearchPending} /></div>}
      {hiddenControls.length > 0 && <div className="my-2">
        <Button type="button" variant="outline" aria-expanded={controlsOpen} aria-controls={`${labelPrefix}-controls`} onClick={() => setControlsOpen(open => !open)}>{labels.sortAndFilter ?? 'Sort and filter'}</Button>
        {controlsOpen && <div id={`${labelPrefix}-controls`} role="group" aria-label={labels.sortAndFilter ?? 'Sort and filter'} className="mt-2 space-y-2 rounded-md border p-2">
          {hiddenControls.map(column => {
            const config = (column.columnDef.meta as ServerMeta<T>).serverColumn
            const direction = column.getIsSorted()
            return <div key={column.id} className="flex min-w-0 items-center justify-between gap-2">
              {column.getCanSort() ? <>
                <Button type="button" variant="ghost" className="min-w-0 whitespace-normal text-left" aria-label={labels.sort(config.label)} aria-pressed={!!direction} aria-describedby={`${labelPrefix}-${column.id}-sort-state`} onClick={() => direction === 'desc' ? column.clearSorting() : column.toggleSorting(direction === 'asc')}>
                  <span className="min-w-0 break-words">{config.label}</span><span className="shrink-0" aria-hidden="true">{direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕'}</span>
                </Button>
                <span id={`${labelPrefix}-${column.id}-sort-state`} className="sr-only">{(labels.sortStates ?? { asc: 'Ascending', desc: 'Descending', none: 'Not sorted' })[direction || 'none']}</span>
              </> : <span className="min-w-0 break-words px-2">{config.label}</span>}
              {config.filter}
            </div>
          })}
        </div>}
      </div>}
      {mobileCards && <div className="mb-3 flex flex-wrap gap-2 md:hidden">{columns.filter(column => column.filter).map(column => <div key={column.id} className="inline-flex items-center gap-1 text-sm"><span>{column.label}</span>{column.filter}</div>)}</div>}
      {staleLabel && <p role="status" className="py-2 text-sm">{staleLabel}</p>}
      <div data-stale={stale} aria-busy={stale} className={`min-w-0 max-w-full rounded-md border ${mobileCards ? 'hidden md:block' : ''}`}><DataTableContent /></div>
      {mobileCards && <div className="md:hidden" aria-busy={stale}>
        {error && <p role="alert">{labels.error}</p>}
        {!rows.length && <p className="p-4">{labels.noResults}</p>}
        <ul className="grid gap-3">{rows.map((row, index) => <li key={String(row.id ?? index)} className="rounded-md border p-4"><dl className="grid grid-cols-2 gap-3">{table.getVisibleLeafColumns().map(column => {
          const config = (column.columnDef.meta as ServerMeta<T>).serverColumn
          return <div key={column.id} className={`min-w-0 ${column.id === columns[0]?.id || column.id === columns.at(-1)?.id ? 'col-span-2' : ''}`}><dt className="text-xs text-muted-foreground">{column.getCanSort() ? <button type="button" className="inline-flex min-h-8 items-center gap-1" aria-label={labels.sort(config.label)} onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}>{config.label}{column.getIsSorted() === 'asc' ? ' ↑' : column.getIsSorted() === 'desc' ? ' ↓' : ' ↕'}</button> : config.label}</dt><dd className="whitespace-normal break-words">{config.cell(row)}</dd></div>
        })}</dl></li>)}</ul>
      </div>}
      <DataTableFooter />
    </div>
  </DataTableProvider></TablePresentationContext.Provider>
}
