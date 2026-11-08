import { Separator } from '../ui/separator'
import { SidebarTrigger } from '../ui/sidebar'
import { type PropsWithChildren, type ReactNode, type Ref } from 'react'

export const LayoutHeader = ({ children, breadcrumbs, triggerRef, triggerLabel }: PropsWithChildren<{ breadcrumbs: ReactNode; triggerRef?: Ref<HTMLButtonElement>; triggerLabel?: string }>) => (
  <header className="bg-background sticky top-0 z-40 flex w-full items-center border-b">
    <div className="flex h-(--header-height) w-full min-w-0 items-center gap-2 px-4">
      <SidebarTrigger ref={triggerRef} aria-label={triggerLabel} />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <div className="min-w-0 overflow-hidden">{breadcrumbs}</div>
      <div className="ml-auto shrink-0">{children}</div>
    </div>
  </header>
)
