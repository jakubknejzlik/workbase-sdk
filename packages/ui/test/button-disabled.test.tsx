import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '../src/components/ui/button'
import { createRef } from 'react'
import { FormSubmissionContext } from '../src/vendor/tiketo/components/form/Form'
import { FormSubmitButton } from '../src/vendor/tiketo/components/form/FormSubmitButton'

const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const
const sizes = ['default', 'sm', 'lg', 'icon', 'icon-sm', 'icon-lg'] as const

it.each(variants)('SR-54 disabled %s buttons remain readable at every size and cannot activate', async variant => {
  const activate = vi.fn()
  const user = userEvent.setup()
  const buttons = (disabled: boolean) => <>{sizes.map(size => <Button key={size} variant={variant} size={size} disabled={disabled} onClick={activate}>{size}</Button>)}</>
  const { rerender } = render(buttons(true))
  for (const size of sizes) {
    const button = screen.getByRole('button', { name: size }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.classList.contains('disabled:opacity-50')).toBe(false)
    expect(button.classList.contains('disabled:pointer-events-none')).toBe(false)
    expect(button.classList.contains('disabled:cursor-not-allowed')).toBe(true)
    await user.click(button)
    button.focus()
    expect(document.activeElement).not.toBe(button)
  }
  expect(activate).not.toHaveBeenCalled()
  rerender(buttons(false))
  for (const size of sizes) await user.click(screen.getByRole('button', { name: size }))
  expect(activate).toHaveBeenCalledTimes(sizes.length)
})

it('207 pending FormSubmitButton shares disabled styling and retains its spinner and label', () => {
  render(<FormSubmissionContext.Provider value={{ isSubmitting: true }}><FormSubmitButton loadingText="Saving…">Save</FormSubmitButton></FormSubmissionContext.Provider>)
  const button = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.classList.contains('disabled:cursor-not-allowed')).toBe(true)
  expect(button.querySelector('.animate-spin')).not.toBeNull()
})

it('207 enabled slotted links preserve their element, ref, focus and activation', async () => {
  const activate = vi.fn(event => event.preventDefault())
  const ref = createRef<HTMLButtonElement>()
  render(<Button asChild ref={ref} variant="ghost"><a href="#destination" onClick={activate}>Back</a></Button>)
  const link = screen.getByRole('link', { name: 'Back' })
  expect(ref.current).toBe(link)
  expect(link.tagName).toBe('A')
  const user = userEvent.setup()
  await user.tab()
  expect(document.activeElement).toBe(link)
  await user.keyboard('{Enter}')
  await user.click(link)
  expect(activate).toHaveBeenCalledTimes(2)
})
