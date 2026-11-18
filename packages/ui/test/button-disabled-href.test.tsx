import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Button } from '../src/components/ui/button'

const modes = ['disabled', 'aria', 'aria-boolean', 'both', 'child-aria', 'child-disabled'] as const
const content = (mode: typeof modes[number], disabled: boolean) => {
  // Include a forwarded Slot href as well as the child's own destination.
  const forwarded = { href: '#slot-destination' }
  return <Button asChild {...forwarded}
    disabled={disabled && (mode === 'disabled' || mode === 'both')}
    aria-disabled={disabled && (mode === 'aria' || mode === 'both') ? 'true' : disabled && mode === 'aria-boolean' ? true : undefined}>
    <a href="#destination" aria-disabled={disabled && mode === 'child-aria' ? 'true' : undefined}
      {...(mode === 'child-disabled' ? { disabled } : {})}>Destination</a>
  </Button>
}

it.each(modes)('207 %s disabled slots remove href before native navigation can use it', mode => {
  render(content(mode, true))
  const anchor = screen.getByText('Destination')
  expect(anchor.tagName).toBe('A')
  expect(anchor.hasAttribute('href')).toBe(false)
  expect(anchor.getAttribute('aria-disabled')).toBe('true')
  expect(anchor.tabIndex).toBe(-1)
  // No context-menu guard is needed: there is no link destination to open.
  expect(fireEvent.contextMenu(anchor)).toBe(true)
})

it.each(modes)('207 %s re-enabled slots restore href and native navigation events', mode => {
  const { rerender } = render(content(mode, true))
  rerender(content(mode, false))
  const anchor = screen.getByRole('link', { name: 'Destination' })
  expect(anchor.getAttribute('href')).toBe('#destination')
  expect(anchor.getAttribute('aria-disabled')).not.toBe('true')
  expect(anchor.tabIndex).toBe(0)
  expect(fireEvent.click(anchor)).toBe(true)
  expect(fireEvent.click(anchor, { ctrlKey: true, metaKey: true })).toBe(true)
  expect(fireEvent(anchor, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(true)
  expect(fireEvent.contextMenu(anchor)).toBe(true)
})

it('207 disabled non-anchor children still block custom activation handlers', () => {
  const child = vi.fn(), parent = vi.fn()
  render(<Button asChild disabled onClick={parent} onAuxClick={parent} onKeyDown={parent} onKeyUp={parent}>
    <span role="button" onClick={child} onAuxClick={child} onKeyDown={child} onKeyUp={child}>Action</span>
  </Button>)
  const action = screen.getByRole('button', { name: 'Action' })
  expect(fireEvent.click(action)).toBe(false)
  expect(fireEvent(action, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(false)
  for (const key of ['Enter', ' ']) {
    expect(fireEvent.keyDown(action, { key })).toBe(false)
    expect(fireEvent.keyUp(action, { key })).toBe(false)
  }
  expect(child).not.toHaveBeenCalled()
  expect(parent).not.toHaveBeenCalled()
})
