import { cn } from '../../lib/utils'
import { type PropsWithChildren } from 'react'

export const LayoutContent = ({ children, noPadding }: PropsWithChildren<{ noPadding?: boolean }>) => (
  <main id="main" tabIndex={-1} className={cn('flex min-w-0 max-w-full flex-1 flex-col gap-4', !noPadding && 'p-4')}>{children}</main>
)
