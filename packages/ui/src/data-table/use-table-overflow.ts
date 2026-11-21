import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

/** Observe the viewport AND table: display toggles can change only the content width. */
export function useTableOverflow(enabled = false, columns: string, pinnedActions = false) {
  const ref = useRef<HTMLDivElement>(null)
  const resizeObserver = useRef<ResizeObserver | null>(null)
  const observedControl = useRef<HTMLElement | null>(null)
  const hintId = useId()
  const [edge, setEdge] = useState<'start' | 'end' | 'both'>()
  const update = useCallback(() => {
    const node = ref.current
    if (!enabled || !node || node.scrollWidth <= node.clientWidth + 1) { setEdge(undefined); return }
    const start = node.scrollLeft > 1
    const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1
    setEdge(start && end ? 'both' : start ? 'start' : 'end')
  }, [enabled])
  const revealFocus = useCallback(() => {
    const node = ref.current
    if (!enabled || !pinnedActions || !node) return
    const actions = node.querySelector<HTMLElement>('[data-pinned-actions]')
    if (!actions) return
    // The rendered border-box includes Actions' border and follows rem/text changes.
    const sticky = actions.getBoundingClientRect()
    const ring = 3
    node.style.scrollPaddingInlineStart = `${ring}px`
    node.style.scrollPaddingInlineEnd = `${sticky.width + ring}px`
    const active = node.ownerDocument.activeElement
    if (!(active instanceof HTMLElement) || active === node || !node.contains(active) || active.closest('[data-pinned-actions]')) return
    // Row controls can resize from their own async state without resizing a column.
    if (active !== observedControl.current) {
      if (observedControl.current) resizeObserver.current?.unobserve(observedControl.current)
      observedControl.current = active
      resizeObserver.current?.observe(active)
    }
    const port = node.getBoundingClientRect()
    // clientLeft/clientWidth exclude the overflow-cue borders and scrollbar.
    const left = port.left + node.clientLeft + ring
    const right = Math.min(port.left + node.clientLeft + node.clientWidth, sticky.left) - ring
    const box = active.getBoundingClientRect()
    const oversized = box.width > right - left
    // Nearest-edge behavior for oversized controls: retain a spanning control,
    // otherwise expose its nearer edge. Never oscillate between its two edges.
    let delta = 0
    if (box.left < left && (!oversized || box.right < right)) delta = (oversized ? box.right - right : box.left - left)
    else if (box.right > right && (!oversized || box.left > left)) delta = (oversized ? box.left - left : box.right - right)
    const correction = delta < 0 ? Math.floor(delta) : Math.ceil(delta)
    node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + correction))
    update()
  }, [enabled, pinnedActions, update])
  useLayoutEffect(() => {
    if (!enabled || !ref.current) return
    const node = ref.current
    const observer = new ResizeObserver(() => { revealFocus(); update() })
    resizeObserver.current = observer
    observer.observe(node)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    // A column can change width without changing the table's total width.
    if (pinnedActions) node.querySelectorAll('th').forEach(header => observer.observe(header))
    update()
    return () => { observer.disconnect(); resizeObserver.current = null; observedControl.current = null }
  }, [enabled, columns, pinnedActions, revealFocus, update])
  useLayoutEffect(() => {
    if (!enabled || !pinnedActions || !ref.current) return
    const node = ref.current
    const { scrollPaddingInlineStart, scrollPaddingInlineEnd } = node.style
    return () => { node.style.scrollPaddingInlineStart = scrollPaddingInlineStart; node.style.scrollPaddingInlineEnd = scrollPaddingInlineEnd }
  }, [enabled, pinnedActions])
  // Column visibility, sorting and refresh may move a control without a resize.
  useLayoutEffect(() => { revealFocus() })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Do not intercept keys from sortable headers or record/action controls.
    if (event.target !== event.currentTarget || !['Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.currentTarget.scrollLeft = event.key === 'Home' ? 0 : event.currentTarget.scrollWidth
    update()
  }
  return { ref, hintId, edge, update, onKeyDown, onFocusCapture: revealFocus }
}
