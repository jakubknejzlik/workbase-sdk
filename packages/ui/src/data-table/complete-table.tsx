import { getCoreRowModel, getPaginationRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { DataTableProvider } from '../vendor/tiketo/components/data-table/DataTableProvider'
import { DataTableContent } from '../vendor/tiketo/components/data-table/DataTableContent'
import { DataTableFooter } from '../vendor/tiketo/components/data-table/DataTableFooter'
import { TablePresentationContext, useTablePresentation, type TablePresentation } from './presentation'
/** Only for a collection the host knows is complete, never a server page/capped result. */
export function CompleteDataTable<T>({ data, columns, label, presentation }: { data: T[]; columns: ColumnDef<T, any>[]; label: string; presentation?: Partial<TablePresentation> }) {
  const defaults = useTablePresentation()
  const table = useReactTable({ data, columns, enableHiding: false, getCoreRowModel: getCoreRowModel(), getPaginationRowModel: getPaginationRowModel(), initialState: { pagination: { pageSize: 10 } } })
  return <TablePresentationContext.Provider value={{ ...defaults, ...presentation, label }}><DataTableProvider table={table}>
    <div className="rounded-md border"><DataTableContent /></div><DataTableFooter />
  </DataTableProvider></TablePresentationContext.Provider>
}
