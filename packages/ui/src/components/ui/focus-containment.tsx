// Source: workbase packages/ui/src/dialog/index.tsx + layout/sheet.tsx (C6a extraction)
// Adaptations: reusable non-modal containment, including menus and nested portals.
import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type Ref } from 'react'

const selector = 'summary, button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
const layers: HTMLElement[] = []
// Closing Radix portals can stay mounted for exit animations. They no longer own focus.
const activeLayer = () => layers.findLast(layer => layer.isConnected && layer.dataset.state !== 'closed')
export function useFocusContainment<T extends HTMLElement>(forwardedRef?: Ref<T>) {
  const local = useRef<T | null>(null)
  const [node, setNode] = useState<T | null>(null)
  const ref = useCallback((value: T | null) => {
    local.current = value; setNode(value)
    if (typeof forwardedRef === 'function') forwardedRef(value)
    else if (forwardedRef) forwardedRef.current = value
  }, [forwardedRef])
  const controls = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>(selector)].filter(el => !el.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
  // Register the new top layer before Radix runs its passive autofocus effect.
  useLayoutEffect(() => {
    if (!node) return
    layers.push(node)
    const contain = (event: FocusEvent) => {
      if (activeLayer() !== node || node.contains(event.target as Node)) return
      ;(controls(node)[0] ?? node).focus()
    }
    document.addEventListener('focusin', contain)
    return () => { document.removeEventListener('focusin', contain); const index = layers.indexOf(node); if (index >= 0) layers.splice(index, 1) }
  }, [node])
  const onKeyDown: HTMLAttributes<T>['onKeyDown'] = event => {
    if (event.key !== 'Tab' || activeLayer() !== local.current) return
    const target = event.currentTarget; const list = controls(target); const first = list[0]; const last = list.at(-1)
    if (!first) { event.preventDefault(); target.focus() }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === target)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === target)) { event.preventDefault(); first.focus() }
  }
  return { ref, onKeyDown, node }
}
