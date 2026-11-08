import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'
export function ScrollArea({ className, ...props }: ComponentProps<'div'>) { return <div data-slot="scroll-area" className={cn('relative overflow-auto', className)} {...props} /> }
// The browser owns the accessible native scrollbar; this compatibility slot is decorative.
export function ScrollBar(_props: ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) { return null }
