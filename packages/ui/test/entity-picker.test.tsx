import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { EntityPicker } from '../src'

it('inline-created selection closes the picker and returns focus without reopening search', async () => {
  function Picker() {
    const [value, setValue] = useState('')
    return <EntityPicker remote label="Client" placeholder="Search" options={[]} value={value} selectedLabel={value ? 'New client' : ''} onChange={setValue} wizard={<button type="button" onClick={() => setValue('created')}>Create related</button>} />
  }
  const user = userEvent.setup(); render(<Picker />)
  const input = screen.getByRole('combobox', { name: 'Client' })
  await user.click(input); await user.click(screen.getByRole('button', { name: 'Create related' }))
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect((input as HTMLInputElement).value).toBe('New client')
})

it('schema relation selection and clearing participate in the shared dirty/revert lifecycle', async () => {
  const { RegistryForm, SchemaFormDialog } = await import('../src')
  const schema = { type: 'object', properties: { target: { anyOf: [{ type: 'string' }, { type: 'null' }], 'x-ui': { span: 'full' } } } }
  render(<SchemaFormDialog schema={schema} trigger="Edit relation" title="Edit relation" description="Record" cancelLabel="Cancel">{() => <RegistryForm requireDirty schema={schema} values={{ target: 'a' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={() => {}} relation={(_, value, change, error) => <EntityPicker remote label="Client" placeholder="Search" options={[{ id: 'a', label: 'Alice' }, { id: 'b', label: 'Bob' }]} value={value} selectedLabel={value === 'a' ? 'Alice' : value === 'b' ? 'Bob' : ''} onChange={change} clearLabel="Clear selection" error={error} />} />}</SchemaFormDialog>)
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Edit relation' }))
  const save = screen.getByRole('button', { name: 'Save' }); expect((save as HTMLButtonElement).disabled).toBe(true)
  const picker = screen.getByRole('combobox', { name: 'Client' })
  await user.click(picker); await user.click(screen.getByRole('option', { name: 'Bob' })); expect((save as HTMLButtonElement).disabled).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Clear selection' })); await user.click(picker); await user.click(screen.getByRole('option', { name: 'Alice' })); expect((save as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull()
})

it('lookup Select exposes only supplied labels, emits ids and associates server field errors', async () => {
  const { fireEvent } = await import('@testing-library/react')
  const change = (await import('vitest')).vi.fn()
  HTMLElement.prototype.scrollIntoView = () => {}
  render(<EntityPicker label="Location" placeholder="Choose" value="" onChange={change} options={[{ id: 'permitted', label: 'Permitted location' }]} error="Closed field refusal" />)
  const trigger = screen.getByRole('combobox', { name: 'Location' })
  expect(trigger.getAttribute('data-slot')).toBe('select-trigger'); expect(trigger.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe('Closed field refusal')
  fireEvent.keyDown(trigger, { key: 'Enter' }); await userEvent.click(screen.getByRole('option', { name: 'Permitted location' })); expect(change).toHaveBeenCalledWith('permitted')
})

it('inline edits alone activate the parent discard guard, and cancelling the child clears only its dirty state', async () => {
  const { RegistryForm, SchemaFormDialog } = await import('../src')
  const parent = { type: 'object', properties: { title: { type: 'string' }, target: { type: 'string' } } }
  const child = { type: 'object', properties: { name: { type: 'string' } } }
  function Body() {
    const [open, setOpen] = useState(true)
    return <RegistryForm requireDirty schema={parent} label={name => name} submitLabel="Save parent" invalidLabel="Invalid" onSubmit={() => {}} relation={name => name === 'target' ? <>{open && <><RegistryForm inline schema={child} label={() => 'Related name'} submitLabel="Create related" invalidLabel="Invalid" onSubmit={() => {}} /><button type="button" onClick={() => setOpen(false)}>Cancel related</button></>}</> : undefined} />
  }
  render(<SchemaFormDialog schema={parent} trigger="Edit nested" title="Edit nested" description="Record" cancelLabel="Cancel">{() => <Body />}</SchemaFormDialog>)
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Edit nested' }))
  await user.type(screen.getByLabelText('Related name'), 'Unsaved related value')
  expect((screen.getByRole('button', { name: 'Save parent' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.getByText('Discard changes?')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Continue Editing' })); expect((screen.getByLabelText('Related name') as HTMLInputElement).value).toBe('Unsaved related value')
  await user.click(screen.getByRole('button', { name: 'Cancel related' })); expect(screen.queryByLabelText('Related name')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull()
})
