// Alert presentation uses the same CSP-safe layer as dialogs; cancel is initial focus.
import type { ComponentProps } from 'react'
import { Content as DialogContent } from './dialog'
export { Root, Trigger, Overlay, Portal, Title, Description, Close as Action, Close as Cancel } from './dialog'
export function Content({ onOpenAutoFocus, ...props }: ComponentProps<typeof DialogContent>) {
  return <DialogContent {...props} role="alertdialog" onPointerDownOutside={event => event.preventDefault()} onOpenAutoFocus={event => {
    onOpenAutoFocus?.(event)
    if (!event.defaultPrevented) { event.preventDefault(); (event.target as HTMLElement).querySelector<HTMLElement>('[data-slot="alert-dialog-cancel"]')?.focus() }
  }} />
}
