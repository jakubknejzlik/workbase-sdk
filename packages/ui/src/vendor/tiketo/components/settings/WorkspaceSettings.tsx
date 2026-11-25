import type { ReactNode } from 'react'

/** Source organization settings form; host owns live permission and persistence. */
export function WorkspaceSettings({ title, description, name, error, footer }: {
  title: string; description: string; name: ReactNode; error?: ReactNode; footer: ReactNode
}) {
  return <div data-slot="settings-page" className="min-w-0 space-y-6 rounded-[var(--radius-panel)] border bg-card p-6">
    <div data-slot="settings-heading"><h2 className="text-base font-normal">{title}</h2><p className="text-muted-foreground">{description}</p></div>
    <div data-slot="settings-panel" className="min-w-0 max-w-2xl space-y-6">{error}{name}<div data-slot="settings-actions" className="flex min-w-0 flex-wrap gap-2">{footer}</div></div>
  </div>
}
