import type { ReactNode } from 'react'
import { Separator } from '../ui/separator'

/** Source UserSettings composition; Identity and P1/P4 supply the form and fields. */
export function UserSettings({ title, description, email, firstName, lastName, notice, error, footer }: {
  title: string; description: string; email: ReactNode; firstName: ReactNode; lastName: ReactNode; notice?: ReactNode; error?: ReactNode; footer: ReactNode
}) {
  return <div className="max-w-2xl space-y-4">
    <div><h1 tabIndex={-1} className="text-2xl font-semibold">{title}</h1><p className="text-muted-foreground">{description}</p></div>
    <Separator />
    <div className="space-y-6">
      {notice}{error}<div className="space-y-2">{email}</div>
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="w-full sm:w-1/2 space-y-2">{firstName}</div>
        <div className="w-full sm:w-1/2 space-y-2">{lastName}</div>
      </div>
      <div>{footer}</div>
    </div>
  </div>
}
