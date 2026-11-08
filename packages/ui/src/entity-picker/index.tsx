import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useMutationSession } from '../dialog/mutation-lifecycle'
import { Button } from '../button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Check, ChevronsUpDown, X } from 'lucide-react'
export interface PickerOption { id: string; label: string }
interface Props {
  label: string; options: PickerOption[]; value: string; onChange: (id: string) => void; placeholder: string
  remote?: boolean; selectedLabel?: string; onFocus?: () => void; onSearch?: (search: string) => void; onClose?: () => void
  loadMore?: () => void; hasMore?: boolean; loading?: boolean; loadingLabel?: string; moreLabel?: string; clearLabel?: string; emptyLabel?: string; error?: string; wizard?: ReactNode
  multiple?: { selected: PickerOption[]; onRemove: (id: string) => void; removeLabel: (option: PickerOption) => string }
}
export function EntityPicker(props: Props) {
  const id = useId(); const pending = useMutationSession()?.pending
  let empty = '__workbase_empty__'
  while (props.options.some(option => option.id === empty)) empty += '_'
  if (!props.remote) return <div className="grid gap-2"><Label htmlFor={id}>{props.label}</Label><Select disabled={pending} value={props.value || empty} onValueChange={value => props.onChange(value === empty ? '' : value)}><SelectTrigger id={id} className="w-full" aria-invalid={!!props.error} aria-describedby={props.error ? `${id}-error` : undefined}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={empty}>{props.placeholder}</SelectItem>{props.options.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent></Select>{props.error && <p id={`${id}-error`} role="alert">{props.error}</p>}</div>
  return <RemotePicker {...props} />
}
function RemotePicker({ label, options, value, selectedLabel, onChange, placeholder, onFocus, onSearch, onClose, loadMore, hasMore, loading, loadingLabel, moreLabel, clearLabel, emptyLabel, error, wizard, multiple }: Props) {
  const pending = useMutationSession()?.pending
  const id = useId(); const input = useRef<HTMLInputElement>(null); const previousValue = useRef(value); const restoringFocus = useRef(false); const [open, setOpen] = useState(false); const [search, setSearch] = useState(''); const [active, setActive] = useState(-1)
  const close = () => { if (pending) return; setOpen(false); setSearch(''); setActive(-1); onClose?.() }
  useEffect(() => {
    if (previousValue.current === value) return
    previousValue.current = value; close()
    restoringFocus.current = true; input.current?.focus(); restoringFocus.current = false
  }, [value])
  const select = (option: PickerOption) => { if (pending) return; onChange(option.id); close(); input.current?.focus() }
  return <div className="wb-picker grid gap-2"><Label htmlFor={id}>{label}</Label>
    <div data-picker-control className={multiple ? 'min-w-0 rounded-md border border-input p-2 shadow-xs focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]' : undefined}>
      {!!multiple?.selected.length && <ul className="mb-2 flex min-w-0 flex-wrap gap-1" aria-label={label}>{multiple.selected.map(option => <Badge asChild variant="secondary" key={option.id} className="max-w-full whitespace-normal text-sm"><li><span className="min-w-0 break-words [overflow-wrap:anywhere]">{option.label}</span><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" disabled={pending} aria-label={multiple.removeLabel(option)} onClick={() => { multiple.onRemove(option.id); input.current?.focus() }}><X className="size-3" aria-hidden="true" /></Button></li></Badge>)}</ul>}
      <div className="relative"><Input className={multiple ? 'h-8 border-0 pr-8 font-normal shadow-none focus-visible:ring-0' : 'pr-16 font-normal'} ref={input} disabled={pending} id={id} role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open && active >= 0 && options[active] ? `${id}-${active}` : undefined} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} value={open ? search : selectedLabel ?? ''} placeholder={placeholder}
    onFocus={() => { if (!restoringFocus.current) { setOpen(true); onFocus?.() } }} onClick={() => { if (!open) { setOpen(true); onFocus?.() } }}
    onChange={event => { if (!open) { setOpen(true); onFocus?.() }; setSearch(event.target.value); setActive(-1); onSearch?.(event.target.value) }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) { setOpen(true); onFocus?.() }; setActive(index => Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))) }
      if (event.key === 'Enter' && open) { event.preventDefault(); if (options[active]) select(options[active]) }
      if (event.key === 'Tab') close()
    }} />
    <ChevronsUpDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 opacity-50 pointer-events-none" aria-hidden="true" />
    {value && <Button type="button" variant="ghost" size="icon" className="absolute right-8 top-1/2 -translate-y-1/2 size-6" aria-label={clearLabel} disabled={pending} onClick={() => { onChange(''); close(); input.current?.focus() }}><X className="h-4 w-4 opacity-50" aria-hidden="true" /></Button>}</div></div>
    {error && <p id={`${id}-error`} role="alert">{error}</p>}
    {open && <div className="wb-picker-popup"><div id={`${id}-options`} role="listbox" aria-label={label} className="wb-picker-options" onScroll={event => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 50 && hasMore && !loading) loadMore?.() }}>
      {options.map((option, index) => <div role="option" id={`${id}-${index}`} key={option.id} aria-selected={active === index} onMouseDown={event => event.preventDefault()} onClick={() => select(option)}><Check aria-hidden="true" className={value === option.id ? "mr-2 h-4 w-4 shrink-0" : "mr-2 h-4 w-4 shrink-0 opacity-0"} />{option.label}</div>)}
    </div>{loading && <p role="status">{loadingLabel}</p>}{!loading && !options.length && <p>{emptyLabel}</p>}{hasMore && <Button type="button" variant="outline" disabled={loading || pending} onClick={loadMore}>{moreLabel}</Button>}{wizard}</div>}
  </div>
}
