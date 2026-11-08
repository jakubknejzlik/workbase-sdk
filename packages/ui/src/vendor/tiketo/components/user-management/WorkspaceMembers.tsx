import type { ReactNode } from 'react'
import { Separator } from '../ui/separator'

/** Source settings heading and table composition; host supplies authorized slots. */
export function WorkspaceMembers({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return <div className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><h1 tabIndex={-1} className="text-2xl font-semibold">{title}</h1><p className="text-muted-foreground">{description}</p></div>{actions}</div><Separator />{children}</div>
}
