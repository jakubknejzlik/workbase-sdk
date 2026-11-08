import { flexRender } from '@tanstack/react-table'

import type { RowData } from '@tanstack/react-table'

// Module augmentation: opt-in marker for columns that should pin their
// pixel width. Used by tables with few columns where the default
// proportional fill would over-stretch action or numeric columns.
//
// `fixedWidth` is *load-bearing in two places* — both must agree:
// 1. `<colgroup>` col `width: column.getSize()` (vs `'auto'`)
// 2. `getCommonPinningStyles` `width: column.getSize()` on `<th>`/`<td>`
//    (vs `undefined`, which lets the colgroup `'auto'` actually
//    auto-distribute under `table-layout: fixed`).
// Without (2), the browser treats every TH inline `width` as an explicit
// declaration and proportionally scales ALL columns to fill the table
// width — breaking the colgroup `'auto'` intent and inflating both
// "fixed" cols (40/72/120 px) and intended-auto cols past their target
// size. See [MEM-81] / TIK-153 RCA.
declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    fixedWidth?: boolean
  }
}

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table'
import { useDataTable } from './DataTableProvider'
import { useTablePresentation, columnClass } from '../../../../data-table/presentation'
import { AlertCircle } from 'lucide-react'

export const DataTableContent = <RecordType,>() => {
  const { table, isLoading, error, onRowClick, getRowTestId } = useDataTable<RecordType>()
  const presentation = useTablePresentation()
  const hasRows = table.getRowModel().rows?.length > 0

  // Don't show "No results" if we're loading and have no data yet
  // This prevents the flash of "No results" during pagination
  const showNoResults = !hasRows && !isLoading && !error
  const showError = error && !isLoading

  // Get all visible columns to create colgroup
  const visibleColumns = table.getVisibleLeafColumns()

  return (
    <div className="relative">
      {showError && hasRows && <div role="alert" className="flex items-center gap-2 p-3 text-destructive"><AlertCircle aria-hidden="true" className="size-4" /><p>{error.message}</p></div>}
      <Table className={`table-fixed ${presentation.tableClass ?? 'min-w-[600px]'}`} aria-label={presentation.label}>
        <colgroup>
          {visibleColumns.map((column) => {
            return <col key={column.id} className={columnClass(column)} />
          })}
        </colgroup>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const { column } = header
                const isSelectionColumn = column.id === 'select'
                return (
                  <TableHead
                    key={header.id}
                    scope="col"
                    aria-labelledby={presentation.headerId?.(column.id)}
                    aria-sort={column.getIsSorted() === 'asc' ? 'ascending' : column.getIsSorted() === 'desc' ? 'descending' : undefined}
                    className={columnClass(column, true)}
                  >
                    {isSelectionColumn ? (
                      <div className="flex justify-center">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </div>
                    ) : (
                      header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody className={presentation.stale ? 'opacity-90' : undefined}>
          {showError && !hasRows ? (
            <TableRow>
              <TableCell colSpan={Math.max(visibleColumns.length, 1)} className="h-32">
                <div role="alert" className="flex flex-col items-center justify-center gap-2 text-destructive">
                  <AlertCircle className="h-8 w-8" />
                  <p className="font-medium">{presentation.errorLabel}</p>
                  <p className="text-sm text-muted-foreground max-w-md text-center">
                    {error.message}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ) : hasRows ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-testid={getRowTestId?.(row.original) ?? 'data-table-row'}
                data-row-id={(row.original as { id?: string })?.id}
                data-state={row.getIsSelected() && 'selected'}
                className={onRowClick ? 'group cursor-pointer' : 'group'}
                onClick={onRowClick ? (e) => {
                  // Don't trigger row click if clicking on selection cell
                  const target = e.target as HTMLElement
                  if (presentation.stale || !(window.getSelection()?.isCollapsed ?? true) || target.closest('a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[data-selection-cell="true"]')) {
                    return
                  }
                  onRowClick(row.original)
                } : undefined}
              >
                {row.getVisibleCells().map((cell) => {
                  const isSelectionCell = cell.column.id === 'select'
                  return (
                    <TableCell
                      key={cell.id}
                      data-selection-cell={isSelectionCell ? 'true' : undefined}
                      className={columnClass(cell.column, true)}
                    >
                      {isSelectionCell ? (
                        <div className="flex justify-center">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      ) : (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))
          ) : showNoResults ? (
            <TableRow>
              <TableCell colSpan={Math.max(visibleColumns.length, 1)} className="h-24 text-center">
                {presentation.emptyContent}
              </TableCell>
            </TableRow>
          ) : (
            // Show empty body during loading to maintain table height
            <TableRow>
              <TableCell colSpan={Math.max(visibleColumns.length, 1)} className="h-24">
                &nbsp;
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {isLoading && (
        <div
          data-testid="data-table-loading"
          className="absolute inset-x-0 bottom-0 top-10 pointer-events-none flex items-center justify-center backdrop-blur-sm bg-background/50"

        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={24}
            height={24}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="animate-spin text-foreground"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        </div>
      )}
    </div>
  )
}
