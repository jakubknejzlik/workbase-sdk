import { useEffect, useState } from 'react'
import { useEntityTranslation } from './entity-translation'
import { DataTableFilterDropdown, TextFilter, MultiSelectFilter, RangeFilter, ToggleFilter, EntityPicker } from '@workbasehq/ui'
import { Input } from '@workbasehq/ui/components/ui/input'
import { Button } from '@workbasehq/ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@workbasehq/ui/components/ui/popover'
import { filterMapping, selectionCap, type FilterDescriptor, type FilterValue } from './filter-kinds'
import { usePickerSearch } from './use-picker-search'
import { useSelectedReferences } from './use-selected-references'
import { recordLabel, type Capabilities, type Model, type ReadQuery, type Result } from './read'
export interface FilterContext { model: Model; caps: Capabilities; orgId: string; entity: string; request: (query: ReadQuery) => Promise<Result> }
interface Props extends FilterContext { descriptor: FilterDescriptor; predicate?: Record<string, unknown>; onChange: (predicate?: Record<string, unknown>) => void }
export function HeaderFilter(props: Props) {
  const { t } = useEntityTranslation(props.entity)
  const label = props.descriptor.label ?? t(`field_${props.descriptor.field}`)
  return <DataTableFilterDropdown label={t('filterColumn', { column: label })} active={!!props.predicate} activeLabel={t('filterActive')}>{close => <FilterEditor {...props} close={close} />}</DataTableFilterDropdown>
}
/** Toolbar values apply immediately; panel values stay in PanelDraft until Apply. */
export function ToolbarFilter(props: Props) {
  const { t } = useEntityTranslation(props.entity)
  const { descriptor } = props
  const [relationOpen, setRelationOpen] = useState(false)
  const mapping = filterMapping(descriptor.kind, props.model.entities[props.entity].fields[descriptor.field], undefined, descriptor.operators, props.model.timeZone)
  const label = descriptor.label ?? t(`field_${descriptor.field}`)
  const value = props.predicate ? mapping.fromPredicate(props.predicate) : undefined
  const input = <FilterInput {...props} value={value} onChange={value => props.onChange(mapping.toPredicate(value))} />
  if (descriptor.kind === 'relation') return <Popover open={relationOpen} onOpenChange={setRelationOpen}>
    <PopoverTrigger asChild><Input type="text" readOnly onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.click() } }} role="combobox" aria-haspopup="dialog" aria-label={label} placeholder={label} value="" className="list-toolbar-filter w-32 cursor-pointer" /></PopoverTrigger>
    <PopoverContent role="dialog" aria-label={label} align="start" collisionPadding={8} className="w-72 max-w-[calc(100vw-2rem)] max-h-[min(80dvh,var(--radix-popover-content-available-height))] overflow-y-auto"><RelationFilterInput {...props} target={props.model.entities[props.entity].fields[descriptor.field].entity!} value={value} compact onChange={value => { props.onChange(mapping.toPredicate(value)); setRelationOpen(false) }} /></PopoverContent>
  </Popover>
  if (descriptor.kind === 'enum') return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="outline" className="list-toolbar-filter w-32" aria-label={label} aria-description={props.predicate ? t('filterActive') : undefined}>
      <span className="min-w-0 truncate" title={label}>{label}</span>{Array.isArray(value) && value.length > 0 && <span aria-hidden="true" className="shrink-0 whitespace-nowrap tabular-nums">({value.length})</span>}
      <svg aria-hidden="true" className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
    </Button></PopoverTrigger>
    <PopoverContent role="dialog" aria-label={label} align="start" collisionPadding={8} className="w-64 max-w-[calc(100vw-2rem)] max-h-[min(80dvh,var(--radix-popover-content-available-height))] overflow-y-auto">{input}</PopoverContent>
  </Popover>
  return <fieldset className="list-toolbar-filter min-w-40 space-y-1 text-sm [&_.wb-picker>label]:sr-only">
    <legend className="px-1">{descriptor.label ?? t(`field_${descriptor.field}`)}</legend>
    {input}
  </fieldset>
}
function FilterEditor(props: Props & { close: () => void }) {
  const { t } = useEntityTranslation(props.entity)
  const { field, kind, operators } = props.descriptor
  const mapping = filterMapping(kind, props.model.entities[props.entity].fields[field], undefined, operators, props.model.timeZone)
  const [value, setValue] = useState<FilterValue | undefined>(() => props.predicate ? mapping.fromPredicate(props.predicate) : undefined)
  const predicate = mapping.toPredicate(value)
  return <form className="grid gap-3" onSubmit={event => { event.preventDefault(); props.onChange(predicate); props.close() }}>
    <FilterInput {...props} value={value} onChange={setValue} />
    <div className="flex gap-2"><Button type="submit" disabled={!emptyFilterValue(value) && !predicate}>{t('applyFilter')}</Button><Button type="button" variant="outline" onClick={() => { props.onChange(undefined); props.close() }}>{t('clearFilter')}</Button></div>
  </form>
}
export const emptyFilterValue = (value: FilterValue | undefined) => value === undefined || value === '' || Array.isArray(value) && !value.length || typeof value === 'object' && !Array.isArray(value) && !Object.values(value).some(Boolean)
/** Controlled inputs shared by headers, toolbar and the panel's uncommitted draft. */
export function FilterInput(props: FilterContext & { descriptor: FilterDescriptor; hideTextLabel?: boolean; value?: FilterValue; onChange: (value?: FilterValue) => void }) {
  const { t, i18n } = useEntityTranslation(props.entity)
  const { kind, field } = props.descriptor
  const spec = props.model.entities[props.entity].fields[field]
  const value = props.value, setValue = props.onChange
  const capLabel = t('filterCap', { count: selectionCap })
  if (kind === 'text') return <TextFilter description={t((!spec || spec.type === 'ref') ? 'filterCaseInsensitive' : 'filterCaseSensitive')} label={props.hideTextLabel ? <span className="sr-only">{t('filterContains')}</span> : t('filterContains')} value={typeof value === 'string' ? value : ''} onChange={setValue} />
  if (kind === 'enum') return <MultiSelectFilter options={(spec.values ?? []).map(id => ({ id, label: t(`value_${id}`, { defaultValue: id }) }))} value={Array.isArray(value) ? value : []} onChange={setValue} capLabel={capLabel} />
  if (kind === 'relation') return <RelationFilterInput {...props} target={spec.entity!} />
  if (kind === 'number' || kind === 'date') {
    const operators = props.descriptor.operators
    const range = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return <RangeFilter operators={operators} localDay={kind === 'date' && spec.type === 'datetime'} lowerBoundOnly={operators?.length === 1 && operators[0] === 'gte'} locale={i18n.language} calendarLabel={t('selectDateRange')} type={kind === 'date' ? 'date' : 'number'} value={range} onChange={setValue} labels={{ single: t('filterSingle'), from: t('filterFrom'), to: t('filterTo'), operator: t('filterOperator'), equals: t('filterEquals'), between: t('filterBetween') }} />
  }
  return <ToggleFilter value={typeof value === 'boolean' ? value : undefined} onChange={setValue} labels={{ label: t('filterValue'), all: t('filterAll'), yes: t('yes'), no: t('no') }} />
}
/** Read-only adapter: reuse authorized search/pages/ID hydration, always use the model label. */
function RelationFilterInput(props: FilterContext & { descriptor: FilterDescriptor; target: string; compact?: boolean; value?: FilterValue; onChange: (value?: FilterValue) => void }) {
  const { t, i18n } = useEntityTranslation(props.entity)
  const { model, caps, orgId, target, request, descriptor } = props
  const label = descriptor.label ?? t(`field_${descriptor.field}`)
  const choices = usePickerSearch(model, caps, orgId, target, request)
  const values = Array.isArray(props.value) ? props.value : []
  const selected = useSelectedReferences(model, caps, orgId, target, values, request)
  const [pickerValue, setPickerValue] = useState('')
  const name = (row: Record<string, any>) => recordLabel(model, target, row, caps, i18n.language, t)
  useEffect(() => { if (props.compact) choices.focus() }, [props.compact])
  if (!choices.allowed || !caps.entities[props.entity]?.readable.includes(descriptor.field)) return null
  if (props.compact) return <div className="grid min-w-0 gap-2">
    <Input type="search" aria-label={label} placeholder={label} value={choices.search} onChange={event => choices.setSearch(event.target.value)} />
    {(choices.result.error || selected.error) && <p role="alert">{t('requestFailed')}</p>}
    <div role="listbox" aria-label={label} aria-multiselectable="true" className="grid gap-1" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
      const index = options.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      event.preventDefault(); options[next]?.focus()
    }}>
      {[...new Set([...values, ...choices.rows.map(row => row.id)])].map(id => { const row = [...selected.rows, ...choices.rows].find(row => row.id === id); return <button key={id} type="button" role="option" aria-selected={values.includes(id)} disabled={!values.includes(id) && values.length >= selectionCap} className="flex min-h-9 min-w-0 items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted disabled:opacity-50" onClick={() => {
        selected.seed(row); props.onChange(values.includes(id) ? values.filter(value => value !== id) : [...values, id])
      }}><span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded border">{values.includes(id) ? '✓' : ''}</span><span className="min-w-0 break-words">{row ? name(row) : t('unavailableRecord')}</span></button> })}
    </div>
    {choices.loading && <p role="status">{t('loading')}</p>}
    {!choices.loading && !choices.rows.length && <p>{t('noResults')}</p>}
    {choices.hasMore && <Button type="button" variant="outline" disabled={choices.loading} onClick={choices.loadMore}>{t('loadMore')}</Button>}
    {values.length >= selectionCap && <p role="status">{t('filterCap', { count: selectionCap })}</p>}
    {values.length > 0 && <Button type="button" variant="outline" onClick={() => props.onChange([])}>{t('clearFilter')}</Button>}
  </div>
  return <div className="grid gap-2">
    {(choices.result.error || selected.error) && <p role="alert">{t('requestFailed')}</p>}
    {values.length > 0 && <MultiSelectFilter options={values.map(id => { const row = selected.rows.find(row => row.id === id); return { id, label: row ? name(row) : t('unavailableRecord') } })} value={values} onChange={props.onChange} capLabel={t('filterCap', { count: selectionCap })} />}
    {values.length < selectionCap && <EntityPicker remote label={label} placeholder={label} options={choices.rows.map(row => ({ id: row.id, label: name(row) }))} value={pickerValue} selectedLabel="" onChange={id => {
      if (id && !values.includes(id)) { selected.seed(choices.rows.find(row => row.id === id)); props.onChange([...values, id]); setPickerValue(id) }
    }} onFocus={choices.focus} onSearch={choices.setSearch} onClose={choices.close} loading={choices.loading} hasMore={choices.hasMore} loadMore={choices.loadMore} loadingLabel={t('loading')} moreLabel={t('loadMore')} clearLabel={t('clearRelation')} emptyLabel={t('noResults')} />}
    {values.length > 0 && <Button type="button" variant="outline" onClick={() => { props.onChange([]); setPickerValue('') }}>{t('clearFilter')}</Button>}
  </div>
}
