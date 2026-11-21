import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Calendar } from '../src/components/ui/calendar'

it.each(['light', 'dark'])('207 selected disabled Calendar dates suppress consumer hover in %s mode', async theme => {
  const selected = new Date(2026, 10, 18), onSelect = vi.fn()
  render(<div className={theme}><Calendar mode="single" defaultMonth={selected} selected={selected} disabled={selected} onSelect={onSelect} /></div>)
  const day = screen.getByRole('grid').querySelector<HTMLButtonElement>('button:disabled')!
  expect(day).not.toBeNull()
  expect(day.getAttribute('data-selected-single')).toBe('true')
  // jsdom has no Tailwind cascade: enforce disabled guards on every applicable
  // hover utility; the compiled light/dark cascade is checked by the render probe.
  const hoverClasses = [...day.classList].filter(value => value.includes('hover:') && (theme === 'dark' || !value.startsWith('dark:')))
  expect(hoverClasses.length).toBeGreaterThan(0)
  for (const utility of hoverClasses) {
    expect(utility).toContain('not-disabled:')
  }
  for (const utility of hoverClasses) expect(utility).toContain('not-aria-disabled:')
  const user = userEvent.setup()
  await user.hover(day)
  await user.click(day)
  expect(onSelect).not.toHaveBeenCalled()
})
