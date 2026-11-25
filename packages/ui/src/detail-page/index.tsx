import type { ReactNode } from 'react'
import { cn } from '../lib'
import { DetailPageHeader } from '../components/detail-page/DetailPageHeader'
export { DetailPageHeader }
export function DetailPage({ title, secondary, backLink, actions, children }: { title: ReactNode; secondary?: ReactNode; backLink?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <div data-slot="detail-page" className="space-y-6 p-4 min-w-0"><DetailPageHeader title={title} secondary={secondary} backLink={backLink} extraActions={actions} />{children}</div>
}
export function DetailFields({ fields, className }: { fields: { name?: string; label: string; value: ReactNode }[]; className?: string }) {
  return <dl data-detail-grid="metadata" className={cn('detail-fields detail-field-grid rounded-lg border p-6', className)}>{fields.map(({ name, label, value }) => <div className="detail-field" key={name ?? label} data-detail-field={name}><dt className="detail-field-label">{label}</dt><dd className="detail-field-value">{value}</dd></div>)}</dl>
}
