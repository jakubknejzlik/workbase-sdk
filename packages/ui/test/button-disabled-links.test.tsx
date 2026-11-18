import { createRef } from 'react'
import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '../src/components/ui/button'

it.each(['disabled', 'aria-boolean', 'aria-string', 'child-aria'] as const)('207 %s slotted children are replaced by unfocusable text without activation handlers', async mode => {
  const childClick = vi.fn(), buttonClick = vi.fn(), childKey = vi.fn(), buttonKey = vi.fn()
  const childCapture = vi.fn(), buttonCapture = vi.fn()
  const ref = createRef<HTMLButtonElement>()
  const props = mode === 'disabled' ? { disabled: true } : mode === 'aria-boolean' ? { 'aria-disabled': true as const } : mode === 'aria-string' ? { 'aria-disabled': 'true' as const } : {}
  render(<><Button asChild ref={ref} {...props} tabIndex={0} onClick={buttonClick} onKeyDown={buttonKey} onKeyUp={buttonKey} onClickCapture={buttonCapture} onKeyDownCapture={buttonCapture} onKeyUpCapture={buttonCapture}>
    <a href="#destination" tabIndex={0} aria-disabled={mode === 'child-aria' ? true : undefined} onClick={childClick} onKeyDown={childKey} onKeyUp={childKey} onClickCapture={childCapture} onKeyDownCapture={childCapture} onKeyUpCapture={childCapture}>Unavailable</a>
  </Button><button>Next</button></>)
  const link = screen.getByText('Unavailable')
  expect(ref.current).toBeNull()
  expect(link.tagName).toBe('SPAN')
  expect(document.querySelector('a')).toBeNull()
  expect(fireEvent.click(link)).toBe(true)
  expect(link.getAttribute('aria-disabled')).toBe('true')
  expect(link.tabIndex).toBe(-1)
  const user = userEvent.setup()
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
  // Plain text cannot receive focus, including programmatic focus.
  link.focus()
  expect(document.activeElement).not.toBe(link)
  for (const key of ['Enter', ' ']) {
    expect(fireEvent.keyDown(link, { key })).toBe(true)
    expect(fireEvent.keyUp(link, { key })).toBe(true)
  }
  for (const handler of [childClick, buttonClick, childKey, buttonKey, childCapture, buttonCapture]) expect(handler).not.toHaveBeenCalled()
  await user.tab({ shift: true })
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

const auxiliaryModes = ['disabled', 'aria', 'both', 'child-aria'] as const
const auxiliaryProps = (mode: typeof auxiliaryModes[number], disabled: boolean) => ({
  disabled: (mode === 'disabled' || mode === 'both') && disabled,
  'aria-disabled': (mode === 'aria' || mode === 'both') && disabled ? 'true' as const : undefined,
})

for (const mode of auxiliaryModes) {
  it.each(['auxclick', 'mousedown'] as const)(`207 ${mode} disabled slots never run middle-button %s handlers`, event => {
    const childCapture = vi.fn(), buttonCapture = vi.fn(), childHandler = vi.fn(), buttonHandler = vi.fn()
    render(<Button asChild {...auxiliaryProps(mode, true)} onAuxClickCapture={buttonCapture} onMouseDownCapture={buttonCapture} onAuxClick={buttonHandler} onMouseDown={buttonHandler}>
      <a href="#destination" aria-disabled={mode === 'child-aria' ? 'true' : undefined} onAuxClickCapture={childCapture} onMouseDownCapture={childCapture} onAuxClick={childHandler} onMouseDown={childHandler}>Unavailable</a>
    </Button>)
    expect(fireEvent(screen.getByText('Unavailable'), new MouseEvent(event, { button: 1, bubbles: true, cancelable: true }))).toBe(true)
    for (const handler of [childCapture, buttonCapture, childHandler, buttonHandler]) expect(handler).not.toHaveBeenCalled()
  })

  it(`207 ${mode} re-enabled slotted links preserve middle-button events and Slot handlers`, () => {
    const childCapture = vi.fn(), buttonCapture = vi.fn(), childHandler = vi.fn(), buttonHandler = vi.fn()
    const content = (disabled: boolean) => <Button asChild {...auxiliaryProps(mode, disabled)} onAuxClickCapture={buttonCapture} onMouseDownCapture={buttonCapture} onAuxClick={buttonHandler} onMouseDown={buttonHandler}>
      <a href="#destination" aria-disabled={mode === 'child-aria' && disabled ? 'true' : undefined} onAuxClickCapture={childCapture} onMouseDownCapture={childCapture} onAuxClick={childHandler} onMouseDown={childHandler}>Back</a>
    </Button>
    const { rerender } = render(content(true))
    rerender(content(false))
    const link = screen.getByRole('link')
    expect(fireEvent.mouseDown(link, { button: 1 })).toBe(true)
    expect(fireEvent(link, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(true)
    for (const handler of [childCapture, buttonCapture, childHandler, buttonHandler]) expect(handler).toHaveBeenCalledTimes(2)
  })
}
