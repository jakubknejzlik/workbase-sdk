import type { ReactNode } from 'react'

/** Source settings heading and table composition; host supplies authorized slots. */
export function WorkspaceMembers({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return <div data-slot="settings-page" className="min-w-0 space-y-6"><div data-slot="settings-heading" className="flex min-w-0 flex-wrap items-center justify-between gap-4"><div className="min-w-0"><h2 className="text-base font-normal">{title}</h2><p className="text-muted-foreground">{description}</p></div><div data-slot="settings-actions" className="flex min-w-0 max-w-full flex-wrap gap-2">{actions}</div></div>{children}</div>
}
