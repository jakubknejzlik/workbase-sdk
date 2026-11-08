import type { ReactNode } from 'react'
import { Users } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '../ui/card'
import { Skeleton } from '../ui/skeleton'

/** Three source skeleton rows remain until both authorized queries settle. */
export function WorkspaceMembersTable({ title, description, loading, loadingLabel, children }: { title: string; description: string; loading: boolean; loadingLabel: string; children: ReactNode }) {
  return <Card aria-busy={loading}><CardHeader>{loading ? <><Skeleton className="h-6 w-32" /><Skeleton className="h-4 w-64 max-w-full" /></> : <><CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" aria-hidden="true" />{title}</CardTitle><CardDescription>{description}</CardDescription></>}</CardHeader><CardContent>{loading ? <div role="status" aria-label={loadingLabel} className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div> : children}</CardContent></Card>
}
