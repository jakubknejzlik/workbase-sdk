import type { ReactNode } from 'react'
import { LegacyDataTable } from './index'
export interface ListColumn<T> { key: string; label: string; render: (row: T) => ReactNode }
/** One data source, a semantic table on desktop and labelled cards below md. */
export function ResponsiveList<T>({ data, columns, label, rowKey }: { data: T[]; columns: ListColumn<T>[]; label: string; rowKey: (row: T) => string }) {
  return <><div className="wb-desktop-list hidden md:block"><LegacyDataTable<T> data={data} label={label} columns={columns.map(column => ({ id: column.key, header: column.label, cell: ({ row }) => column.render(row.original) }))} /></div>
    <ul className="wb-card-list grid gap-3 md:hidden" aria-label={label}>{data.map(row => <li className="rounded-lg border bg-card p-4" key={rowKey(row)}><dl className="grid gap-3">{columns.map(column => <div key={column.key}><dt className="text-sm text-muted-foreground">{column.label}</dt><dd>{column.render(row)}</dd></div>)}</dl></li>)}</ul></>
}
