import { act, render, renderHook, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { DataTable, DataTableSearch, useResourceSearch, createDataTableQueryKey } from '../src'
const labels = { search: 'Search', clearSearch: 'Clear search', noResults: 'No results', previous: 'Previous page', next: 'Next page', pageSize: 'Rows per page', sort: (column: string) => `Sort ${column}`, range: (start: number, end: number) => `${start}–${end}` }
it('controlled manual table renders server order and reports all three sort states accessibly', () => {
  const onStateChange = vi.fn(); const rows = [{ id: 'b' }, { id: 'a' }]
  const props = { rows, columns: [{ id: 'id', label: 'ID', sortable: true, cell: (row: { id: string }) => row.id }], onStateChange, page: 0, onPage: vi.fn(), isFetching: false, label: 'Records', labels, onRowClick: vi.fn() }
  const { rerender } = render(<DataTable {...props} state={{ search: '', sort: null, limit: 30 }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sort ID' }))
  expect(onStateChange).toHaveBeenLastCalledWith({ search: '', sort: { key: 'id', direction: 'asc' }, limit: 30 }, 'sort')
  rerender(<DataTable {...props} state={{ search: '', sort: { key: 'id', direction: 'asc' }, limit: 30 }} />)
  expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('ascending')
  expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['b', 'a'])
  fireEvent.click(screen.getByRole('button', { name: 'Sort ID' }))
  expect(onStateChange.mock.lastCall![0].sort.direction).toBe('desc')
  rerender(<DataTable {...props} state={{ search: '', sort: { key: 'id', direction: 'desc' }, limit: 30 }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sort ID' })); expect(onStateChange.mock.lastCall![0].sort).toBeNull()
})
it('source Select page size commits once; loading retains server rows, busy state and source overlay', async () => {
  const change = vi.fn(); const user = userEvent.setup()
  const props = { rows: [{ id: 'a' }], columns: [{ id: 'id', label: 'ID', cell: (row: { id: string }) => row.id }], state: { search: '', sort: null, limit: 30 }, onStateChange: change, page: 1, onPage: vi.fn(), nextCursor: 'opaque', label: 'Records', labels, onRowClick: vi.fn() }
  const view = render(<DataTable {...props} isFetching={false} />)
  await user.click(screen.getByRole('combobox', { name: labels.pageSize })); await user.click(screen.getByRole('option', { name: '100' }))
  expect(change.mock.lastCall).toEqual([{ search: '', sort: null, limit: 100 }, 'limit'])
  view.rerender(<DataTable {...props} isFetching />)
  expect(screen.getByRole('status').textContent).toBe('31–31')
  expect(screen.getByRole('cell').textContent).toBe('a')
  expect(screen.getByRole('button', { name: labels.next }).hasAttribute('disabled')).toBe(true)
  expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  expect(screen.getByTestId('data-table-loading')).toBeTruthy()
  expect(createDataTableQueryKey('records', 'org')).toEqual(['data-table', 'records', 'org'])
})
it('500 ms search debounce clears pending work on clear and external state restoration', () => {
  vi.useFakeTimers()
  try {
    const change = vi.fn(); const { rerender } = render(<DataTableSearch value="" onChange={change} label="Search" clearLabel="Clear search" />)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'a' } }); act(() => vi.advanceTimersByTime(499)); expect(change).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1)); expect(change).toHaveBeenLastCalledWith('a')
    fireEvent.change(input, { target: { value: 'ab' } }); fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    act(() => vi.advanceTimersByTime(500)); expect(change).toHaveBeenLastCalledWith(''); expect(change).toHaveBeenCalledTimes(2)
    fireEvent.change(input, { target: { value: 'stale' } }); rerender(<DataTableSearch value="restored" onChange={change} label="Search" clearLabel="Clear search" />)
    act(() => vi.advanceTimersByTime(500)); expect(change).toHaveBeenCalledTimes(2); expect((input as HTMLInputElement).value).toBe('restored')
  } finally { vi.useRealTimers() }
})
it('row cell navigation excludes nested buttons and links', () => {
  const onRow = vi.fn()
  render(<DataTable rows={[{ id: 'a' }]} columns={[{ id: 'id', label: 'ID', cell: row => <><span>{row.id}</span><button>Action</button><a href="#target">Detail</a></> }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} onRowClick={onRow} />)
  fireEvent.click(screen.getByRole('button', { name: 'Action' })); fireEvent.click(screen.getByRole('link')); expect(onRow).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('a')); expect(onRow).toHaveBeenCalledTimes(1)
})

it('Back to another sort/page cancels pending search even when the committed search is unchanged', () => {
  vi.useFakeTimers()
  try {
    const change = vi.fn(); render(<DataTableSearch value="" onChange={change} label="Search" clearLabel="Clear search" />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'pending' } })
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    act(() => vi.advanceTimersByTime(500)); expect(change).not.toHaveBeenCalled(); expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  } finally { vi.useRealTimers() }
})

it('D2 search exposes one explicit clear control without the browser search cancel widget', () => {
  render(<DataTableSearch value="query" onChange={vi.fn()} label="Search" clearLabel="Clear search" />)
  expect(screen.getByRole('searchbox').getAttribute('type')).toBe('text')
  expect(screen.getByRole('searchbox').getAttribute('role')).toBe('searchbox')
  expect(screen.getAllByRole('button', { name: 'Clear search' })).toHaveLength(1)
})

it('C7A-01 no effective search fields means no enabled search control', () => {
  render(<DataTable rows={[{ id: 'unrelated' }]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} searchAvailable={false} onRowClick={vi.fn()} />)
  expect(screen.queryByRole('searchbox')).toBeNull()
})

it('C7A-03 canonical DataTable is the controlled server composition', () => {
  render(<DataTable rows={[{ id: 'canonical' }]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} onRowClick={vi.fn()} />)
  expect(screen.getByRole('cell').textContent).toBe('canonical')
  expect(document.querySelector('[data-slot="data-table"]')).toBeTruthy()
})
it('C7A-03 fleet search bundles share local state and adapt to controlled router state', () => {
  const { result } = renderHook(() => useResourceSearch({ placeholder: 'Search records', clearLabel: 'Clear search', variant: 'with-clear' }))
  expect(result.current.searchProps).toMatchObject({ value: '', label: 'Search records' })
  act(() => result.current.setSearchValue('local'))
  expect(result.current.listSearchProps.searchValue).toBe('local')
  expect(result.current.searchProps.value).toBe('local')
  act(() => result.current.listSearchProps.onSearchChange('list'))
  expect(result.current.searchValue).toBe('list')
  const onChange = vi.fn()
  const controlled = renderHook(({ value }) => useResourceSearch({ value, onChange, placeholder: 'Search', clearLabel: 'Clear' }), { initialProps: { value: 'router' } })
  act(() => controlled.result.current.searchProps.onChange('next'))
  expect(onChange).toHaveBeenLastCalledWith('next')
  controlled.rerender({ value: 'back' })
  expect(controlled.result.current.listSearchProps.searchValue).toBe('back')
})

it('C7A-05 selecting cell text suppresses navigation until selection is collapsed', () => {
  const onRow = vi.fn()
  render(<DataTable rows={[{ id: 'selectable text' }]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} onRowClick={onRow} />)
  const cell = screen.getByRole('cell'); const selection = window.getSelection()!
  const range = document.createRange(); range.selectNodeContents(cell); selection.removeAllRanges(); selection.addRange(range)
  fireEvent.click(cell); expect(onRow).not.toHaveBeenCalled()
  selection.removeAllRanges(); fireEvent.click(cell); expect(onRow).toHaveBeenCalledTimes(1)
})

it('SR-59 configured columns are fixed and there is no Columns button', () => {
  render(<DataTable rows={[{ id: 'a' }]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }, { id: 'email', label: 'Email', cell: () => 'permitted@example.test' }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} onRowClick={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull()
  expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['ID', 'Email'])
})
it('initial loading never flashes empty and stale cell clicks cannot navigate', () => {
  const navigate = vi.fn()
  const props = { columns: [{ id: 'id', label: 'ID', cell: (row: { id: string }) => row.id }], state: { search: '', sort: null, limit: 30 }, onStateChange: vi.fn(), page: 0, onPage: vi.fn(), label: 'Records', labels, onRowClick: navigate }
  const view = render(<DataTable {...props} rows={[]} isFetching />)
  expect(screen.queryByText('No results')).toBeNull()
  view.rerender(<DataTable {...props} rows={[{ id: 'stale' }]} isFetching={false} pendingSearch />)
  fireEvent.click(screen.getByRole('cell')); expect(navigate).not.toHaveBeenCalled()
  view.rerender(<DataTable {...props} rows={[]} isFetching={false} error={new Error('Translated safe failure')} />)
  expect(screen.getByRole('alert').textContent).toContain('Translated safe failure')
  expect(screen.queryByText('No results')).toBeNull()
})

it('complete collection bridge uses actual page count while server cursor tables never invent a last page', async () => {
  const { CompleteDataTable } = await import('../src')
  const user = userEvent.setup()
  render(<CompleteDataTable data={Array.from({ length: 23 }, (_, id) => ({ id }))} columns={[{ accessorKey: 'id', header: 'ID' }]} label="All records" />)
  expect(screen.getAllByRole('cell')).toHaveLength(10)
  expect(screen.getByRole('link', { name: '3' })).toBeTruthy()
  await user.click(screen.getByRole('link', { name: '3' }))
  expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['20', '21', '22'])
  expect(screen.getByRole('link', { name: 'Go to next page' }).getAttribute('aria-disabled')).toBe('true')
})

it('server refresh retains focused sort headers and an open row dialog even with fresh column callbacks', async () => {
  const { RowActions } = await import('../src'); const user = userEvent.setup()
  const content = (fetching: boolean) => <DataTable rows={[{ id: 'a' }]} columns={[
    { id: 'id', label: 'ID', sortable: true, cell: row => row.id },
    { id: '_actions', label: 'Actions', cell: () => <RowActions label="Actions for a" items={[{ id: 'edit', label: 'Edit' }]}>{() => <div role="dialog">Retained session</div>}</RowActions> },
  ]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={fetching} label="Records" labels={labels} onRowClick={vi.fn()} />
  const view = render(content(false)); const sort = screen.getByRole('button', { name: 'Sort ID' })
  sort.focus(); view.rerender(content(true)); expect(document.activeElement).toBe(sort)
  view.rerender(content(false)); await user.click(screen.getByRole('button', { name: 'Actions for a' })); await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
  view.rerender(content(true)); expect(screen.getByRole('dialog').textContent).toBe('Retained session')
})
it('W44 at 390px shows the primary column and Actions without a clipped neighbour or stray dash', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as any)
  try {
    render(<DataTable rows={[{ id: 'one' }]} columns={[
      { id: 'name', label: 'Name', cell: () => 'John Doe' },
      { id: 'date', label: 'Date', cell: () => '-' },
      { id: '_actions', label: 'Actions', cell: () => <button aria-label="Row actions">⋯</button> },
    ]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} onRowClick={vi.fn()} />)
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Name', 'Actions'])
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['John Doe', '⋯'])
  } finally { vi.restoreAllMocks() }
})

it('mobile hidden columns retain keyboard sort, three accessible states and filters across refreshes', async () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as any)
  try {
    const user = userEvent.setup(); const change = vi.fn(); const filter = vi.fn()
    const content = (sort: { key: string; direction: 'asc' | 'desc' } | null, fetching = false) => <DataTable rows={[{ id: 'one' }]} columns={[
      { id: 'name', label: 'Name', cell: () => 'John Doe' },
      { id: 'date', label: 'Date', sortable: true, filter: <button onClick={filter}>Filter Date</button>, cell: () => '2026-11-05' },
      { id: '_actions', label: 'Actions', cell: () => <button>Row actions</button> },
    ]} state={{ search: '', sort, limit: 30 }} onStateChange={change} page={0} onPage={vi.fn()} isFetching={fetching} label="Records" labels={labels} onRowClick={vi.fn()} />
    const view = render(content(null))
    const disclosure = screen.getByRole('button', { name: 'Sort and filter' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    disclosure.focus(); await user.keyboard('{Enter}')
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    const sort = screen.getByRole('button', { name: 'Sort Date' })
    expect(sort.getAttribute('aria-pressed')).toBe('false')
    expect(document.getElementById(sort.getAttribute('aria-describedby')!)?.textContent).toBe('Not sorted')
    sort.focus(); await user.keyboard('{Enter}')
    expect(change.mock.lastCall).toEqual([{ search: '', sort: { key: 'date', direction: 'asc' }, limit: 30 }, 'sort'])
    view.rerender(content({ key: 'date', direction: 'asc' }, true))
    expect(document.activeElement).toBe(sort)
    expect(sort.getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById(sort.getAttribute('aria-describedby')!)?.textContent).toBe('Ascending')
    view.rerender(content({ key: 'date', direction: 'asc' }))
    await user.keyboard('{Enter}')
    expect(change.mock.lastCall![0].sort).toEqual({ key: 'date', direction: 'desc' })
    view.rerender(content({ key: 'date', direction: 'desc' }))
    expect(document.getElementById(sort.getAttribute('aria-describedby')!)?.textContent).toBe('Descending')
    await user.keyboard('{Enter}'); expect(change.mock.lastCall![0].sort).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Filter Date' })); expect(filter).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Name', 'Actions'])
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['John Doe', 'Row actions'])
    await user.click(disclosure); expect(screen.queryByRole('button', { name: 'Sort Date' })).toBeNull()
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as any)
    view.rerender(content({ key: 'date', direction: 'desc' }))
    expect(screen.queryByRole('button', { name: 'Sort and filter' })).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Date' }).getAttribute('aria-sort')).toBe('descending')
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['John Doe', '2026-11-05', 'Row actions'])
  } finally { vi.restoreAllMocks() }
})
