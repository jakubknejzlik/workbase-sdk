import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

/** Observe the viewport AND table: display toggles can change only the content width. */
export function useTableOverflow(enabled = false, columns: string) {
  const ref = useRef<HTMLDivElement>(null)
  const hintId = useId()
  const [edge, setEdge] = useState<'start' | 'end' | 'both'>()
  const update = useCallback(() => {
    const node = ref.current
    if (!enabled || !node || node.scrollWidth <= node.clientWidth + 1) { setEdge(undefined); return }
    const start = node.scrollLeft > 1
    const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1
    setEdge(start && end ? 'both' : start ? 'start' : 'end')
  }, [enabled])
  useLayoutEffect(() => {
    if (!enabled || !ref.current) return
    const observer = new ResizeObserver(update)
    observer.observe(ref.current)
    if (ref.current.firstElementChild) observer.observe(ref.current.firstElementChild)
    update()
    return () => observer.disconnect()
  }, [enabled, columns, update])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Do not intercept keys from sortable headers or record/action controls.
    if (event.target !== event.currentTarget || !['Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.currentTarget.scrollLeft = event.key === 'Home' ? 0 : event.currentTarget.scrollWidth
    update()
  }
  return { ref, hintId, edge, update, onKeyDown }
}
