import { useState } from 'react'
import { ListFilterPanel } from '@workbasehq/ui'
import { useEntityTranslation } from './entity-translation'
import { filterMapping, type FilterDescriptor, type FilterValue } from './filter-kinds'
import { emptyFilterValue, FilterInput, type FilterContext } from './header-filter'
import type { RowAccessState } from './read'
import type { ListFilter } from './list-model'
interface Props extends FilterContext { descriptors: FilterDescriptor[]; filters: ListFilter[]; confirmedFilters?: ListFilter[]; open?: boolean; onOpenChange?: (open: boolean) => void; rowAccess?: RowAccessState; accessInput?: (value: RowAccessState | undefined, onChange: (value?: RowAccessState) => void) => React.ReactNode; onChange: (filters: ListFilter[], rowAccess?: RowAccessState) => void }
export function FilterPanel(props: Props) {
  const { t } = useEntityTranslation(props.entity)
  const [localOpen, setLocalOpen] = useState(false)
  const open = props.open ?? localOpen
  const setOpen = props.onOpenChange ?? setLocalOpen
  const panel = props.descriptors.filter(filter => filter.placement === 'panel')
  if (!panel.length && !props.accessInput) return null
  const draft = open && <PanelDraft key={JSON.stringify(panel)} {...props} descriptors={panel} close={() => setOpen(false)} />
  if (props.open !== undefined) return draft
  return <details open={open} className="my-2 rounded-md border p-3">
    <summary className="cursor-pointer text-sm font-medium" onClick={event => { event.preventDefault(); setOpen(!open) }}>{t('sortAndFilter')}</summary>
    {draft}
  </details>
}
function PanelDraft(props: Props & { close: () => void }) {
  const { t } = useEntityTranslation(props.entity)
  const mapping = (descriptor: FilterDescriptor) => filterMapping(descriptor.kind, props.model.entities[props.entity].fields[descriptor.field], undefined, descriptor.operators, props.model.timeZone)
  const [draft, setDraft] = useState<Record<string, FilterValue | undefined>>(() => Object.fromEntries(props.descriptors.map(descriptor => {
    const filter = props.filters.find(filter => filter.field === descriptor.field)
    return [descriptor.field, filter ? mapping(descriptor).fromPredicate(filter.predicate) : undefined]
  })))
  const [rowAccess, setRowAccess] = useState(props.rowAccess)
  const invalid = props.descriptors.some(descriptor => !emptyFilterValue(draft[descriptor.field]) && !mapping(descriptor).toPredicate(draft[descriptor.field]))
  return <ListFilterPanel label={t('sortAndFilter')} invalid={invalid} hint={t('filterDraftHint')} applyLabel={t('applyFilter')} cancelLabel={t('cancel')} clearLabel={t('clearAllFilters')} onCancel={props.close} onClear={() => { setDraft({}); setRowAccess(undefined) }} onApply={() => {
    if (invalid) return
    const fields = new Set(props.descriptors.map(descriptor => descriptor.field))
    props.onChange([...(props.confirmedFilters ?? props.filters).filter(filter => !fields.has(filter.field)), ...props.descriptors.flatMap(descriptor => {
      const predicate = mapping(descriptor).toPredicate(draft[descriptor.field])
      return predicate ? [{ field: descriptor.field, predicate }] : []
    })], props.accessInput ? rowAccess : props.rowAccess)
    props.close()
  }}>
    {props.descriptors.map(descriptor => <fieldset key={descriptor.field} className="min-w-0 space-y-2">
      <legend className={descriptor.kind === 'relation' ? 'sr-only' : 'text-sm font-medium'}>{descriptor.label ?? t(`field_${descriptor.field}`)}</legend>
      {/* The legend labels panel fields; keep the text operator accessible without a second label row. */}
      <FilterInput {...props} hideTextLabel descriptor={descriptor} value={draft[descriptor.field]} onChange={value => setDraft(old => ({ ...old, [descriptor.field]: value }))} />
      {!emptyFilterValue(draft[descriptor.field]) && !mapping(descriptor).toPredicate(draft[descriptor.field]) && <p role="alert" className="text-sm text-destructive">{t('filterInvalidValueRange')}</p>}
    </fieldset>)}{props.accessInput?.(rowAccess, setRowAccess)}
  </ListFilterPanel>
}
