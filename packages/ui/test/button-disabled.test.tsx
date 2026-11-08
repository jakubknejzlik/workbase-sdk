import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '../src/components/ui/button'

const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const
const sizes = ['default', 'sm', 'lg', 'icon', 'icon-sm', 'icon-lg'] as const

it.each(variants)('SR-54 disabled %s buttons retain reference styling at every size and cannot activate', async variant => {
  const activate = vi.fn()
  const user = userEvent.setup()
  const buttons = (disabled: boolean) => <>{sizes.map(size => <Button key={size} variant={variant} size={size} disabled={disabled} onClick={activate}>{size}</Button>)}</>
  const { rerender } = render(buttons(true))
  for (const size of sizes) {
    const button = screen.getByRole('button', { name: size }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.classList.contains('disabled:opacity-50')).toBe(true)
    expect(button.classList.contains('disabled:pointer-events-none')).toBe(true)
    expect(button.className).not.toMatch(/disabled:(?:opacity-100|text-|cursor-pointer)/)
    await user.click(button)
    button.focus()
    expect(document.activeElement).not.toBe(button)
  }
  expect(activate).not.toHaveBeenCalled()
  rerender(buttons(false))
  for (const size of sizes) await user.click(screen.getByRole('button', { name: size }))
  expect(activate).toHaveBeenCalledTimes(sizes.length)
})

it('SR-54 vendored controls never override disabled opacity back to fully enabled', () => {
  const root = 'src/vendor/tiketo'
  const violations = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.tsx'))
    .filter(file => /(?:disabled|aria-disabled|data-\[disabled\]):opacity-100/.test(readFileSync(join(root, file), 'utf8')))
  expect(violations).toEqual([])
})
