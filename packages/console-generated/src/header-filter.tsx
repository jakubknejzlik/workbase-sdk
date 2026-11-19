import { useState } from 'react'
import { useEntityTranslation } from './entity-translation'
import { DataTableFilterDropdown, TextFilter, MultiSelectFilter, RangeFilter, ToggleFilter, EntityPicker } from '@workbasehq/ui'
import { Button } from '@workbasehq/ui/components/ui/button'
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
  const mapping = filterMapping(descriptor.kind, props.model.entities[props.entity].fields[descriptor.field], undefined, descriptor.operators)
  return <fieldset className="min-w-40 space-y-1 text-sm [&_.wb-picker>label]:sr-only">
    <legend className={descriptor.kind === 'relation' ? 'sr-only' : 'px-1'}>{descriptor.label ?? t(`field_${descriptor.field}`)}</legend>
    <FilterInput {...props} value={props.predicate ? mapping.fromPredicate(props.predicate) : undefined} onChange={value => props.onChange(mapping.toPredicate(value))} />
  </fieldset>
}
function FilterEditor(props: Props & { close: () => void }) {
  const { t } = useEntityTranslation(props.entity)
  const { field, kind, operators } = props.descriptor
  const mapping = filterMapping(kind, props.model.entities[props.entity].fields[field], undefined, operators)
  const [value, setValue] = useState<FilterValue | undefined>(() => props.predicate ? mapping.fromPredicate(props.predicate) : undefined)
  const predicate = mapping.toPredicate(value)
  return <form className="grid gap-3" onSubmit={event => { event.preventDefault(); props.onChange(predicate); props.close() }}>
    <FilterInput {...props} value={value} onChange={setValue} />
    <div className="flex gap-2"><Button type="submit" disabled={!emptyFilterValue(value) && !predicate}>{t('applyFilter')}</Button><Button type="button" variant="outline" onClick={() => { props.onChange(undefined); props.close() }}>{t('clearFilter')}</Button></div>
  </form>
}
export const emptyFilterValue = (value: FilterValue | undefined) => value === undefined || value === '' || Array.isArray(value) && !value.length || typeof value === 'object' && !Array.isArray(value) && !Object.values(value).some(Boolean)
/** Controlled inputs shared by headers, toolbar and the panel's uncommitted draft. */
export function FilterInput(props: FilterContext & { descriptor: FilterDescriptor; value?: FilterValue; onChange: (value?: FilterValue) => void }) {
  const { t, i18n } = useEntityTranslation(props.entity)
  const { kind, field } = props.descriptor
  const spec = props.model.entities[props.entity].fields[field]
  const value = props.value, setValue = props.onChange
  const capLabel = t('filterCap', { count: selectionCap })
  if (kind === 'text') return <TextFilter description={t((!spec || spec.type === 'ref') ? 'filterCaseInsensitive' : 'filterCaseSensitive')} label={t('filterContains')} value={typeof value === 'string' ? value : ''} onChange={setValue} />
  if (kind === 'enum') return <MultiSelectFilter options={(spec.values ?? []).map(id => ({ id, label: t(`value_${id}`, { defaultValue: id }) }))} value={Array.isArray(value) ? value : []} onChange={setValue} capLabel={capLabel} />
  if (kind === 'relation') return <RelationFilterInput {...props} target={spec.entity!} />
  if (kind === 'number' || kind === 'date') {
    const operators = props.descriptor.operators
    const range = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return <RangeFilter lowerBoundOnly={operators?.length === 1 && operators[0] === 'gte'} locale={i18n.language} calendarLabel={t('selectDateRange')} type={kind === 'date' ? 'date' : 'number'} value={range} onChange={setValue} labels={{ single: t('filterSingle'), from: t('filterFrom'), to: t('filterTo') }} />
  }
  return <ToggleFilter value={typeof value === 'boolean' ? value : undefined} onChange={setValue} labels={{ label: t('filterValue'), all: t('filterAll'), yes: t('yes'), no: t('no') }} />
}
/** Read-only adapter: reuse authorized search/pages/ID hydration, always use the model label. */
function RelationFilterInput(props: FilterContext & { descriptor: FilterDescriptor; target: string; value?: FilterValue; onChange: (value?: FilterValue) => void }) {
  const { t, i18n } = useEntityTranslation(props.entity)
  const { model, caps, orgId, target, request, descriptor } = props
  const choices = usePickerSearch(model, caps, orgId, target, request)
  const values = Array.isArray(props.value) ? props.value : []
  const selected = useSelectedReferences(model, caps, orgId, target, values, request)
  const [pickerValue, setPickerValue] = useState('')
  const name = (row: Record<string, any>) => recordLabel(model, target, row, caps, i18n.language, t)
  if (!choices.allowed || !caps.entities[props.entity]?.readable.includes(descriptor.field)) return null
  return <div className="grid gap-2">
    {(choices.result.error || selected.error) && <p role="alert">{t('requestFailed')}</p>}
    {values.length > 0 && <MultiSelectFilter options={values.map(id => { const row = selected.rows.find(row => row.id === id); return { id, label: row ? name(row) : t('unavailableRecord') } })} value={values} onChange={props.onChange} capLabel={t('filterCap', { count: selectionCap })} />}
    {values.length < selectionCap && <EntityPicker remote label={descriptor.label ?? t(`field_${descriptor.field}`)} placeholder={t('chooseRelation', { context: descriptor.field })} options={choices.rows.map(row => ({ id: row.id, label: name(row) }))} value={pickerValue} selectedLabel="" onChange={id => {
      if (id && !values.includes(id)) { selected.seed(choices.rows.find(row => row.id === id)); props.onChange([...values, id]); setPickerValue(id) }
    }} onFocus={choices.focus} onSearch={choices.setSearch} onClose={choices.close} loading={choices.loading} hasMore={choices.hasMore} loadMore={choices.loadMore} loadingLabel={t('loading')} moreLabel={t('loadMore')} clearLabel={t('clearRelation')} emptyLabel={t('noResults')} />}
    {values.length > 0 && <Button type="button" variant="outline" onClick={() => { props.onChange([]); setPickerValue('') }}>{t('clearFilter')}</Button>}
  </div>
}
