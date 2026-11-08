import { DialogPrimitive as Primitive } from '../components/ui/dialog'
import { Button } from '../button'
import { DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog'
import { type ReactNode } from 'react'
/** Non-modal information dialog: no scroll-lock stylesheet injection; all styling comes from the asset CSS. */
export function Dialog({ trigger, title, description, closeLabel, children, open, onOpenChange, onCloseAutoFocus }: { trigger?: string; title: string; description: string; closeLabel: string; children?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void }) {
  return <Primitive.Root modal={false} open={open} onOpenChange={onOpenChange}>
    {trigger && <Primitive.Trigger asChild><Button variant="outline">{trigger}</Button></Primitive.Trigger>}
    <DialogContent closeLabel={closeLabel} onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      {children}<DialogFooter><Primitive.Close asChild><Button variant="outline">{closeLabel}</Button></Primitive.Close></DialogFooter>
    </DialogContent>
  </Primitive.Root>
}

export { ActionDialog, DeleteActionDialog, SchemaFormDialog } from './mutation-dialog'
export * from './mutation-lifecycle'
export { FormDialog } from '../components/dialog/FormDialog'
export { ConfirmDialog } from '../components/dialog/ConfirmDialog'
export { DeleteDialog } from '../components/dialog/DeleteDialog'
