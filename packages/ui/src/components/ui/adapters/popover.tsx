import * as Radix from '@radix-ui/react-popover'
import type { ComponentProps } from 'react'
import { useFocusContainment } from '../focus-containment'
export * from '@radix-ui/react-popover'
export function Root(props: ComponentProps<typeof Radix.Root>) { return <Radix.Root {...props} modal={false} /> }
export function Content({ ref, onKeyDown, ...props }: ComponentProps<typeof Radix.Content>) {
  const focus = useFocusContainment(ref)
  return <Radix.Content {...props} ref={focus.ref} onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) focus.onKeyDown(event) }} />
}
