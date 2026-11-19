// Workbase CSP: static backdrops and explicit focus layers avoid scroll-lock styles.
import * as Radix from '@radix-ui/react-dialog'
import { createContext, useContext, useState, type ComponentProps } from 'react'
import { useFocusContainment } from '../focus-containment'
const Backdrop = createContext(true)
export function Root({ modal = true, open: controlledOpen, defaultOpen = false, onOpenChange, ...props }: ComponentProps<typeof Radix.Root>) {
  const [uncontrolledOpen, setOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  return <Backdrop.Provider value={modal && open}><Radix.Root {...props} open={open} onOpenChange={next => { setOpen(next); onOpenChange?.(next) }} modal={false} /></Backdrop.Provider>
}
export function Overlay(props: ComponentProps<typeof Radix.Overlay>) {
  // Portal presence can outlive Content during an exit animation; its backdrop must not.
  return useContext(Backdrop) ? <div {...props} data-state="open" aria-hidden="true" /> : null
}
export function Content({ ref, onKeyDown, onInteractOutside, ...props }: ComponentProps<typeof Radix.Content>) {
  const focus = useFocusContainment(ref)
  return <Radix.Content {...props} ref={focus.ref} onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) focus.onKeyDown(event) }} onInteractOutside={event => {
    // Focusing another field/portal is never an outside dismissal. Pointer events
    // retain Radix's close callback so FormDialog can guard dirty dismissal.
    if (event.type === 'dismissableLayer.focusOutside') { event.preventDefault(); return }
    onInteractOutside?.(event)
  }} />
}
export { Trigger, Close, Portal, Title, Description } from '@radix-ui/react-dialog'
