import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ActionDialog, DeleteActionDialog, RegistryForm, MutationErrorAlert, MutationSubmitButton, useMutationSubmit, blockMutationNavigation, hasUnsavedMutation } from '../src'
const schema = { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] }
const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
afterEach(() => vi.restoreAllMocks())
function Edit({ save = async () => {}, initial = 'Ada' }: { save?: (values: Record<string, unknown>) => Promise<void>; initial?: string }) {
  return <ActionDialog trigger="Edit" title="Edit record" description="Record values" cancelLabel="Cancel">{({ close }) => <Body save={save} close={close} initial={initial} />}</ActionDialog>
}
function Body({ save, close, initial }: { save: (values: Record<string, unknown>) => Promise<void>; close: () => void; initial: string }) {
  const [error, setError] = useState(false)
  return <><MutationErrorAlert isError={error} error={new Error('PRIVATE SERVER MESSAGE')} fallbackMessage="Could not save" /><RegistryForm requireDirty schema={schema} values={{ name: initial }} label={key => key} submitLabel="Save" invalidLabel="Invalid" onSubmit={async values => { try { await save(values); close() } catch (error) { setError(true); throw error } }} /></>
}
it('pristine is disabled, dirty revert disables again, and pristine closes without a prompt', async () => {
  const user = userEvent.setup(); render(<Edit />)
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  const input = screen.getByLabelText('name'); expect(document.activeElement).toBe(input)
  await user.clear(input); await user.type(input, 'Grace'); expect(save.disabled).toBe(false)
  await user.clear(input); await user.type(input, 'Ada'); expect(save.disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('Discard changes?')).toBeNull()
})
for (const method of ['Cancel', 'Close', 'Escape', 'outside']) it(`dirty ${method} asks inline; continue retains RHF values and discard resets the open`, async () => {
  const user = userEvent.setup(); render(<Edit />)
  await user.click(screen.getByRole('button', { name: 'Edit' })); await user.clear(screen.getByLabelText('name')); await user.type(screen.getByLabelText('name'), 'Grace')
  if (method === 'Escape') await user.keyboard('{Escape}')
  else if (method === 'outside') { fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 }); fireEvent.click(document.body) }
  else await user.click(screen.getByRole('button', { name: method }))
  expect(await screen.findByText('Discard changes?')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Continue Editing' }))
  expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('Grace')
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', { name: 'Discard' }))
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }))
  await user.keyboard('{Enter}'); expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('Ada')
})
it('deferred failure retains values/key, blocks every dismissal/double submit, then retry closes and toasts once', async () => {
  const first = deferred(); const second = deferred(); const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const notified = vi.spyOn(toast, 'success'); const user = userEvent.setup(); render(<Edit save={save} />)
  await user.click(screen.getByRole('button', { name: 'Edit' })); await user.type(screen.getByLabelText('name'), '!')
  const form = screen.getByLabelText('name').closest('form')!
  fireEvent.submit(form); fireEvent.submit(form)
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Saving…' }).querySelector('.animate-spin')).toBeTruthy()
  await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', { name: 'Close' })); fireEvent.pointerDown(document.body)
  expect(screen.queryByText('Discard changes?')).toBeNull(); expect(screen.getByRole('dialog')).toBeTruthy()
  expect(await blockMutationNavigation()).toBe(true)
  await act(async () => first.reject(new Error('PRIVATE SERVER MESSAGE')))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not save')
  expect(document.body.textContent).not.toContain('PRIVATE SERVER MESSAGE'); expect(notified).not.toHaveBeenCalled()
  expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('Ada!')
  await user.click(screen.getByRole('button', { name: 'Save' })); await act(async () => second.resolve())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(notified).toHaveBeenCalledTimes(1)
  expect(notified).toHaveBeenLastCalledWith('Saved', { id: 'mutation-saved' })
})
it('router decisions wait for discard or continue, and never leave an unresolved navigation on unmount', async () => {
  const user = userEvent.setup(); const view = render(<Edit />)
  await user.click(screen.getByRole('button', { name: 'Edit' })); await user.type(screen.getByLabelText('name'), '!')
  expect(hasUnsavedMutation()).toBe(true)
  let navigation!: Promise<boolean>; act(() => { navigation = blockMutationNavigation() })
  expect(await screen.findByText('Discard changes?')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Continue Editing' })); expect(await navigation).toBe(true)
  act(() => { navigation = blockMutationNavigation() }); await user.click(await screen.findByRole('button', { name: 'Discard' })); expect(await navigation).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Edit' })); await user.type(screen.getByLabelText('name'), '!')
  act(() => { navigation = blockMutationNavigation() }); view.unmount(); expect(await navigation).toBe(true); expect(hasUnsavedMutation()).toBe(false)
})
it('completion after forced unmount cannot close a later open or emit a stale success toast', async () => {
  const request = deferred(); const notified = vi.spyOn(toast, 'success'); const user = userEvent.setup()
  const view = render(<Edit save={() => request.promise} />)
  await user.click(screen.getByRole('button', { name: 'Edit' })); await user.type(screen.getByLabelText('name'), '!'); await user.click(screen.getByRole('button', { name: 'Save' }))
  view.unmount(); await act(async () => request.resolve()); expect(notified).not.toHaveBeenCalled()
})
it('source DeleteDialog names the target, focuses Cancel and guards a deferred delete', async () => {
  const request = deferred(); const remove = vi.fn(() => request.promise)
  function DeleteBody({ close }: { close: () => void }) { const submit = useMutationSubmit(); return <form onSubmit={event => { event.preventDefault(); void submit(async () => { await remove(); close() }) }}><MutationSubmitButton type="submit">Delete</MutationSubmitButton></form> }
  render(<DeleteActionDialog trigger="Delete Ada" title="Delete client?" description="Permanent" cancelLabel="Cancel" entityType="Client" entityName="Ada">{({ close }) => <DeleteBody close={close} />}</DeleteActionDialog>)
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Delete Ada' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('"Ada"'); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  await user.click(screen.getByRole('button', { name: 'Delete' })); await user.keyboard('{Escape}')
  expect(remove).toHaveBeenCalledTimes(1); expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => request.resolve()); expect(screen.queryByRole('alertdialog')).toBeNull()
})
it('salvaged record footer keeps Cancel then Save adjacent and never adds audit fields to the schema', async () => {
  const user = userEvent.setup(); render(<Edit />); await user.click(screen.getByRole('button', { name: 'Edit' }))
  expect([...document.querySelectorAll('[data-slot="mutation-footer"] button')].map(button => button.textContent)).toEqual(['Cancel', 'Save'])
  expect([...document.querySelectorAll('[data-write-field]')].map(field => field.getAttribute('data-write-field'))).toEqual(['name'])
})

it('numeric and nullable relation reversions compare with normalized RHF defaults', async () => {
  const user = userEvent.setup()
  render(<ActionDialog trigger="Edit" title="Edit" description="Typed fields" cancelLabel="Cancel">{() => <RegistryForm requireDirty schema={{ type: 'object', properties: { count: { type: 'integer' }, owner: { anyOf: [{ type: 'string' }, { type: 'null' }] } } }} values={{ count: 3, owner: null }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={async () => {}} relation={(name, value, change) => name === 'owner' ? <label>owner<select value={value} onChange={event => change(event.target.value)}><option value="">None</option><option value="ada">Ada</option></select></label> : undefined} />}</ActionDialog>)
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  await user.clear(screen.getByLabelText('count')); await user.type(screen.getByLabelText('count'), '4'); expect(save.disabled).toBe(false)
  await user.clear(screen.getByLabelText('count')); await user.type(screen.getByLabelText('count'), '3'); expect(save.disabled).toBe(true)
  await user.selectOptions(screen.getByLabelText('owner'), 'ada'); expect(save.disabled).toBe(false)
  await user.selectOptions(screen.getByLabelText('owner'), ''); expect(save.disabled).toBe(true)
})
