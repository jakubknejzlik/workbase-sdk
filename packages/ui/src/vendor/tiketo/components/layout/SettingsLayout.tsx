import { type PropsWithChildren, type ReactNode } from 'react'

/** Source settings columns; host supplies authorized links and translations. */
export const SettingsLayout = ({ children, title, navigation }: PropsWithChildren<{ title: string; navigation: ReactNode }>) => (
  <div className="flex h-full flex-1 min-w-0 flex-col md:flex-row">
    <div className="w-full shrink-0 border-b md:border-b-0 md:border-r md:w-64 bg-muted/40 p-6">
      <div className="space-y-6"><h2 className="text-lg font-semibold mb-3">{title}</h2><nav aria-label={title} className="flex flex-col space-y-1">{navigation}</nav></div>
    </div>
    <div className="min-w-0 flex-1 px-4 md:px-8 py-6">{children}</div>
  </div>
)
