'use client'

import { DataTablePageSwitcher } from './DataTablePageSwitcher'
import { DataTablePagination } from './DataTablePagination'
import { useTablePresentation } from '../../../../data-table/presentation'

export function DataTableFooter() {
  const presentation = useTablePresentation()
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 px-2 py-4 text-sm">
      {presentation.pagination ?? <DataTablePagination />}
      <div className="flex items-center space-x-6 lg:space-x-8">
        <div className="flex items-center space-x-2">
          <DataTablePageSwitcher />
        </div>
      </div>
    </div>
  )
}
