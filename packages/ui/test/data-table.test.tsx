import { act, render, renderHook, screen, fireEvent, within } from '@testing-library/react'
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
  expect(change).toHaveBeenCalledTimes(1)
  view.rerender(<DataTable {...props} isFetching />)
  expect(screen.getByRole('status').textContent).toBe('31–31')
  expect(screen.getByRole('cell').textContent).toBe('a')
  expect(screen.getByRole('button', { name: labels.next }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: labels.pageSize }).hasAttribute('disabled')).toBe(true)
  expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  expect(screen.getByTestId('data-table-loading')).toBeTruthy()
  expect(createDataTableQueryKey('records', 'org')).toEqual(['data-table', 'records', 'org'])
})
it('page size supports keyboard selection and commits one limit change', async () => {
  const change = vi.fn(); const user = userEvent.setup()
  render(<DataTable rows={[{ id: 'a' }]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]} state={{ search: '', sort: null, limit: 30 }} onStateChange={change} page={1} onPage={vi.fn()} nextCursor="opaque" isFetching={false} label="Records" labels={labels} onRowClick={vi.fn()} />)
  screen.getByRole('combobox', { name: labels.pageSize }).focus()
  await user.keyboard('{Enter}')
  await screen.findByRole('option', { name: '30' })
  await user.keyboard('{ArrowDown}{Enter}')
  expect(change).toHaveBeenCalledTimes(1)
  expect(change).toHaveBeenCalledWith({ search: '', sort: null, limit: 50 }, 'limit')
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

it('empty feedback and its clear action are outside the horizontal table scroller', () => {
  const clear = vi.fn()
  render(<DataTable rows={[]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]} state={{ search: 'missing', sort: null, limit: 10 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} onRowClick={vi.fn()} onClearFilters={clear} clearFilters="Clear filters" />)
  expect(screen.getByText(labels.noResults).closest('[data-slot="table-container"]')).toBeNull()
  const button = screen.getByRole('button', { name: 'Clear filters' })
  expect(button.closest('table')).toBeNull()
  fireEvent.click(button); expect(clear).toHaveBeenCalledTimes(1)
})

it('error recovery explains preserved settings once and retries without changing table state or page', () => {
  const retry = vi.fn(); const change = vi.fn(); const page = vi.fn()
  const state = { search: 'kept', sort: { key: 'id', direction: 'desc' as const }, limit: 10 }
  const props = { columns: [{ id: 'id', label: 'ID', cell: (row: { id: string }) => row.id }], state, onStateChange: change, page: 2, onPage: page, label: 'Records', labels: { ...labels, error: 'Cannot load records', errorDescription: 'Your settings are preserved.', retry: 'Try again' }, onRetry: retry, onRowClick: vi.fn() }
  const error = new Error('Cannot load records')
  const view = render(<DataTable {...props} rows={[]} isFetching={false} error={error} />)
  const alert = screen.getByRole('alert')
  expect(alert.closest('[data-slot="table-container"]')).toBeNull()
  expect(screen.getAllByText('Cannot load records')).toHaveLength(1)
  expect(alert.textContent).toContain('Your settings are preserved.')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(retry).toHaveBeenCalledTimes(1); expect(change).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled()
  view.rerender(<DataTable {...props} rows={[]} isFetching error={error} />)
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull(); expect(screen.queryByText(labels.noResults)).toBeNull()
  view.rerender(<DataTable {...props} rows={[{ id: 'recovered' }]} isFetching={false} />)
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('cell').textContent).toBe('recovered')
  expect(screen.getByRole('searchbox').getAttribute('value')).toBe('kept')
  expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('descending')
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
    const disclosure = screen.getByRole('button', { name: 'Filters' })
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
    expect(screen.queryByRole('button', { name: 'Filters' })).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Date' }).getAttribute('aria-sort')).toBe('descending')
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['John Doe', '2026-11-05', 'Row actions'])
  } finally { vi.restoreAllMocks() }
})

it('178 narrow tables retain opted-in state and identity alongside row actions', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as any)
  try {
    render(<DataTable rows={[{ id: 'one' }]} columns={[
      { id: 'name', label: 'Name', cell: () => 'Jana' },
      { id: 'date', label: 'Date', cell: () => '2026-11-17' },
      { id: 'access', label: 'Application access', keepOnNarrow: true, wrap: true, cell: () => <div>Invited <span>jana@example.test</span><button>Access actions</button></div> },
      { id: '_actions', label: 'Actions', cell: () => <button>Row actions</button> },
    ]} state={{ search: '', sort: null, limit: 30 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={labels} onRowClick={vi.fn()} />)
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Name', 'Application access', 'Actions'])
    expect(screen.getByText('jana@example.test')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Access actions' })).toBeTruthy()
    expect(screen.queryByText('2026-11-17')).toBeNull()
  } finally { vi.restoreAllMocks() }
})

it('A3 overflow hint precedes the table, describes its region and disappears when columns fit', () => {
  let resize = () => {}
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  try {
    render(<DataTable listV2 hideFooter onRowClick={vi.fn()} rows={[{ id: 'one' }]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]} state={{ search: '', sort: null, limit: 10 }} onStateChange={vi.fn()} page={0} onPage={vi.fn()} isFetching={false} label="Records" labels={{ ...labels, scrollRegion: 'Scrollable records', scrollHint: 'Scroll for more columns' }} />)
    const region = screen.getByRole('region', { name: 'Scrollable records' })
    Object.defineProperties(region, { clientWidth: { configurable: true, value: 300 }, scrollWidth: { configurable: true, value: 900 } })
    act(resize)
    const hint = screen.getByText('Scroll for more columns', { exact: false })
    expect(hint.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(region.getAttribute('aria-describedby')).toBe(hint.id)
    expect(document.querySelectorAll('[data-list-overflow]')).toHaveLength(1)
    fireEvent.keyDown(region, { key: 'End' })
    expect(region.scrollLeft).toBe(900)
    expect(hint.getAttribute('data-list-overflow')).toBe('start')
    Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 300 })
    act(resize)
    expect(document.querySelector('[data-list-overflow]')).toBeNull()
    expect(region.hasAttribute('aria-describedby')).toBe(false)
  } finally { vi.unstubAllGlobals() }
})
it('A3 footer preserves direct page jumps, exact totals, maxOffset and busy/unknown guards', async () => {
  const { ListPageFooter } = await import('../src')
  const onPage = vi.fn(), onPageSize = vi.fn(), user = userEvent.setup()
  const props = { total: 47, page: 0, limit: 10, pageSize: 10, maxOffset: 20, busy: false, labels: { ...labels, range: (start: number, end: number, total: number) => `${start}–${end} of ${total}` }, onPage, onPageSize }
  const view = render(<ListPageFooter {...props} />)
  expect(screen.getByRole('status').textContent).toBe('1–10 of 47')
  expect(document.querySelector('[data-list-page-counter]')?.textContent).toBe('1 / 3')
  expect(screen.getByRole('button', { name: labels.previous }).hasAttribute('disabled')).toBe(true)
  screen.getByRole('button', { name: '3' }).focus(); await user.keyboard('{Enter}')
  expect(onPage).toHaveBeenLastCalledWith(2)
  view.rerender(<ListPageFooter {...props} page={2} />)
  expect(screen.getByRole('button', { name: labels.next }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('status').textContent).toBe('21–30 of 47')
  await user.selectOptions(screen.getByRole('combobox'), '20'); expect(onPageSize).toHaveBeenCalledWith(20)
  view.rerender(<ListPageFooter {...props} busy />)
  expect([...document.querySelectorAll('button,select')].every(node => (node as HTMLButtonElement).disabled)).toBe(true)
  view.rerender(<ListPageFooter {...props} total={undefined} />)
  expect(screen.queryByRole('status')).toBeNull(); expect(document.querySelector('[data-list-page-counter]')).toBeNull()
})


const feedbackProps = {
  rows: [] as { id: string }[], columns: [{ id: 'id', label: 'ID', cell: (row: { id: string }) => row.id }],
  state: { search: '', sort: null, limit: 10 }, onStateChange: vi.fn(), page: 0, onPage: vi.fn(),
  isFetching: false, label: 'Records', labels, onRowClick: vi.fn(),
}
it('s1 omitted empty composition preserves defaults and explicit null suppresses them', () => {
  const clear = vi.fn()
  const view = render(<DataTable {...feedbackProps} listV2 labels={{ ...labels, emptyDescription: 'No records in this view.' }} onClearFilters={clear} clearFilters="Clear filters" />)
  expect(screen.getByRole('heading', { name: labels.noResults }).tagName).toBe('H2')
  expect(screen.getByText('No records in this view.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })); expect(clear).toHaveBeenCalledOnce()
  view.rerender(<DataTable {...feedbackProps} emptyContent={null} onClearFilters={clear} clearFilters="Clear filters" />)
  expect(screen.queryByText(labels.noResults)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
})
it('s1 custom feedback replaces defaults outside the scroller and the host removes its action', () => {
  const create = vi.fn()
  const view = render(<DataTable {...feedbackProps} listV2 emptyContent={<><h2>No records in this view</h2><button onClick={create}>Create record</button></>} />)
  const action = screen.getByRole('button', { name: 'Create record' })
  expect(action.closest('[data-slot="table-container"]')).toBeNull()
  expect(screen.queryByText(labels.noResults)).toBeNull()
  fireEvent.click(action); expect(create).toHaveBeenCalledOnce()
  view.rerender(<DataTable {...feedbackProps} listV2 emptyContent={<h2>No records in this view</h2>} />)
  expect(screen.queryByRole('button', { name: 'Create record' })).toBeNull()
  expect(screen.getAllByText('No records in this view')).toHaveLength(1)
})
it('s1 pending, failure and populated states suppress the custom empty action', () => {
  const emptyContent = <button>Create record</button>
  const view = render(<DataTable {...feedbackProps} emptyContent={emptyContent} isFetching />)
  expect(screen.queryByRole('button', { name: 'Create record' })).toBeNull()
  view.rerender(<DataTable {...feedbackProps} emptyContent={emptyContent} error={new Error('Safe translated failure')} />)
  expect(screen.queryByRole('button', { name: 'Create record' })).toBeNull()
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  view.rerender(<DataTable {...feedbackProps} emptyContent={emptyContent} rows={[{ id: 'returned' }]} />)
  expect(screen.queryByRole('button', { name: 'Create record' })).toBeNull()
  expect(screen.getByRole('cell').textContent).toBe('returned')
})
it('s1 mobile cards share exclusive feedback, retry and host action suppression', () => {
  const retry = vi.fn(), change = vi.fn(), page = vi.fn()
  const props = { ...feedbackProps, mobileCards: true, onStateChange: change, onPage: page, onRetry: retry,
    labels: { ...labels, error: 'Cannot load records', errorDescription: 'Your settings are preserved.', retry: 'Try again' },
    emptyContent: <><h2>No records in this view</h2><button>Create record</button></>,
  }
  const view = render(<DataTable {...props} />)
  const cards = () => within(view.container.querySelector('.md\\:hidden[aria-busy]') as HTMLElement)
  expect(cards().getAllByRole('button', { name: 'Create record' })).toHaveLength(1)
  // The shared renderer adds no extra live region around caller feedback.
  expect(cards().queryAllByRole('status')).toHaveLength(0)
  view.rerender(<DataTable {...props} isFetching error={new Error('Cannot load records')} />)
  expect(cards().queryByText('No records in this view')).toBeNull()
  expect(cards().queryByRole('alert')).toBeNull()
  expect(cards().queryByRole('button', { name: 'Try again' })).toBeNull()
  view.rerender(<DataTable {...props} error={new Error('Cannot load records')} />)
  expect(cards().queryByText('No records in this view')).toBeNull()
  const alert = cards().getByRole('alert')
  expect(cards().getAllByText('Cannot load records')).toHaveLength(1)
  expect(alert.textContent).toContain('Your settings are preserved.')
  fireEvent.click(cards().getByRole('button', { name: 'Try again' }))
  expect(retry).toHaveBeenCalledOnce(); expect(change).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled()
  view.rerender(<DataTable {...props} emptyContent={<h2>No records in this view</h2>} />)
  expect(cards().queryByRole('alert')).toBeNull()
  expect(cards().queryByRole('button', { name: 'Create record' })).toBeNull()
  expect(cards().getAllByText('No records in this view')).toHaveLength(1)
  view.rerender(<DataTable {...props} rows={[{ id: 'returned' }]} />)
  expect(cards().queryByText('No records in this view')).toBeNull()
  expect(cards().getByText('returned')).toBeTruthy()
})
