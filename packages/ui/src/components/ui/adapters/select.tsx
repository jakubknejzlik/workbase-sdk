// Pinned runtime-style/scroll-lock patch is in patches/; source markup stays intact.
import * as Radix from '@radix-ui/react-select'
import { useLayoutEffect, type ComponentProps } from 'react'
import { useFocusContainment } from '../focus-containment'
export * from '@radix-ui/react-select'
export function Content({ ref, onKeyDown, ...props }: ComponentProps<typeof Radix.Content>) {
  const focus = useFocusContainment(ref)
  useLayoutEffect(() => {
    if (!focus.node) return
    // Radix hides the surrounding page from AT while Select is modal. Match
    // that boundary for keyboard/programmatic focus without scroll-lock styles.
    const restored: Array<[HTMLElement, boolean]> = []
    let current: HTMLElement = focus.node
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) if (sibling instanceof HTMLElement && sibling !== current) {
        restored.push([sibling, sibling.inert]); sibling.inert = true
      }
      current = current.parentElement
      if (current === document.body) break
    }
    return () => { for (const [element, inert] of restored) element.inert = inert }
  }, [focus.node])
  return <Radix.Content {...props} ref={focus.ref} onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) focus.onKeyDown(event) }} />
}
