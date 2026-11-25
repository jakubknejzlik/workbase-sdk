import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { DataTable, DataTableFilterDropdown, DataTableActiveFilters, MultiSelectFilter, RangeFilter, ToggleFilter } from '../src'
it('C7b non-modal filter shell has expanded state, Escape returns focus, active marker has text', async () => {
  const user = userEvent.setup()
  render(<DataTableFilterDropdown label="Filter Title" active activeLabel="Active filter">{() => <input aria-label="Contains" />}</DataTableFilterDropdown>)
  const trigger = screen.getByRole('button', { name: 'Filter Title' })
  await user.click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('dialog').hasAttribute('aria-modal')).toBe(false)
  expect(screen.getAllByText('Active filter').length).toBeGreaterThan(0)
  await user.keyboard('{Escape}')
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
it('C7b chips expose full removal names and independent clear-all action', () => {
  const remove = vi.fn(); const clear = vi.fn()
  render(<DataTableActiveFilters label="Active filters" clearLabel="Clear all" onClear={clear} filters={[{ id: 'client', column: 'Client', value: 'Ada', removeLabel: 'Remove filter: Client Ada', onRemove: remove }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Client Ada' })); expect(remove).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' })); expect(clear).toHaveBeenCalledTimes(1)
})
it('C7b multi-select explains cap and still allows deselection', () => {
  const change = vi.fn()
  render(<MultiSelectFilter value={['a', 'b']} options={['a', 'b', 'c'].map(id => ({ id, label: id }))} cap={2} capLabel="Maximum two" onChange={change} />)
  expect((screen.getByRole('checkbox', { name: 'c' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('checkbox', { name: 'a' }).tagName).toBe('BUTTON')
  expect(screen.getByRole('status').textContent).toBe('Maximum two')
  fireEvent.click(screen.getByLabelText('a')); expect(change).toHaveBeenLastCalledWith(['b'])
})
it('calendar range and tri-state Select preserve staged host values without native widgets', async () => {
  const user = userEvent.setup(); const change = vi.fn()
  const { rerender } = render(<RangeFilter value={{}} onChange={change} type="date" labels={{ single: 'Single', from: 'From', to: 'To' }} />)
  expect(screen.getByLabelText('Single').getAttribute('type')).toBe('text')
  expect(screen.queryByLabelText('From')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Select date range: Single' }))
  expect(screen.getByRole('grid')).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select date range: Single' }))
  rerender(<RangeFilter value={{}} onChange={vi.fn()} type="number" labels={{ single: 'Single', from: 'From', to: 'To' }} />)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Operator' }), 'from')
  expect(screen.getByLabelText('From').getAttribute('type')).toBe('number')
  rerender(<ToggleFilter value={undefined} onChange={change} labels={{ label: 'Value', all: 'All', yes: 'Yes', no: 'No' }} />)
  expect(screen.getByRole('combobox').tagName).toBe('BUTTON')
  await user.click(screen.getByRole('combobox')); await user.click(screen.getByRole('option', { name: 'No' }))
  expect(change).toHaveBeenLastCalledWith(false)
})
it('lower-bound calendar selects one date and emits no equality or upper bound', async () => {
  const user = userEvent.setup(), change = vi.fn()
  render(<RangeFilter lowerBoundOnly value={{ from: '2026-11-19', to: '2026-11-25', value: '2026-11-01' }} onChange={change} type="date" labels={{ single: 'Single', from: 'From', to: 'To' }} />)
  expect(screen.queryByLabelText('Single')).toBeNull()
  expect(screen.queryByLabelText('To')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Select date range: From' }))
  await user.click(screen.getByRole('button', { name: /November 20th, 2026/ }))
  expect(change).toHaveBeenLastCalledWith({ from: '2026-11-20' })
  expect(screen.queryByRole('grid')).toBeNull()
})
it('C7b empty recovery preserves the exact No results message and removes the empty range', () => {
  const clear = vi.fn()
  render(<DataTable rows={[]} columns={[]} state={{ search: 'missing', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={{ search: 'Search', clearSearch: 'Clear search', noResults: 'No results', previous: 'Previous', next: 'Next', pageSize: 'Rows per page', sort: String, range: (start, end) => `${start}–${end}` }} onRowClick={vi.fn()} clearFilters="Clear search and filters" onClearFilters={clear} />)
  expect(screen.getByText('No results', { exact: true })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' })); expect(clear).toHaveBeenCalledTimes(1)
})

it('D6 column headers retain the column label as their accessible name', () => {
  render(<DataTable rows={[{ id: '1', title: 'Example' }]} columns={[{ id: 'title', label: 'Title', sortable: true, cell: row => row.title }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={{ search: 'Search', clearSearch: 'Clear search', noResults: 'No results', previous: 'Previous', next: 'Next', pageSize: 'Rows per page', sort: column => `Sort ${column}`, range: (start, end) => `${start}–${end}` }} onRowClick={vi.fn()} />)
  expect(screen.getByRole('columnheader', { name: 'Title' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sort Title' })).toBeTruthy()
})
it('D17 truncated cells retain their full text in a title', () => {
  const title = 'A long record name '.repeat(40)
  render(<DataTable rows={[{ id: '1', title }]} columns={[{ id: 'title', label: 'Title', cell: row => row.title }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={{ search: 'Search', clearSearch: 'Clear search', noResults: 'No results', previous: 'Previous', next: 'Next', pageSize: 'Rows per page', sort: String, range: (start, end) => `${start}–${end}` }} onRowClick={vi.fn()} />)
  expect(screen.getByRole('cell').firstElementChild?.getAttribute('title')).toBe(title)
})

it.each(['number', 'date'] as const)('compact %s modes show only matching inputs and discard hidden values', async type => {
  const user = userEvent.setup(), change = vi.fn()
  render(<RangeFilter value={{}} onChange={change} type={type} labels={{ single: 'Single', from: 'From', to: 'To', operator: 'Operator', equals: 'Equals', between: 'Between' }} />)
  for (const [operator, labels] of [['equals', ['Single']], ['from', ['From']], ['to', ['To']], ['between', ['From', 'To']]] as const) {
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator' }), operator)
    expect(change).toHaveBeenLastCalledWith({})
    for (const label of ['Single', 'From', 'To']) expect(!!screen.queryByLabelText(label)).toBe(labels.includes(label as never))
    expect(screen.queryByRole('grid')).toBeNull()
    fireEvent.change(screen.getByLabelText(labels[0]), { target: { value: type === 'date' ? '2026-11-20' : '12' } })
    expect(change).toHaveBeenLastCalledWith(operator === 'equals' ? { value: type === 'date' ? '2026-11-20' : '12' } : operator === 'to' ? { to: type === 'date' ? '2026-11-20' : '12' } : operator === 'between' ? { from: type === 'date' ? '2026-11-20' : '12', to: undefined } : { from: type === 'date' ? '2026-11-20' : '12' })
  }
})
it.each([
  { operators: ['eq'], expected: ['equals'] },
  { operators: ['gte'], expected: ['from'] },
  { operators: ['lte'], expected: ['to'] },
  { operators: ['gte', 'lte'], expected: ['from', 'to', 'between'] },
  { operators: ['gte', 'lt'], localDay: true, expected: ['equals', 'from', 'to', 'between'] },
  { operators: ['lt'], localDay: true, expected: ['to'] },
])('exposes exactly descriptor-compatible operators: %j', ({ operators, localDay, expected }) => {
  render(<RangeFilter value={{}} onChange={vi.fn()} type={localDay ? 'date' : 'number'} localDay={localDay} operators={operators} labels={{ single: 'Single', from: 'From', to: 'To' }} />)
  expect(screen.getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(expected)
})
