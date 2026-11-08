import { DialogPrimitive as Primitive } from '../components/ui/dialog'
import type { ReactNode } from 'react'
import { Button } from '../button'
/** Non-modal drawer avoids Radix scroll-lock stylesheet injection under style-src self. */
export function Sheet({ open, onOpenChange, title, closeLabel, trigger, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; closeLabel: string; trigger: string; children: ReactNode }) {
  return <Primitive.Root modal={false} open={open} onOpenChange={onOpenChange}><Primitive.Trigger asChild><Button variant="outline" className="c1-drawer-trigger">{trigger}</Button></Primitive.Trigger><Primitive.Portal><Primitive.Content className="c1-sheet"><Primitive.Title>{title}</Primitive.Title><Primitive.Description className="c1-sr-only">{trigger}</Primitive.Description>{children}<Primitive.Close asChild><Button variant="outline">{closeLabel}</Button></Primitive.Close></Primitive.Content></Primitive.Portal></Primitive.Root>
}
