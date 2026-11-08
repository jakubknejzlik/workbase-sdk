import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ActionDialog } from '../src'

it('mutation dialog focuses Cancel, creates a key per open and destroys secret form state on dismissal', async () => {
  const keys: string[] = []
  function Body({ submissionKey }: { submissionKey: string }) {
    const [secret, setSecret] = useState('')
    return <><output aria-label="Submission key">{submissionKey}</output><input aria-label="Secret" value={secret} onChange={event => setSecret(event.target.value)} /></>
  }
  render(<ActionDialog trigger="Create token" title="Token" description="Shown once" cancelLabel="Cancel" destructive>{controls => <Body submissionKey={controls.submissionKey} />}</ActionDialog>)
  const user = userEvent.setup(); const trigger = screen.getByRole('button', { name: 'Create token' })
  await user.click(trigger); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  keys.push(screen.getByLabelText('Submission key').textContent!)
  await user.type(screen.getByLabelText('Secret'), 'raw-token-canary')
  expect(screen.getByLabelText('Submission key').textContent).toBe(keys[0])
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger)
  await user.keyboard('{Enter}'); keys.push(screen.getByLabelText('Submission key').textContent!)
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/); expect(keys[1]).not.toBe(keys[0])
  expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('')
  await user.click(screen.getByRole('button', { name: 'Cancel' })); expect(document.activeElement).toBe(trigger)
})

it('mutation dialog contains programmatic focus as well as keyboard traversal', async () => {
  render(<><button>Outside</button><ActionDialog trigger="Edit" title="Edit" description="Record" cancelLabel="Cancel">{() => <input aria-label="Name" />}</ActionDialog></>)
  await userEvent.click(screen.getByRole('button', { name: 'Edit' })); screen.getByRole('button', { name: 'Outside' }).focus()
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
})

it('dirty schema fields retain values when focus returns from an outside portal; pointer dismissal still prompts', async () => {
  const { RegistryForm, SchemaFormDialog } = await import('../src')
  const schema = { type: 'object', properties: { name: { type: 'string', 'x-ui': { span: 'half' } } } }
  render(<><button>Outside portal trigger</button><SchemaFormDialog schema={schema} trigger="Edit schema" title="Edit schema" description="Record" cancelLabel="Cancel">{() => <RegistryForm schema={schema} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={() => {}} />}</SchemaFormDialog></>)
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Edit schema' }))
  await user.type(screen.getByLabelText('name'), 'Retained')
  screen.getByRole('button', { name: 'Outside portal trigger' }).focus()
  expect(screen.queryByText('Discard changes?')).toBeNull()
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('Retained')
  await user.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.getByText('Discard changes?')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Continue Editing' })); expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('Retained')
})

it('schema dialogs focus the visible source Select trigger before its native form bridge', async () => {
  const { RegistryForm, SchemaFormDialog } = await import('../src')
  const schema = { type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'], 'x-ui': { kind: 'select', span: 'half' } } } }
  render(<SchemaFormDialog schema={schema} trigger="Select form" title="Select form" description="Record" cancelLabel="Cancel">{() => <RegistryForm schema={schema} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={() => {}} />}</SchemaFormDialog>)
  await userEvent.click(screen.getByRole('button', { name: 'Select form' }))
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'choice' }))
})
