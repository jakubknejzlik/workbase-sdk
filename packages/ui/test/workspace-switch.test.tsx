import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { SidebarProvider } from '../src/components/ui/sidebar'
import { WorkspaceSwitch } from '../src/components/layout/WorkspaceSwitch'
const labels = { label: 'Organization', placeholderLabel: 'Select organization', selectLabel: 'Organizations', searchLabel: 'Search organizations', currentLabel: 'Current', emptyLabel: 'No organizations', addLabel: 'Add organization' }
it('uses one header trigger, filters memberships and switches through menu items', async () => {
  const user = userEvent.setup(), onSwitch = vi.fn()
  render(<SidebarProvider><WorkspaceSwitch {...labels} workspaces={[{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]} activeId="a" onSwitch={onSwitch} onAdd={() => {}} /></SidebarProvider>)
  expect(screen.queryByRole('combobox')).toBeNull()
  await user.click(screen.getByRole('button', { name: /Organization: Alpha\s*Organization/ }))
  await user.type(screen.getByRole('searchbox', { name: 'Search organizations' }), 'bet')
  expect(screen.queryByRole('menuitem', { name: /Alpha/ })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Beta' })).toBeTruthy()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(onSwitch).toHaveBeenCalledWith('b')
  expect(screen.queryByRole('menu')).toBeNull()
})
it('shows the single membership and Escape returns focus without switching', async () => {
  const user = userEvent.setup(), onSwitch = vi.fn()
  render(<SidebarProvider><WorkspaceSwitch {...labels} workspaces={[{ id: 'a', name: 'Only organization' }]} onSwitch={onSwitch} onAdd={() => {}} /></SidebarProvider>)
  const trigger = screen.getByRole('button', { name: /Organization: Only organization\s*Organization/ })
  await user.click(trigger)
  expect(screen.getByRole('menuitem', { name: /Only organization\s*Current/ })).toBeTruthy()
  await user.click(screen.getByRole('searchbox', { name: 'Search organizations' }))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger); expect(onSwitch).not.toHaveBeenCalled()
})
