import { useEffect, useRef, useState } from 'react'
import { DataTableSearch as SourceSearch } from '../vendor/tiketo/components/data-table/DataTableSearch'
function useDebouncedSearch(value: string, onChange: (value: string) => void) {
  const [searchValue, setLocal] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const callback = useRef(onChange); callback.current = onChange
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined }
  useEffect(() => {
    const restore = () => { cancel(); setLocal(value) }
    restore(); window.addEventListener('popstate', restore)
    return () => { cancel(); window.removeEventListener('popstate', restore) }
  }, [value])
  const setSearchValue = (next: string) => { setLocal(next); cancel(); timer.current = setTimeout(() => callback.current(next), 500) }
  const clear = () => { cancel(); setLocal(''); callback.current('') }
  return { searchValue, setSearchValue, clear }
}
export interface DataTableSearchProps {
  value: string; onChange: (value: string) => void; label: string; clearLabel: string; onPendingChange?: (pending: boolean) => void
  description?: string; placeholder?: string; variant?: 'default' | 'with-clear'
}
export interface ResourceSearchOptions {
  placeholder?: string; variant?: DataTableSearchProps['variant']; label?: string; clearLabel?: string; description?: string
  /** Optional adaptation for router-owned committed search. The input owns only its pending debounce. */
  value?: string; onChange?: (value: string) => void
}
/** Fleet composition contract: one committed value feeds both header and list props. */
export function useResourceSearch(options: ResourceSearchOptions = {}) {
  const [local, setLocal] = useState('')
  const searchValue = options.value ?? local
  const setSearchValue = (value: string) => {
    if (options.value === undefined) setLocal(value)
    options.onChange?.(value)
  }
  const searchProps: DataTableSearchProps = { value: searchValue, onChange: setSearchValue,
    label: options.label ?? options.placeholder ?? '', clearLabel: options.clearLabel ?? '',
    placeholder: options.placeholder, variant: options.variant, description: options.description }
  return { searchValue, setSearchValue, searchProps, listSearchProps: { searchValue, onSearchChange: setSearchValue } }
}
export function DataTableSearch({ value, onChange, label, clearLabel, description, placeholder, variant, onPendingChange }: DataTableSearchProps) {
  const { searchValue, setSearchValue, clear } = useDebouncedSearch(value, onChange)
  useEffect(() => { onPendingChange?.(searchValue !== value) }, [searchValue, value, onPendingChange])
  return <SourceSearch value={searchValue} onChange={next => next ? setSearchValue(next) : clear()} label={label} clearLabel={clearLabel} description={description} placeholder={placeholder ?? label} variant={variant ?? 'with-clear'} className="w-full sm:w-51" />
}
