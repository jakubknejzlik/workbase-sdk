import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConsoleLayout, QueryBoundary, Dialog, NameForm, LegacyDataTable, ResourcePage, DetailFields, EntityPicker } from '../src'

it('layout exposes navigation, workspace and account slots with a main landmark', () => {
  render(<ConsoleLayout title="Console" navigationLabel="Main navigation" navigation={<a href="/">Home</a>} workspace="Workspace" account="Profile">Contents</ConsoleLayout>)
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy()
  expect(screen.getByRole('main').textContent).toBe('Contents')
  expect(screen.getByText('Workspace')).toBeTruthy(); expect(screen.getByText('Profile')).toBeTruthy()
})
it('query boundary announces pending, error and ready states', () => {
  const { rerender } = render(<QueryBoundary pending error={null}>Ready</QueryBoundary>)
  expect(screen.getByRole('status').textContent).toBe('Loading')
  rerender(<QueryBoundary pending={false} error={new Error('Unavailable')}>Ready</QueryBoundary>)
  expect(screen.getByRole('alert').textContent).toBe('Unavailable')
  rerender(<QueryBoundary pending={false} error={null}>Ready</QueryBoundary>); expect(screen.getByText('Ready')).toBeTruthy()
})
it('Radix dialog has an accessible name, description, keyboard dismissal and focus return', async () => {
  const user = userEvent.setup()
  render(<Dialog trigger="About" title="Information" description="Workspace information" closeLabel="Close" />)
  const trigger = screen.getByRole('button', { name: 'About' }); await user.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Information' }).getAttribute('aria-describedby')).toBeTruthy()
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger)
})
it('form validates with zod before submitting trimmed values through react-hook-form', async () => {
  const user = userEvent.setup(); const submit = vi.fn()
  render(<NameForm label="Name" submitLabel="Save" onSubmit={submit} />)
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  await user.type(screen.getByRole('textbox', { name: 'Name' }), ' '); await user.click(screen.getByRole('button', { name: 'Save' })); expect(await screen.findByRole('alert')).toBeTruthy(); expect(submit).not.toHaveBeenCalled()
  await user.type(screen.getByRole('textbox', { name: 'Name' }), '  Ada  ')
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit.mock.calls[0][0]).toEqual({ name: 'Ada' })
})
it('TanStack table renders named headers and records', () => {
  render(<LegacyDataTable label="Clients" data={[{ name: 'Ada' }]} columns={[{ accessorKey: 'name', header: 'Name' }]} />)
  expect(screen.getByRole('table', { name: 'Clients' })).toBeTruthy(); expect(screen.getByRole('columnheader').textContent).toBe('Name'); expect(screen.getByRole('cell').textContent).toBe('Ada')
})
it('resource page composes heading and actions', () => {
  render(<ResourcePage title="Clients" actions={<button>Add</button>}>List</ResourcePage>)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Clients'); expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
})
it('detail fields retain labels and values', () => { render(<DetailFields fields={[{ label: 'Name', value: 'Ada' }]} />); expect(screen.getByText('Name').tagName).toBe('DT'); expect(screen.getByText('Ada').tagName).toBe('DD') })
it('entity picker displays labels and emits identifiers', async () => {
  const onChange = vi.fn(); render(<EntityPicker label="Client" placeholder="Choose a client" value="" options={[{ id: 'c-1', label: 'Ada' }]} onChange={onChange} />)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  screen.getByRole('combobox', { name: 'Client' }).focus(); await userEvent.keyboard('{Enter}'); await userEvent.click(screen.getByRole('option', { name: 'Ada' })); expect(onChange).toHaveBeenCalledWith('c-1')
})

it('drawer supports keyboard opening, dismissal and returning focus under non-modal semantics', async () => {
  const { Sheet } = await import('../src')
  const { useState } = await import('react')
  function Drawer() { const [open, setOpen] = useState(false); return <Sheet open={open} onOpenChange={setOpen} title="Workspace" trigger="Open navigation" closeLabel="Close"><a href="/organizations">Organizations</a></Sheet> }
  const user = userEvent.setup(); render(<Drawer />)
  const trigger = screen.getByRole('button', { name: 'Open navigation' }); trigger.focus(); await user.keyboard('{Enter}')
  expect(screen.getByRole('dialog', { name: 'Workspace' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  await user.keyboard('{Shift>}{Tab}{/Shift}'); expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Organizations' }))
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger)
})

it.each(['Open navigation', 'Otevřít navigaci'])('sidebar trigger text matches its localized accessible name: %s', async label => {
  const { SidebarProvider, SidebarTrigger } = await import('../src/components/ui/sidebar')
  render(<SidebarProvider><SidebarTrigger aria-label={label} /></SidebarProvider>)
  expect(screen.getByRole('button', { name: label }).textContent).toBe(label)
})
