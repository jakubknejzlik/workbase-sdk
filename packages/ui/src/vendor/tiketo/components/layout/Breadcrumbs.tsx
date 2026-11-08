import { Fragment, Suspense, type ReactNode } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from '../ui/breadcrumb'
import { Skeleton } from '../ui/skeleton'

/** Host resolves translated route ancestors and capability-safe links. */
export const BreadcrumbsBase = ({ items, label = 'Breadcrumb' }: { items: { key: string; content: ReactNode }[]; label?: string }) => (
  <Breadcrumb aria-label={label}><BreadcrumbList>{items.map((item, index) => (
    <Fragment key={item.key}><BreadcrumbItem><Suspense fallback={<Skeleton className="h-4 w-32" />}>{item.content}</Suspense></BreadcrumbItem>{index < items.length - 1 && <BreadcrumbSeparator />}</Fragment>
  ))}</BreadcrumbList></Breadcrumb>
)
