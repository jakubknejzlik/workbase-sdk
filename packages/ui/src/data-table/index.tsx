import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { DataTableProvider } from '../vendor/tiketo/components/data-table/DataTableProvider'
import { DataTableContent } from '../vendor/tiketo/components/data-table/DataTableContent'
import { TablePresentationContext, useTablePresentation } from './presentation'
/** Provider bridge for complete collections and independently bounded host lists. */
export function StaticDataTable<T>({ data, columns, label }: { data: T[]; columns: ColumnDef<T, any>[]; label: string }) {
  const presentation = useTablePresentation()
  const table = useReactTable({ data, columns, enableHiding: false, getCoreRowModel: getCoreRowModel() })
  return <TablePresentationContext.Provider value={{ ...presentation, label, emptyContent: null }}><DataTableProvider table={table}><div className="rounded-md border"><DataTableContent /></div></DataTableProvider></TablePresentationContext.Provider>
}
/** Compatibility name; rendering is always the source provider/content bridge. */
export const LegacyDataTable = StaticDataTable
export * from './row-actions'
export * from './complete-table'
