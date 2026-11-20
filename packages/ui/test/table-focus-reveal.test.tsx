import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTableOverflow } from '../src/data-table/use-table-overflow'

function Harness({ enabled = true, pinned = true, columns = 'name,code,actions' }) {
  const overflow = useTableOverflow(enabled, columns, pinned)
  return <div data-testid="port" ref={overflow.ref} tabIndex={0} onFocusCapture={overflow.onFocusCapture} onScroll={overflow.update} onKeyDown={overflow.onKeyDown}>
    <table><thead><tr><th>Code</th><th data-pinned-actions={pinned ? '' : undefined}><button>Actions</button></th></tr></thead>
      <tbody><tr><td><button>Code</button></td></tr></tbody></table>
  </div>
}
afterEach(() => vi.unstubAllGlobals())

function geometry(options: { enabled?: boolean; pinned?: boolean } = {}) {
  let resized = () => {}
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe = observe; unobserve() {}; disconnect = disconnect })
  const view = render(<Harness {...options} />)
  const port = screen.getByTestId('port')
  const code = screen.getByRole('button', { name: 'Code' })
  const actions = screen.getByRole('button', { name: 'Actions' })
  let stickyWidth = 72
  let controlLeft = 250
  let controlWidth = 70
  const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 30, height: 30, x: left, y: 0, toJSON() {} })
  // Border-box starts at 100; the 3px cue border is outside clientWidth.
  Object.defineProperties(port, { clientLeft: { value: 3 }, clientWidth: { value: 300 }, scrollWidth: { value: 800 } })
  port.getBoundingClientRect = () => rect(100, 306)
  actions.parentElement!.getBoundingClientRect = () => rect(403 - stickyWidth, stickyWidth)
  code.getBoundingClientRect = () => rect(103 + controlLeft - port.scrollLeft, controlWidth)
  return { ...view, port, code, actions, observe, disconnect,
    resize: () => act(() => resized()),
    control: (left: number, width = 70) => { controlLeft = left; controlWidth = width },
    sticky: (width: number) => { stickyWidth = width },
  }
}

it('minimally clears the sticky border and 3px ring on both edges without scrolling ancestors', () => {
  const { code, port, control, resize } = geometry()
  act(() => code.focus())
  expect(port.scrollLeft).toBe(95) // right 423 -> clear right 328
  expect(port.style.scrollPaddingInlineEnd).toBe('75px')
  expect(code.getBoundingClientRect().right + 3).toBeLessThanOrEqual(331)
  control(150)
  port.scrollLeft = 300
  resize()
  expect(port.scrollLeft).toBe(147) // left must clear 100 + border 3 + ring 3
  expect(code.getBoundingClientRect().left - 3).toBe(103)
  const before = port.scrollLeft
  resize()
  expect(port.scrollLeft).toBe(before)
  expect(document.documentElement.scrollTop).toBe(0)
})

it('clamps corrections and leaves oversized spanning controls stable', () => {
  const { code, port, control, resize } = geometry()
  control(-100)
  act(() => code.focus())
  expect(port.scrollLeft).toBe(0)
  control(1000)
  resize()
  expect(port.scrollLeft).toBe(500)
  port.scrollLeft = 100
  control(50, 400)
  resize(); resize()
  expect(port.scrollLeft).toBe(100)
  control(250, 400)
  resize()
  expect(port.scrollLeft).toBe(247) // expose the nearer leading edge
  resize()
  expect(port.scrollLeft).toBe(247)
})

it('rechecks active focus on rendered Actions width and column changes, restoring padding when unpinned', () => {
  const view = geometry()
  act(() => view.code.focus())
  view.sticky(144); view.resize()
  expect(view.port.style.scrollPaddingInlineEnd).toBe('147px')
  expect(view.code.getBoundingClientRect().right + 3).toBeLessThanOrEqual(259)
  view.control(400)
  view.rerender(<Harness columns="code,actions" />)
  expect(view.code.getBoundingClientRect().right + 3).toBeLessThanOrEqual(259)
  expect(view.observe).toHaveBeenCalledWith(view.actions.parentElement)
  expect(view.observe).toHaveBeenCalledWith(view.code)
  view.rerender(<Harness pinned={false} />)
  expect(view.port.style.scrollPaddingInlineEnd).toBe('')
  expect(view.port.style.scrollPaddingInlineStart).toBe('')
  expect(view.disconnect).toHaveBeenCalled()
})

it('skips the region and pinned controls while retaining region Home/End', () => {
  const { port, actions } = geometry()
  act(() => port.focus())
  fireEvent.keyDown(port, { key: 'End' })
  const end = port.scrollLeft
  act(() => actions.focus())
  expect(port.scrollLeft).toBe(end)
  fireEvent.keyDown(actions, { key: 'Home' })
  expect(port.scrollLeft).toBe(end)
  act(() => port.focus())
  fireEvent.keyDown(port, { key: 'Home' })
  expect(port.scrollLeft).toBe(0)
})

it.each([{ pinned: false }, { enabled: false }])('leaves other table consumers unchanged: %j', options => {
  const { port, code } = geometry(options)
  act(() => code.focus())
  expect(port.scrollLeft).toBe(0)
  expect(port.style.scrollPaddingInlineEnd).toBe('')
  expect(port.style.scrollPaddingInlineStart).toBe('')
})
