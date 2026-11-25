import type { ReactNode } from 'react'

/** Source UserSettings composition; Identity and P1/P4 supply the form and fields. */
export function UserSettings({ title, description, email, firstName, lastName, notice, error, footer }: {
  title: string; description: string; email: ReactNode; firstName: ReactNode; lastName: ReactNode; notice?: ReactNode; error?: ReactNode; footer: ReactNode
}) {
  return <div data-slot="settings-page" className="min-w-0 space-y-6 rounded-[var(--radius-panel)] border bg-card p-6">
    <div data-slot="settings-heading"><h2 className="text-base font-normal">{title}</h2><p className="text-muted-foreground">{description}</p></div>
    <div data-slot="settings-panel" className="min-w-0 max-w-2xl space-y-6">
      {notice}{error}<div className="space-y-2">{email}</div>
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="min-w-0 w-full sm:w-1/2 space-y-2">{firstName}</div>
        <div className="min-w-0 w-full sm:w-1/2 space-y-2">{lastName}</div>
      </div>
      <div data-slot="settings-actions" className="flex min-w-0 flex-wrap gap-2">{footer}</div>
    </div>
  </div>
}
