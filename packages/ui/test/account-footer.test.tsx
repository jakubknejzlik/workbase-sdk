import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LayoutUserDropdown } from '../src/vendor/tiketo/components/layout/LayoutUserDropdown'
import { SidebarProvider } from '../src/components/ui/sidebar'

it('account trigger displays the name and falls back to email for an empty name', () => {
  const account = (name: string) => <SidebarProvider><LayoutUserDropdown user={{ name, email: 'ada@example.test' }} label="Account" signOutLabel="Sign out" signOut={vi.fn()} /></SidebarProvider>
  const { rerender } = render(account('Ada Lovelace'))
  const trigger = screen.getByRole('button', { name: /Ada Lovelace/ })
  expect(trigger.textContent).toContain('Ada Lovelace')
  expect(trigger.querySelector('.font-medium')?.classList.contains('sr-only')).toBe(false)
  expect(screen.getByRole('button', { name: /^Account .*Ada Lovelace/ })).toBe(trigger)
  rerender(account('  '))
  expect(trigger.querySelector('.font-medium')?.textContent).toBe('ada@example.test')
})
