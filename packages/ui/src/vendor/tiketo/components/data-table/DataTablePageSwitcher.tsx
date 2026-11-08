import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { useDataTable } from './DataTableProvider'
import { useTablePresentation } from '../../../../data-table/presentation'

export function DataTablePageSwitcher<TData>() {
  const { table } = useDataTable<TData>()

  const presentation = useTablePresentation()
  return (
    <Select
      value={`${table.getState().pagination.pageSize}`}
      onValueChange={(value) => {
        table.setPageSize(Number(value))
      }}
    >
      <SelectTrigger aria-label={presentation.pageSizeLabel} disabled={presentation.busy} className="h-8 w-[120px]" size="sm">
        <SelectValue placeholder={table.getState().pagination.pageSize} />
      </SelectTrigger>
      <SelectContent side="top">
        {presentation.pageSizes.map((pageSize) => (
          <SelectItem key={pageSize} value={`${pageSize}`}>
            {presentation.pageSizeOption(pageSize)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
