import { useFormContext, type UseFormReturn } from 'react-hook-form'
import { expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RegistryForm, getMutationSafetySnapshot } from '../src'

let observed: UseFormReturn<Record<string, any>>
function Observe() {
  observed = useFormContext()
  void observed.formState.dirtyFields; void observed.formState.isDirty
  return null
}

// Review wr-ea837be5: a middle field splits/merges two runs of the same section.
it.each(['grant', 'revoke'] as const)('A5/A7 section %s preserves surviving input DOM, focus, draft and dirty baseline', async transition => {
  const field = (section: string) => ({ type: 'string', 'x-ui': { section, span: 'half' } })
  const properties = { name: field('Basics'), separator: field('Middle'), tail: field('Basics') }
  const masked = { name: properties.name, tail: properties.tail }
  const schema = (middle: boolean) => ({ type: 'object', 'x-ui': { fieldOrder: ['name', 'separator', 'tail'] }, properties: middle ? properties : masked })
  const submit = vi.fn()
  const props = { partial: true, requireDirty: true, label: (name: string) => name, submitLabel: 'Save', invalidLabel: 'Invalid', onSubmit: submit, values: { name: 'Ada', separator: 'Seed', tail: 'Tail' }, secondaryAction: <Observe /> }
  const view = render(<RegistryForm {...props} schema={schema(transition === 'revoke')} />)
  const original = screen.getByLabelText('tail'), name = screen.getByLabelText('name')
  original.focus(); fireEvent.change(original, { target: { value: 'Grace' } }); fireEvent.blur(original); original.focus()
  expect(observed.getFieldState('tail').isDirty).toBe(true)
  expect(getMutationSafetySnapshot().dirty).toBe(true)
  view.rerender(<RegistryForm {...props} schema={schema(transition === 'grant')} />)
  if (transition === 'grant') await waitFor(() => expect(screen.getByLabelText('separator')).toHaveProperty('value', 'Seed'))
  else expect(screen.queryByLabelText('separator')).toBeNull()
  expect(screen.getByLabelText('tail')).toHaveProperty('value', 'Grace')
  expect(observed.formState.defaultValues?.tail).toBe('Tail')
  expect(observed.getFieldState('tail')).toMatchObject({ isDirty: true, isTouched: true })
  expect(getMutationSafetySnapshot().dirty).toBe(true)
  expect({ sameInput: screen.getByLabelText('tail') === original, sameFocus: document.activeElement === original }).toEqual({ sameInput: true, sameFocus: true })
  expect(screen.getByLabelText('name')).toBe(name)
  fireEvent.submit(original.closest('form')!)
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ tail: 'Grace' }))
  // The original field default must still clear dirty state when restored.
  fireEvent.change(original, { target: { value: 'Tail' } })
  await act(async () => {})
  expect(observed.getFieldState('tail').isDirty).toBe(false)
  expect(getMutationSafetySnapshot().dirty).toBe(false)
})
