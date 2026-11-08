import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'

/** Source token settings composition; host supplies authorized metadata/actions. */
export function APITokensSettings({ title, description, create, columns, rows, empty, loading }: {
  title: string; description: string; create?: ReactNode
  columns: { label: string; className?: string; mobileLabel?: boolean }[]
  rows: { id: string; cells: ReactNode[] }[]; empty: string; loading?: string
}) {
  return <div className="min-w-0 space-y-6">
    <div><h1 tabIndex={-1} className="text-lg font-medium">{title}</h1><p className="text-sm text-muted-foreground">{description}</p></div>
    {create && <div className="flex justify-end">{create}</div>}
    <div className="min-w-0 rounded-lg border">
      <Table aria-label={title} className="max-md:block">
        <TableHeader className="max-md:sr-only"><TableRow>{columns.map((column, index) => <TableHead key={column.label} className={index === columns.length - 1 ? 'text-right' : undefined}>{column.label}</TableHead>)}</TableRow></TableHeader>
        <TableBody className="max-md:block">{loading || !rows.length ? <TableRow className="max-md:block"><TableCell colSpan={columns.length} className="text-center text-muted-foreground max-md:block max-md:whitespace-normal"><span role={loading ? 'status' : undefined}>{loading ?? empty}</span></TableCell></TableRow> : rows.map(row => <TableRow key={row.id} className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-3 max-md:p-3">{row.cells.map((cell, index) => <TableCell key={index} className={cn('max-md:min-w-0 max-md:whitespace-normal max-md:p-0', index === row.cells.length - 1 ? 'text-right' : index === 0 ? 'font-medium' : undefined, columns[index].className)}>{columns[index].mobileLabel && <span className="mb-1 block text-xs text-muted-foreground md:hidden">{columns[index].label}</span>}{cell}</TableCell>)}</TableRow>)}</TableBody>
      </Table>
    </div>
  </div>
}
