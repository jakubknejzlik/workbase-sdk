import { useState, type ReactNode } from 'react'
import { DataTableFilterDropdown as SourceFilter } from '../vendor/tiketo/components/data-table/DataTableFilterDropdown'
export function DataTableFilterDropdown({ children, ...props }: { label: string; active: boolean; activeLabel: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  return <SourceFilter {...props} open={open} onOpenChange={setOpen}>{open && children(() => setOpen(false))}</SourceFilter>
}
