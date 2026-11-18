import { createRef } from 'react'
import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '../src/components/ui/button'

it.each(['disabled', 'aria-boolean', 'aria-string', 'child-aria'] as const)('207 %s slotted links block activation before child and Button handlers', async mode => {
  const childClick = vi.fn(), buttonClick = vi.fn(), childKey = vi.fn(), buttonKey = vi.fn()
  const childCapture = vi.fn(), buttonCapture = vi.fn()
  const ref = createRef<HTMLButtonElement>()
  const props = mode === 'disabled' ? { disabled: true } : mode === 'aria-boolean' ? { 'aria-disabled': true as const } : mode === 'aria-string' ? { 'aria-disabled': 'true' as const } : {}
  render(<><Button asChild ref={ref} {...props} tabIndex={0} onClick={buttonClick} onKeyDown={buttonKey} onKeyUp={buttonKey} onClickCapture={buttonCapture} onKeyDownCapture={buttonCapture} onKeyUpCapture={buttonCapture}>
    <a href="#destination" tabIndex={0} aria-disabled={mode === 'child-aria' ? true : undefined} onClick={childClick} onKeyDown={childKey} onKeyUp={childKey} onClickCapture={childCapture} onKeyDownCapture={childCapture} onKeyUpCapture={childCapture}>Unavailable</a>
  </Button><button>Next</button></>)
  const link = screen.getByRole('link', { name: 'Unavailable' })
  expect(ref.current).toBe(link)
  expect(fireEvent.click(link)).toBe(false)
  expect(link.getAttribute('aria-disabled')).toBe('true')
  expect(link.tabIndex).toBe(-1)
  const user = userEvent.setup()
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
  // Programmatic focus is allowed, but neither Enter nor Space may activate it.
  link.focus()
  for (const key of ['Enter', ' ']) {
    expect(fireEvent.keyDown(link, { key })).toBe(false)
    expect(fireEvent.keyUp(link, { key })).toBe(false)
  }
  for (const handler of [childClick, buttonClick, childKey, buttonKey, childCapture, buttonCapture]) expect(handler).not.toHaveBeenCalled()
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
})

it('207 re-enabled slotted links restore focus, handlers and uncancelled navigation', async () => {
  const childClick = vi.fn(), buttonClick = vi.fn(), childKey = vi.fn(), buttonKey = vi.fn()
  const content = (disabled: boolean) => <Button asChild disabled={disabled} onClick={buttonClick} onKeyDown={buttonKey}><a href="#destination" onClick={childClick} onKeyDown={childKey}>Back</a></Button>
  const { rerender } = render(content(true))
  rerender(content(false))
  const link = screen.getByRole('link', { name: 'Back' })
  expect(link.getAttribute('aria-disabled')).not.toBe('true')
  expect(link.tabIndex).toBe(0)
  const user = userEvent.setup()
  await user.tab()
  expect(document.activeElement).toBe(link)
  await user.keyboard('{Enter}')
  expect(fireEvent.click(link)).toBe(true)
  expect(childClick).toHaveBeenCalledTimes(2)
  expect(buttonClick).toHaveBeenCalledTimes(2)
  expect(childKey).toHaveBeenCalledTimes(1)
  expect(buttonKey).toHaveBeenCalledTimes(1)
})
