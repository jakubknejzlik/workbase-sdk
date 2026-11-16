/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client'
import { DataTable } from '../../src/data-table/DataTable'
import en from '../../../frontend-console/src/locales/en.json'
import cs from '../../../frontend-console/src/locales/cs.json'
import '../../src/styles.css'

// Exercise the production composition, styles and Console copy without a backend.
const params = new URLSearchParams(location.search)
const language = params.get('language') ?? 'en'
const copy = language === 'cs' ? cs : en
const size = Number(params.get('size') ?? 30)
document.documentElement.lang = language
document.documentElement.style.fontSize = params.get('enlarged') === 'true' ? '32px' : '16px'

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16 }}>
    <DataTable
      rows={[{ id: 'example' }]} columns={[{ id: 'id', label: 'ID', cell: row => row.id }]}
      state={{ search: '', sort: null, limit: size }} onStateChange={() => {}}
      page={1} onPage={() => {}} nextCursor="next" isFetching={false}
      label="Records" searchAvailable={false} onRowClick={() => {}}
      labels={{
        search: copy.search, clearSearch: copy.clearSearch, noResults: copy.noResults,
        previous: copy.previousPage, next: copy.nextPage,
        previousText: copy.paginationPrevious, nextText: copy.paginationNext,
        pageSize: copy.rowsPerPage,
        pageSizeOption: count => copy.paginationSize.replace('{{count}}', String(count)),
        sort: column => column, range: (start, end) => `${start}–${end}`,
      }}
    />
  </main>,
)
