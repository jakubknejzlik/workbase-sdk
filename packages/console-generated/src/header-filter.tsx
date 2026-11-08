import { useState } from 'react'
import { useEntityTranslation } from './entity-translation'
import { DataTableFilterDropdown, TextFilter, MultiSelectFilter, RangeFilter, ToggleFilter } from '@workbasehq/ui'
import { Button } from '@workbasehq/ui/components/ui/button'
import { filterKind, filterMapping, selectionCap, type FilterValue } from './filter-kinds'
import { useRelationLabels } from './useGeneratedList'
import { RelationPicker } from './write-screens'
import { recordLabel, type Capabilities, type Model, type ReadQuery, type Result } from './read'
interface Props { model: Model; caps: Capabilities; orgId: string; entity: string; field: string; predicate?: Record<string, unknown>; request: (query: ReadQuery) => Promise<Result>; onChange: (predicate?: Record<string, unknown>) => void }
export function HeaderFilter(props: Props) {
  const { t } = useEntityTranslation(props.entity); const kind = filterKind(props.model, props.entity, props.field, props.caps)
  if (!kind) return null
  return <DataTableFilterDropdown label={t('filterColumn', { column: t(`field_${props.field}`) })} active={!!props.predicate} activeLabel={t('filterActive')}>{close => <FilterEditor {...props} close={close} />}</DataTableFilterDropdown>
}
function FilterEditor(props: Props & { close: () => void }) {
  const { t, i18n } = useEntityTranslation(props.entity); const spec = props.model.entities[props.entity].fields[props.field]
  const kind = filterKind(props.model, props.entity, props.field, props.caps)!
  const mapping = filterMapping(kind, spec)
  const [value, setValue] = useState<FilterValue | undefined>(() => props.predicate ? mapping.fromPredicate(props.predicate) : undefined)
  const [pickerValue, setPickerValue] = useState('')
  const values = Array.isArray(value) ? value : []
  const selected = useRelationLabels(props.model, props.entity, props.caps, props.orgId, kind === 'relation' ? [props.field] : [], values.map(id => ({ [props.field]: id })), props.request)
  const capLabel = t('filterCap', { count: selectionCap })
  const predicate = mapping.toPredicate(value)
  return <form className="grid gap-3" onSubmit={event => { event.preventDefault(); props.onChange(predicate); props.close() }}>
    {kind === 'text' && <TextFilter description={t((!spec || spec.type === 'ref') ? 'filterCaseInsensitive' : 'filterCaseSensitive')} label={t('filterContains')} value={typeof value === 'string' ? value : ''} onChange={setValue} />}
    {kind === 'enum' && <MultiSelectFilter options={(spec.values ?? []).map(id => ({ id, label: t(`value_${id}`, { defaultValue: id }) }))} value={values} onChange={setValue} capLabel={capLabel} />}
    {kind === 'relation' && <>
      <p className="text-sm">{t('filterSelected', { count: values.length })}</p>
      {values.length > 0 && <MultiSelectFilter options={values.map(id => { const record = selected(props.field, id); return { id, label: record ? recordLabel(props.model, record.entity, record.row, props.caps, i18n.language, t) : t('unavailableRecord') } })} value={values} onChange={setValue} capLabel={capLabel} />}
      {values.length < selectionCap && <RelationPicker {...props} allowCreate={false} target={spec.entity!} value={pickerValue} onChange={id => { if (id && !values.includes(id)) { setValue([...values, id]); setPickerValue(id) } }} write={async () => { throw new Error('read_only_picker') }} />}
      {values.length > 0 && <Button type="button" variant="outline" onClick={() => { setValue([]); setPickerValue('') }}>{t('clearFilter')}</Button>}
    </>}
    {(kind === 'number' || kind === 'date') && <RangeFilter locale={i18n.language} calendarLabel={t('selectDateRange')} type={kind === 'date' ? 'date' : 'number'} value={value && typeof value === 'object' && !Array.isArray(value) ? value : {}} onChange={setValue} labels={{ single: t('filterSingle'), from: t('filterFrom'), to: t('filterTo') }} />}
    {kind === 'boolean' && <ToggleFilter value={typeof value === 'boolean' ? value : undefined} onChange={setValue} labels={{ label: t('filterValue'), all: t('filterAll'), yes: t('yes'), no: t('no') }} />}
    <div className="flex gap-2"><Button type="submit" disabled={value !== undefined && value !== '' && !(Array.isArray(value) && !value.length) && !predicate}>{t('applyFilter')}</Button><Button type="button" variant="outline" onClick={() => { props.onChange(undefined); props.close() }}>{t('clearFilter')}</Button></div>
  </form>
}
