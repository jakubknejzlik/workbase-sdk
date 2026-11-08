import type { ReactNode } from 'react'
import { cn } from '../lib'
import { DetailPageHeader } from '../components/detail-page/DetailPageHeader'
export { DetailPageHeader }
export function DetailPage({ title, backLink, actions, children }: { title: ReactNode; backLink?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <div className="space-y-6 p-4 min-w-0"><DetailPageHeader title={title} backLink={backLink} extraActions={actions} />{children}</div>
}
export function DetailFields({ fields, className }: { fields: { name?: string; label: string; value: ReactNode }[]; className?: string }) {
  return <dl className={cn('grid gap-4 rounded-lg border p-6 sm:grid-cols-2', className)}>{fields.map(({ name, label, value }) => <div className="min-w-0 space-y-1" key={name ?? label} data-detail-field={name}><dt className="text-sm font-medium text-muted-foreground">{label}</dt><dd className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
}
