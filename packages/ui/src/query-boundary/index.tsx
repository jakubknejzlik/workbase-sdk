import type { ReactNode } from 'react'
export function QueryBoundary({ pending, error, loadingLabel = 'Loading', children }: { pending: boolean; error: Error | null; loadingLabel?: string; children: ReactNode }) {
  if (pending) return <div role="status" className="flex items-center justify-center p-4"><div aria-hidden="true" className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" /><span className="sr-only">{loadingLabel}</span></div>
  if (error) return <div role="alert" className="p-4 border border-destructive rounded-md bg-destructive/10"><p className="text-sm text-destructive font-medium">{error.message}</p></div>
  return <>{children}</>
}
