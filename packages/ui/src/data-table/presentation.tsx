import { createContext, useContext, type ReactNode } from 'react'
import type { Column } from '@tanstack/react-table'
/** Locale, CSP and server-cursor slots; contains no data fetching. */
export interface TablePresentation {
  tableClass?: string; label?: string;
  emptyContent: ReactNode; errorLabel: string; stale?: boolean; busy?: boolean
  headerId?: (id: string) => string; pagination?: ReactNode
  pageSizeLabel: string; pageSizes: number[]; pageSizeOption: (size: number) => string
}
export const TablePresentationContext = createContext<TablePresentation>({ emptyContent: 'No results.', errorLabel: 'Failed to load data', pageSizeLabel: 'Rows per page', pageSizes: [10, 20, 30, 40, 50], pageSizeOption: size => `${size} / page` })
export const useTablePresentation = () => useContext(TablePresentationContext)
/** Source pinning without runtime styles: only supported static widths enter the DOM. */
export function columnClass(column: Column<any>, cell = false) {
  const fixed = column.columnDef.meta?.fixedWidth
  const width = column.id === 'select' ? 'w-10 min-w-10 max-w-10' : fixed ? 'w-18 min-w-18 max-w-18' : ''
  const pinned = cell && column.getIsPinned() === 'right' ? 'sticky right-0 z-10 border-l bg-background group-hover:bg-muted' : ''
  return `${width} ${pinned} ${column.id === 'select' ? 'px-0' : ''}`
}
