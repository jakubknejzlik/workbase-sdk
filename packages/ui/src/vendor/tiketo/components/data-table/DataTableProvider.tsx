import { useReactTable } from '@tanstack/react-table'
import * as React from 'react'
import type { DataTableColumn } from './DataTableColumn'

interface DataTableContextValue<RecordType> {
  table: ReturnType<typeof useReactTable<RecordType>>
  isLoading?: boolean
  /** Error from data fetching */
  error?: Error | null
  onRowClick?: (row: RecordType) => void
  getRowTestId?: (row: RecordType) => string | undefined
  /** Current global search value */
  searchValue?: string
  /** Handler to update search value */
  onSearchChange?: (value: string) => void
  /** Placeholder for search input */
  searchPlaceholder?: string
  /** Whether global search is enabled */
  searchEnabled?: boolean
  /** Fetch all filtered rows (no pagination) for export */
  getExportData?: () => Promise<Record<string, unknown>[]>
  /** Original column definitions (for export headers/values) */
  exportColumns?: DataTableColumn<RecordType, any>[]
  /** Filename prefix for exported files */
  exportFilename?: string

}

const DataTableContext = React.createContext<DataTableContextValue<any> | undefined>(undefined)

export function DataTableProvider<RecordType>({
  table,
  isLoading,
  error,
  onRowClick,
  getRowTestId,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchEnabled,
  getExportData,
  exportColumns,
  exportFilename,
  children,
}: React.PropsWithChildren<{
  table: ReturnType<typeof useReactTable<RecordType>>
  isLoading?: boolean
  error?: Error | null
  onRowClick?: (row: RecordType) => void
  getRowTestId?: (row: RecordType) => string | undefined
  searchValue?: string
  onSearchChange?: (value: string) => void
  searchPlaceholder?: string
  searchEnabled?: boolean
  getExportData?: () => Promise<Record<string, unknown>[]>
  exportColumns?: DataTableColumn<RecordType, any>[]
  exportFilename?: string
}>) {
  return (
    <DataTableContext.Provider
      value={{
        table,
        isLoading,
        error,
        onRowClick,
        getRowTestId,
        searchValue,
        onSearchChange,
        searchPlaceholder,
        searchEnabled,
        getExportData,
        exportColumns,
        exportFilename,
      }}
    >
      {children}
    </DataTableContext.Provider>
  )
}

export function useDataTable<RecordType>() {
  const context = React.useContext(DataTableContext)
  if (!context) {
    throw new Error('useDataTable must be used within a DataTableProvider')
  }
  return context as DataTableContextValue<RecordType>
}
