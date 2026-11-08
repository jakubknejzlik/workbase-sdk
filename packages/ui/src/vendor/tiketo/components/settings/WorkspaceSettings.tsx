import type { ReactNode } from 'react'
import { Separator } from '../ui/separator'

/** Source organization settings form; host owns live permission and persistence. */
export function WorkspaceSettings({ title, description, name, error, footer }: {
  title: string; description: string; name: ReactNode; error?: ReactNode; footer: ReactNode
}) {
  return <div className="max-w-2xl space-y-4">
    <div><h1 tabIndex={-1} className="text-2xl font-semibold">{title}</h1><p className="text-muted-foreground">{description}</p></div>
    <Separator />
    <div className="space-y-6">{error}{name}<div>{footer}</div></div>
  </div>
}
