// Workbase CSP: static backdrops and explicit focus layers avoid scroll-lock styles.
import * as Radix from '@radix-ui/react-dialog'
import { createContext, useContext, type ComponentProps } from 'react'
import { useFocusContainment } from '../focus-containment'
const Backdrop = createContext(true)
export function Root({ modal = true, ...props }: ComponentProps<typeof Radix.Root>) {
  return <Backdrop.Provider value={modal}><Radix.Root {...props} modal={false} /></Backdrop.Provider>
}
export function Overlay(props: ComponentProps<typeof Radix.Overlay>) {
  return useContext(Backdrop) ? <div {...props} aria-hidden="true" /> : null
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
