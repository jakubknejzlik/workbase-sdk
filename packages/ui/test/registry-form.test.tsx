import { beforeAll, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

it('structured server field errors mark only the named field', () => {
  render(<RegistryForm schema={{ type: 'object', properties: { name: schema.properties.name, email: { type: 'string' } } }} serverErrors={{ name: 'Closed field error' }} label={name => name} submitLabel="Save" invalidLabel="Invalid" onSubmit={() => {}} />)
  const input = screen.getByLabelText('name'); expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ')).toBe('Closed field error')
  expect(screen.getByLabelText('email').getAttribute('aria-invalid')).toBe('false')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
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
