import * as Radix from '@radix-ui/react-dropdown-menu'
import type { ComponentProps } from 'react'
import { useFocusContainment } from '../focus-containment'
export * from '@radix-ui/react-dropdown-menu'
export function Root(props: ComponentProps<typeof Radix.Root>) { return <Radix.Root {...props} modal={false} /> }
export function Content({ ref, onKeyDown, onInteractOutside, ...props }: ComponentProps<typeof Radix.Content>) {
  const focus = useFocusContainment(ref)
  return <Radix.Content {...props} ref={focus.ref} onInteractOutside={event => { onInteractOutside?.(event); if (event.type === 'dismissableLayer.focusOutside') event.preventDefault() }} onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) focus.onKeyDown(event) }} />
}
export function SubContent({ ref, onKeyDown, ...props }: ComponentProps<typeof Radix.SubContent>) {
  const focus = useFocusContainment(ref)
  return <Radix.SubContent {...props} ref={focus.ref} onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) focus.onKeyDown(event) }} />
}
