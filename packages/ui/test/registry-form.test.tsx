import { StrictMode, useLayoutEffect } from 'react'
import { useFormContext, type UseFormReturn } from 'react-hook-form'
import { beforeAll, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RegistryForm } from '../src'
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
const schema = { type: 'object', properties: { name: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1 }, active: { type: 'boolean' }, starts: { type: 'string', format: 'date-time' }, priority: { type: 'string', enum: ['low', 'high'] } }, required: ['name', 'count', 'active', 'starts', 'priority'], additionalProperties: false }
it('zod registry form maps typed widgets and inline errors before submitting values', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={schema} label={name => name} submitLabel="Save" invalidLabel="Invalid value" onSubmit={submit} />)
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  await user.type(screen.getByLabelText('count'), '0'); await user.click(screen.getByRole('button', { name: 'Save' })); expect(screen.getAllByRole('alert').length).toBe(4); expect(submit).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('name'), 'Ada'); await user.clear(screen.getByLabelText('count')); await user.type(screen.getByLabelText('count'), '3'); await user.click(screen.getByLabelText('active'))
  await user.click(screen.getByLabelText('starts'))
  const day = document.querySelector<HTMLButtonElement>('button[data-day][data-outside=\"false\"]') ?? document.querySelector<HTMLButtonElement>('button[data-day]')!
  const chosen = new Date(day.getAttribute('data-day')!); chosen.setHours(12, 0, 0, 0)
  await user.click(day); fireEvent.change(screen.getByLabelText('Time'), { target: { value: '12:00' } }); await user.keyboard('{Escape}')
  fireEvent.keyDown(screen.getByLabelText('priority'), { key: 'Enter' }); await user.click(screen.getByRole('option', { name: 'high' }))
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit.mock.calls[0][0]).toEqual({ name: 'Ada', count: 3, active: true, starts: chosen.toISOString(), priority: 'high' })
})
it('editing a datetime preserves the initial value and submits the ISO registry format', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { starts: schema.properties.starts }, required: ['starts'] }} values={{ starts: '2026-10-24T12:00:00.000Z' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} />)
  const trigger = screen.getByLabelText('starts')
  expect(trigger.textContent).toContain('24. 10. 2026')
  expect(trigger.getAttribute('aria-label')).toContain(trigger.textContent!.trim())
  await user.click(screen.getByLabelText('starts'))
  await user.click(screen.getByRole('button', { name: /^25 — / }))
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '12:00' } }); await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit.mock.calls[0][0]).toEqual({ starts: new Date('2026-10-25T12:00').toISOString() })
})
it('structured command input validates arrays and preserves a structured payload', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { quantity: { type: 'integer', minimum: 1 } }, required: ['quantity'] }, minItems: 1 } }, required: ['items'] }} label={name => name} submitLabel="Run" invalidLabel="Invalid" onSubmit={submit} />)
  await user.click(screen.getByLabelText('items')); await user.paste('[bad json'); await user.click(screen.getByRole('button', { name: 'Run' })); expect(screen.getByRole('alert')).toBeTruthy(); expect(submit).not.toHaveBeenCalled()
  await user.clear(screen.getByLabelText('items')); await user.paste('[{"quantity":2}]'); await user.click(screen.getByRole('button', { name: 'Run' })); expect(submit.mock.calls[0][0]).toEqual({ items: [{ quantity: 2 }] })
})
// RFC 0005 decision 4; independent C3 review F3: no invented field attribution.
it('pathless server validation shows one summary and leaves valid fields unmarked', () => {
  render(<RegistryForm schema={{ type: 'object', properties: { name: schema.properties.name, email: { type: 'string' } } }} values={{ name: 'Ada' }} serverInvalid label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={() => {}} />)
  expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual(['Invalid'])
  expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
  expect(screen.getByLabelText('name').getAttribute('aria-invalid')).toBe('false')
})
it('inline registry forms compose without a nested form and submit through their own button', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  const result = render(<form><RegistryForm inline schema={{ type: 'object', properties: { name: schema.properties.name }, required: ['name'] }} label={name => name} submitLabel="Create related" invalidLabel="Invalid" onSubmit={submit} /></form>)
  expect(result.container.querySelectorAll('form')).toHaveLength(1)
  await user.type(screen.getByLabelText('name'), 'Ada'); await user.click(screen.getByRole('button', { name: 'Create related' })); expect(submit.mock.calls[0][0]).toEqual({ name: 'Ada' })
})

it('structured server field errors mark only the named field and clear when it changes', async () => {
  render(<RegistryForm schema={{ type: 'object', properties: { name: schema.properties.name, email: { type: 'string' } } }} serverErrors={{ name: 'Closed field error' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={() => {}} />)
  const input = screen.getByLabelText('name'); expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ')).toBe('Closed field error')
  expect(screen.getByLabelText('email').getAttribute('aria-invalid')).toBe('false')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  await userEvent.setup().type(input, 'New choice')
  expect(screen.queryByText('Closed field error')).toBeNull()
  expect(input.getAttribute('aria-invalid')).toBe('false')
})

// Requirements salvaged from 4e64b58; metadata replaces its recordLayout flag/name heuristic.
it('SR-37 declared field order preserves sections, appends unspecified fields and cannot expose hidden fields', () => {
  const result = render(<RegistryForm schema={{ type: 'object', 'x-ui': { fieldOrder: ['name', 'street', 'city', 'members', 'name', 'hidden', 'readonly', 'unknown'] }, properties: {
    members: { type: 'string' }, city: { type: 'string', 'x-ui': { section: 'Address' } },
    extra: { type: 'string' }, name: { type: 'string' }, street: { type: 'string', 'x-ui': { section: 'Address' } },
    hidden: { type: 'string', 'x-ui': { hidden: true } }, readonly: { type: 'string', readOnly: true },
  } }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={() => {}} />)
  expect([...result.container.querySelectorAll('[data-write-field]')].map(node => node.getAttribute('data-write-field'))).toEqual(['name', 'street', 'city', 'members', 'extra'])
  expect(screen.getByRole('group', { name: 'Address' }).querySelectorAll('[data-write-field]')).toHaveLength(2)
})
it('metadata pairs short fields and keeps long/section fields full width without hiding business ids', () => {
  const result = render(<RegistryForm schema={{ type: 'object', properties: {
    name: { type: 'string', 'x-ui': { span: 'half' } }, email: { type: 'string', format: 'email', 'x-ui': { span: 'half' } },
    note: { type: 'string', 'x-ui': { kind: 'textarea', span: 'full', section: 'Details' } }, external_id: { type: 'string' },
    audit: { type: 'string', readOnly: true }, actor: { type: 'string', 'x-ui': { hidden: true } },
  }, required: ['audit', 'actor'] }} label={name => name} submitLabel="Create" invalidLabel="Invalid" onSubmit={() => {}} />)
  expect(result.container.querySelector('[data-write-field="name"]')!.parentElement!.className).toContain('grid-cols-1 gap-4 sm:grid-cols-2')
  expect(result.container.querySelector('[data-write-field="name"]')!.className).not.toContain('col-span-2')
  expect(result.container.querySelector('[data-write-field="note"]')!.className).toContain('sm:col-span-2')
  expect(screen.getByRole('group', { name: 'Details' })).toBeTruthy(); expect(screen.getByLabelText('note').tagName).toBe('TEXTAREA')
  expect(screen.getByLabelText('email').getAttribute('type')).toBe('email')
  expect(screen.getByLabelText('external_id')).toBeTruthy(); expect(screen.queryByLabelText('audit')).toBeNull(); expect(screen.queryByLabelText('actor')).toBeNull()
})
it('explicit colour metadata synchronizes the source swatch and nullable hex value, without guessing names', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { tint: { anyOf: [{ type: 'string' }, { type: 'null' }], 'x-ui': { kind: 'colour' } }, color_id: { type: 'string' } } }} values={{ tint: '#3b82f6' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} />)
  const swatch = screen.getByLabelText('tint swatch') as HTMLInputElement
  expect(swatch.type).toBe('color'); expect(swatch.value).toBe('#3b82f6')
  expect(screen.getByLabelText('color_id').getAttribute('type')).toBe('text')
  fireEvent.change(swatch, { target: { value: '#ff0000' } }); expect((screen.getByLabelText('tint') as HTMLInputElement).value).toBe('#ff0000')
  await user.clear(screen.getByLabelText('tint')); await user.type(screen.getByLabelText('tint'), '#00ff00'); expect(swatch.value).toBe('#00ff00')
  await user.clear(screen.getByLabelText('tint')); await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit.mock.calls[0][0]).toEqual({ tint: null })
})
it('nullable numeric and relation values submit null and numbers without hidden required fields', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { quantity: { anyOf: [{ type: 'number' }, { type: 'null' }] }, target: { anyOf: [{ type: 'string' }, { type: 'null' }] }, managed: { type: 'string', readOnly: true } }, required: ['managed'] }} values={{ quantity: 2.5, target: 'a' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} relation={(name, value, change) => name === 'target' ? <input aria-label="target" value={value} onChange={event => change(event.target.value)} /> : undefined} />)
  await user.clear(screen.getByLabelText('quantity')); await user.type(screen.getByLabelText('quantity'), '3.75')
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit.mock.calls[0][0]).toEqual({ quantity: 3.75, target: 'a' }); submit.mockClear()
  await user.clear(screen.getByLabelText('quantity')); await user.clear(screen.getByLabelText('target'))
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit.mock.calls[0][0]).toEqual({ quantity: null, target: null })
})

it('date-only calendar changes preserve local days across the DST boundary', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { day: { type: 'string', format: 'date', 'x-ui': { kind: 'date', span: 'half' } } }, required: ['day'] }} values={{ day: '2026-10-24' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} />)
  const trigger = screen.getByLabelText('day'); expect(trigger.getAttribute('aria-label')).toContain('24. 10. 2026')
  await user.click(trigger); expect(screen.getByRole('dialog', { name: /^day: / })).toBeTruthy(); await user.click(screen.getByRole('button', { name: /^25 — / }))
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit.mock.calls[0][0]).toEqual({ day: '2026-10-25' })
})

it('row command submits an unchanged prefilled request id', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { requestId: { type: 'string', minLength: 1 } }, required: ['requestId'] }} values={{ requestId: 'request-123' }} label={name => name} submitLabel="Run" invalidLabel="Invalid" onSubmit={submit} />)
  expect((screen.getByLabelText('requestId') as HTMLInputElement).value).toBe('request-123')
  await user.click(screen.getByRole('button', { name: 'Run' }))
  expect(submit).toHaveBeenCalledExactlyOnceWith({ requestId: 'request-123' })
})

// D1: generated optional fields use JSON Schema type arrays, not only anyOf.
it.each([
  { type: ['boolean', 'null'] },
  { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
  { type: 'boolean' },
])('optional boolean %j preserves true, false and unanswered as typed values', async raw => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { answer: raw } }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} />)
  const answer = screen.getByRole('combobox', { name: 'answer' })
  expect(answer.textContent).toContain('Unfilled')
  for (const [text, value] of [['Yes', true], ['No', false], ['Unfilled', raw.type === 'boolean' ? undefined : null]] as const) {
    await user.click(answer); await user.click(screen.getByRole('option', { name: text }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(submit.mock.lastCall![0].answer).toBe(value)
  }
})
it.each([true, false, null])('nullable type array retains existing boolean %j without coercion', async answer => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { answer: { type: ['boolean', 'null'] } } }} values={{ answer }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} />)
  expect(screen.getByRole('combobox', { name: 'answer' }).textContent).toContain(answer === null ? 'Unfilled' : answer ? 'Yes' : 'No')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(submit.mock.lastCall![0]).toEqual({ answer })
})
it('nullable type arrays normalize numeric and string empties consistently', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm schema={{ type: 'object', properties: { count: { type: ['number', 'null'] }, note: { type: ['string', 'null'] } } }} values={{ count: 2 }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} />)
  await user.clear(screen.getByLabelText('count')); await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(submit.mock.lastCall![0]).toEqual({ count: null, note: null })
})

it('SR-13 defaults initialize absent values while edits preserve explicit null, false and zero', async () => {
  const submit = vi.fn()
  const defaults = { type: 'object', properties: { amount: { type: ['number', 'null'], default: 5 }, active: { type: ['boolean', 'null'], default: true }, note: { type: ['string', 'null'], default: 'New' } } }
  const props = { schema: defaults, label: (name: string) => name, submitLabel: 'Save', invalidLabel: 'Invalid', onSubmit: submit }
  const view = render(<RegistryForm {...props} />)
  expect((screen.getByLabelText('amount') as HTMLInputElement).value).toBe('5')
  expect(screen.getByRole('combobox', { name: 'active' }).textContent).toContain('Yes')
  expect((screen.getByLabelText('note') as HTMLInputElement).value).toBe('New')
  view.unmount()
  render(<RegistryForm {...props} values={{ amount: 0, active: false, note: null }} />)
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(submit.mock.lastCall![0]).toEqual({ amount: 0, active: false, note: null })
})

it('partial edits never apply create defaults to absent untouched values', async () => {
  const submit = vi.fn(); const user = userEvent.setup()
  render(<RegistryForm partial requireDirty schema={{ type: 'object', properties: { name: { type: 'string', minLength: 1 }, email: { type: ['string', 'null'], default: 'default@example.test' }, count: { type: 'integer', default: 7 } }, required: ['name', 'count'] }} values={{ name: 'Ada' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={submit} />)
  expect((screen.getByLabelText('email') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('count') as HTMLInputElement).value).toBe('')
  await user.type(screen.getByLabelText('name'), ' Lovelace'); await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(submit).toHaveBeenCalledExactlyOnceWith({ name: 'Ada Lovelace' })
})

// #162: real RHF observations, shared by ordinary and custom renderers.
let observed: UseFormReturn<Record<string, any>>
function ObservedField({ name, value, change }: { name: string; value: string; change: (value: string) => void }) {
  observed = useFormContext()
  // Subscribe to dirty/default/touched/error state, as mutation safety does.
  void observed.formState.isDirty; void observed.formState.dirtyFields; void observed.formState.defaultValues
  return <input aria-label={name} value={value} onBlur={() => observed.setValue(name, value, { shouldTouch: true })} onChange={event => change(event.target.value)} />
}
const lifecycleProps = { partial: true, requireDirty: true, label: (name: string) => name, submitLabel: 'Save', invalidLabel: 'Invalid', onSubmit: vi.fn(), relation: (name: string, value: string, change: (value: string) => void) => name === 'probe' || name === 'note' || name === 'members' ? <ObservedField name={name} value={value} change={change} /> : undefined }
const initialSchema = { type: 'object', properties: { name: { type: 'string' }, probe: { type: 'string' } } }
it.each(['note', 'members'])('A1/A2 shared registration installs a late %s default and reversion is clean', async name => {
  const raw = name === 'members' ? { type: 'array', items: { type: 'string' }, 'x-ui': { valueSet: true } } : { type: ['string', 'null'] }
  const seed = name === 'members' ? ['b', 'a', 'a'] : 'tag'
  const normalized = name === 'members' ? '["a","b"]' : 'tag'
  const view = render(<RegistryForm {...lifecycleProps} schema={initialSchema} values={{ name: 'Ada', probe: '' }} />)
  const input = screen.getByLabelText('name'); fireEvent.change(input, { target: { value: 'Grace' } })
  view.rerender(<RegistryForm {...lifecycleProps} schema={{ ...initialSchema, properties: { ...initialSchema.properties, [name]: raw } }} values={{ name: 'Replacement', probe: '', [name]: seed }} />)
  await waitFor(() => expect(screen.getByLabelText(name)).toHaveProperty('value', normalized))
  expect(screen.getByLabelText('name')).toBe(input); expect(input).toHaveProperty('value', 'Grace')
  expect(observed.formState.defaultValues?.[name]).toBe(normalized); expect(observed.getFieldState(name).isDirty).toBe(false)
  fireEvent.change(screen.getByLabelText(name), { target: { value: name === 'members' ? '["b"]' : '' } })
  fireEvent.change(screen.getByLabelText(name), { target: { value: name === 'members' ? '["b","a"]' : 'tag' } })
  fireEvent.change(input, { target: { value: 'Ada' } })
  await waitFor(() => expect(observed.formState.isDirty).toBe(false))
  expect(observed.getFieldState(name).isDirty).toBe(false)
})
it('A4 first seed owns its baseline through clean refresh, masking and reauthorization', async () => {
  const schema = { ...initialSchema, properties: { ...initialSchema.properties, note: { type: 'string' } } }
  const view = render(<RegistryForm {...lifecycleProps} schema={schema} values={{ name: 'Ada', note: 'Original' }} />)
  view.rerender(<RegistryForm {...lifecycleProps} schema={initialSchema} values={{ name: 'Other' }} />)
  view.rerender(<RegistryForm {...lifecycleProps} schema={schema} values={{ name: 'Other', note: 'Replacement' }} />)
  expect(screen.getByLabelText('note')).toHaveProperty('value', 'Original')
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'Draft' } })
  view.rerender(<RegistryForm {...lifecycleProps} schema={schema} values={{ note: 'Latest' }} />)
  expect(screen.getByLabelText('note')).toHaveProperty('value', 'Draft'); expect(observed.formState.defaultValues?.note).toBe('Original')
})

const knownSeeds = { name: { state: 'known' as const, value: 'Ada' }, probe: { state: 'known' as const, value: '' } }
const kinds = [
  ['text', { type: 'string' }, 'Original', 'Original', 'Changed'],
  ['enum', { type: 'string', enum: ['low', 'high'] }, 'high', 'high', 'low'],
  ['number', { type: 'number' }, 2.5, '2.5', '3.5'],
  ['zero', { type: 'integer' }, 0, '0', '1'],
  ['false', { type: 'boolean' }, false, false, true],
  ['nullable boolean', { type: ['boolean', 'null'] }, false, false, true],
  ['date', { type: 'string', format: 'date' }, '2026-10-24', '2026-10-24', '2026-10-25'],
  ['datetime', { type: 'string', format: 'date-time' }, '2026-10-24T12:00:00.000Z', '2026-10-24T12:00:00.000Z', '2026-10-25T12:00:00.000Z'],
  ['null', { type: ['string', 'null'] }, null, '', 'Changed'],
  ['object', { type: 'object', properties: { nested: { type: 'integer' } } }, { nested: 1 }, '{"nested":1}', '{"nested":2}'],
  ['array', { type: 'array', items: { type: 'integer' } }, [2, 1], '[2,1]', '[1,2]'],
] as const
it.each(kinds.flatMap(kind => ['same render', 'delayed'].map(timing => [...kind, timing] as const)))('A5 %s seed (%s / %s / %s / %s / %s) installs once under StrictMode', async (_kind, raw, seed, encoded, changed, timing) => {
  const submit = vi.fn(); const ready = vi.fn()
  const props = { ...lifecycleProps, onSubmit: submit, onReadyChange: ready }
  const view = render(<StrictMode><RegistryForm {...props} schema={initialSchema} values={{ name: 'Ada', probe: '' }} seeds={knownSeeds} /></StrictMode>)
  const input = screen.getByLabelText('name'); input.focus(); fireEvent.change(input, { target: { value: 'Grace' } }); fireEvent.blur(input)
  act(() => { observed.setError('name', { type: 'server', message: 'Keep error' }); observed.setValue('probe', '', { shouldTouch: true }) })
  const schema = { ...initialSchema, properties: { ...initialSchema.properties, late: raw } }
  const update = (state: 'known' | 'pending', value: unknown = seed) => view.rerender(<StrictMode><RegistryForm {...props} schema={schema} values={{ name: 'Replacement' }} seeds={{ ...knownSeeds, late: state === 'known' ? { state, value } : { state } }} /></StrictMode>)
  if (timing === 'delayed') {
    update('pending'); expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    fireEvent.submit(input.closest('form')!); await act(async () => {})
    expect(submit).not.toHaveBeenCalled()
  }
  update('known')
  await waitFor(() => expect(observed.formState.defaultValues?.late).toEqual(encoded))
  expect(observed.getValues('late')).toEqual(encoded); expect(observed.getFieldState('late').isDirty).toBe(false)
  expect(screen.getByLabelText('name')).toBe(input); expect(input).toHaveProperty('value', 'Grace')
  expect(observed.getFieldState('name').isTouched).toBe(true); expect(observed.getFieldState('probe').isTouched).toBe(true); expect(observed.getFieldState('name').error?.message).toBe('Keep error')
  act(() => observed.setValue('late', changed, { shouldDirty: true, shouldTouch: true }))
  expect(observed.getFieldState('late').isDirty).toBe(true)
  update('known', seed); expect(observed.getValues('late')).toEqual(changed)
  act(() => { observed.setValue('late', encoded, { shouldDirty: true }); observed.clearErrors('name') })
  expect(observed.getFieldState('late').isDirty).toBe(false)
  fireEvent.submit(input.closest('form')!); await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: 'Grace' }))
  submit.mockClear()
  act(() => observed.setValue('late', changed, { shouldDirty: true }))
  fireEvent.submit(input.closest('form')!); await waitFor(() => expect(submit).toHaveBeenCalled())
  const expected = ['number', 'zero'].includes(_kind) ? Number(changed) : _kind === 'object' || _kind === 'array' ? JSON.parse(String(changed)) : changed
  expect(submit.mock.lastCall![0].late).toEqual(expected)
})
it.each([false, true])('A6 unknown field read grant preserves explicit draft=%s and local baseline', async edited => {
  const submit = vi.fn(); const schema = { ...initialSchema, properties: { ...initialSchema.properties, note: { type: ['string', 'null'], default: 'Create default' } } }
  const props = { ...lifecycleProps, onSubmit: submit, schema }
  const view = render(<RegistryForm {...props} values={{ name: 'Ada', probe: '' }} seeds={{ ...knownSeeds, note: { state: 'unknown' } }} />)
  expect(screen.getByLabelText('note')).toHaveProperty('value', '')
  if (edited) fireEvent.change(screen.getByLabelText('note'), { target: { value: 'Unknown draft' } })
  view.rerender(<RegistryForm {...props} seeds={{ ...knownSeeds, note: { state: 'known', value: 'Authorized' } }} />)
  await waitFor(() => expect(screen.getByLabelText('note')).toHaveProperty('value', edited ? 'Unknown draft' : 'Authorized'))
  expect(observed.formState.defaultValues?.note).toBe(edited ? '' : 'Authorized')
  fireEvent.submit(screen.getByLabelText('note').closest('form')!)
  await waitFor(() => expect(submit).toHaveBeenCalledWith(edited ? { note: 'Unknown draft' } : {}))
})
function RacingField() {
  const form = useFormContext()
  useLayoutEffect(() => { form.setValue('note', 'Programmatic draft') }, [])
  return null
}
it('A6 a programmatic pre-seed edit never acknowledges readiness or overwrites the draft', async () => {
  const submit = vi.fn(); const schema = { ...initialSchema, properties: { ...initialSchema.properties, note: { type: 'string' } } }
  const relation = (name: string, value: string, change: (value: string) => void) => name === 'note' ? <><ObservedField name={name} value={value} change={change} /><RacingField /></> : lifecycleProps.relation(name, value, change)
  const props = { ...lifecycleProps, schema, onSubmit: submit, relation }
  const view = render(<RegistryForm {...props} values={{ name: 'Ada', probe: '' }} seeds={{ ...knownSeeds, note: { state: 'pending' } }} />)
  view.rerender(<RegistryForm {...props} seeds={{ ...knownSeeds, note: { state: 'known', value: 'Server' } }} />)
  expect(observed.getValues('note')).toBe('Programmatic draft'); expect(observed.formState.defaultValues?.note).toBe('')
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  fireEvent.submit(screen.getByLabelText('note').closest('form')!); await act(async () => {})
  expect(submit).not.toHaveBeenCalled()
})
it.each(['pending', 'blocked'] as const)('A8 %s seed and disabled form block native submissions and masked payloads', async state => {
  const submit = vi.fn(); const schema = { ...initialSchema, properties: { ...initialSchema.properties, note: { type: ['string', 'null'] } } }
  const props = { ...lifecycleProps, onSubmit: submit }
  const view = render(<RegistryForm {...props} schema={schema} values={{ name: 'Ada', note: 'Tag' }} />)
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'Private draft' } })
  view.rerender(<RegistryForm {...props} schema={schema} seeds={{ ...knownSeeds, note: { state } }} />)
  fireEvent.submit(screen.getByLabelText('name').closest('form')!); await act(async () => {})
  expect(submit).not.toHaveBeenCalled()
  view.rerender(<RegistryForm {...props} disabled schema={initialSchema} />)
  fireEvent.submit(screen.getByLabelText('name').closest('form')!); await act(async () => {})
  expect(submit).not.toHaveBeenCalled()
  view.rerender(<RegistryForm {...props} schema={initialSchema} />)
  fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Grace' } })
  fireEvent.submit(screen.getByLabelText('name').closest('form')!); await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: 'Grace' }))
})
it('A1 registration-to-seed gap blocks native submit before the installation effect', async () => {
  const submit = vi.fn()
  function Gap() { useLayoutEffect(() => { fireEvent.submit(screen.getByLabelText('name').closest('form')!) }, []); return null }
  const view = render(<RegistryForm {...lifecycleProps} onSubmit={submit} schema={initialSchema} values={{ name: 'Ada', probe: '' }} />)
  fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Grace' } })
  view.rerender(<RegistryForm {...lifecycleProps} onSubmit={submit} schema={{ ...initialSchema, properties: { ...initialSchema.properties, note: { type: 'string' } } }} values={{ note: 'Seed' }} relation={(name, value, change) => name === 'note' ? <><ObservedField name={name} value={value} change={change} /><Gap /></> : lifecycleProps.relation(name, value, change)} />)
  await act(async () => {}); expect(submit).not.toHaveBeenCalled(); expect(observed.formState.defaultValues?.note).toBe('Seed')
})

it('A10 inline submission stays inside an ancestor form and honors locked create defaults', async () => {
  const submit = vi.fn(), ancestor = vi.fn(), user = userEvent.setup()
  render(<form onSubmit={event => { event.preventDefault(); ancestor() }}><RegistryForm inline schema={{ type: 'object', properties: { name: { type: 'string', default: 'New' }, parent: { type: 'string' } } }} lockedValues={{ parent: 'locked' }} label={name => name} submitLabel="Create" invalidLabel="Invalid" onSubmit={submit} /></form>)
  expect(document.querySelectorAll('form')).toHaveLength(1)
  expect(screen.getByLabelText('parent').matches(':disabled')).toBe(true)
  await user.type(screen.getByLabelText('name'), ' draft'); fireEvent.keyDown(screen.getByLabelText('name'), { key: 'Enter' })
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ name: 'New draft', parent: 'locked' }))
  expect(ancestor).not.toHaveBeenCalled()
})
it('A6 unknown-to-known grant waits for the default installation before accepting native submit', async () => {
  const submit = vi.fn()
  function SubmitGap() { useLayoutEffect(() => { fireEvent.submit(screen.getByLabelText('name').closest('form')!) }, []); return null }
  const schema = { ...initialSchema, properties: { ...initialSchema.properties, note: { type: 'string' } } }
  const view = render(<RegistryForm {...lifecycleProps} onSubmit={submit} schema={schema} values={{ name: 'Ada', probe: '' }} seeds={{ ...knownSeeds, note: { state: 'unknown' } }} />)
  fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Grace' } })
  view.rerender(<RegistryForm {...lifecycleProps} onSubmit={submit} schema={schema} seeds={{ ...knownSeeds, note: { state: 'known', value: 'Server' } }} relation={(name, value, change) => name === 'note' ? <><ObservedField name={name} value={value} change={change} /><SubmitGap /></> : lifecycleProps.relation(name, value, change)} />)
  await act(async () => {}); expect(submit).not.toHaveBeenCalled()
  expect(observed.getValues('note')).toBe('Server'); expect(observed.formState.defaultValues?.note).toBe('Server')
})

it('A10 custom registered controls expose RHF focus, touched state and server-error clearing', async () => {
  render(<RegistryForm {...lifecycleProps} schema={{ type: 'object', properties: { note: { type: 'string' } } }} values={{ note: 'Seed' }} serverErrors={{ note: 'Server error' }} />)
  act(() => observed.setFocus('note'))
  expect(document.activeElement).toBe(screen.getByLabelText('note'))
  fireEvent.blur(screen.getByLabelText('note')); expect(observed.getFieldState('note').isTouched).toBe(true)
  expect(observed.getFieldState('note').error?.type).toBe('server')
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'Changed' } })
  await waitFor(() => expect(observed.getFieldState('note').error).toBeUndefined())
})

// Port of review wr-ffb38ad8's preceding-section grant probe.
it.each(['Earlier', 'Basics'])('A5/A7 a late grant in preceding %s section retains existing input DOM and focus', async section => {
  const name = { type: 'string', 'x-ui': { section: 'Basics' } }
  const late = { type: 'string', 'x-ui': { section } }
  const props = { label: (name: string) => name, submitLabel: 'Save', invalidLabel: 'Invalid', onSubmit: vi.fn(), values: { name: 'Ada' } }
  const view = render(<RegistryForm {...props} schema={{ type: 'object', 'x-ui': { fieldOrder: ['late', 'name'] }, properties: { name } }} seeds={{ name: { state: 'known', value: 'Ada' } }} />)
  const input = screen.getByLabelText('name')
  input.focus(); fireEvent.change(input, { target: { value: 'Grace' } })
  view.rerender(<RegistryForm {...props} schema={{ type: 'object', 'x-ui': { fieldOrder: ['late', 'name'] }, properties: { late, name } }} seeds={{ name: { state: 'known', value: 'Ada' }, late: { state: 'known', value: 'Seed' } }} />)
  await waitFor(() => expect(screen.getByLabelText('late')).toHaveProperty('value', 'Seed'))
  expect(screen.getByLabelText('name')).toHaveProperty('value', 'Grace')
  expect(screen.getByLabelText('name')).toBe(input)
  expect(document.activeElement).toBe(input)
})

it('A5/A7 repeated section labels retain both existing runs when an earlier run is granted', async () => {
  const field = (section: string) => ({ type: 'string', 'x-ui': { section } })
  const props = { label: (name: string) => name, submitLabel: 'Save', invalidLabel: 'Invalid', onSubmit: vi.fn(), values: { name: 'Ada', tail: 'Tail' } }
  const order = ['late', 'separator', 'name', 'middle', 'tail']
  const properties = { name: field('Basics'), middle: field('Middle'), tail: field('Basics') }
  const view = render(<RegistryForm {...props} schema={{ type: 'object', 'x-ui': { fieldOrder: order }, properties }} />)
  const input = screen.getByLabelText('name'), tail = screen.getByLabelText('tail')
  input.focus(); fireEvent.change(input, { target: { value: 'Grace' } })
  view.rerender(<RegistryForm {...props} schema={{ type: 'object', 'x-ui': { fieldOrder: order }, properties: { late: field('Basics'), separator: field('Separator'), ...properties } }} />)
  expect(screen.getAllByRole('group', { name: 'Basics' })).toHaveLength(3)
  expect(screen.getByLabelText('name')).toHaveProperty('value', 'Grace')
  expect(screen.getByLabelText('name')).toBe(input)
  expect(screen.getByLabelText('tail')).toBe(tail)
  expect(document.activeElement).toBe(input)
})
