import { useState } from 'react'
import { Button } from '@workbasehq/ui/components/ui/button'
import { useEntityTranslation } from './entity-translation'
import { filterMapping, type FilterDescriptor, type FilterValue } from './filter-kinds'
import { emptyFilterValue, FilterInput, type FilterContext } from './header-filter'
import type { ListFilter } from './list-model'
interface Props extends FilterContext { descriptors: FilterDescriptor[]; filters: ListFilter[]; onChange: (filters: ListFilter[]) => void }
export function FilterPanel(props: Props) {
  const { t } = useEntityTranslation(props.entity)
  const [open, setOpen] = useState(false)
  const panel = props.descriptors.filter(filter => filter.placement === 'panel')
  if (!panel.length) return null
  return <details open={open} className="my-2 rounded-md border p-3">
    <summary className="cursor-pointer text-sm font-medium" onClick={event => { event.preventDefault(); setOpen(value => !value) }}>{t('sortAndFilter')}</summary>
    {open && <PanelDraft key={JSON.stringify([panel, props.filters])} {...props} descriptors={panel} close={() => setOpen(false)} />}
  </details>
}
function PanelDraft(props: Props & { close: () => void }) {
  const { t } = useEntityTranslation(props.entity)
  const mapping = (descriptor: FilterDescriptor) => filterMapping(descriptor.kind, props.model.entities[props.entity].fields[descriptor.field], undefined, descriptor.operators)
  const [draft, setDraft] = useState<Record<string, FilterValue | undefined>>(() => Object.fromEntries(props.descriptors.map(descriptor => {
    const filter = props.filters.find(filter => filter.field === descriptor.field)
    return [descriptor.field, filter ? mapping(descriptor).fromPredicate(filter.predicate) : undefined]
  })))
  const invalid = props.descriptors.some(descriptor => !emptyFilterValue(draft[descriptor.field]) && !mapping(descriptor).toPredicate(draft[descriptor.field]))
  return <form role="group" aria-label={t('sortAndFilter')} className="mt-3 grid gap-3" onSubmit={event => {
    event.preventDefault()
    if (invalid) return
    const fields = new Set(props.descriptors.map(descriptor => descriptor.field))
    props.onChange([...props.filters.filter(filter => !fields.has(filter.field)), ...props.descriptors.flatMap(descriptor => {
      const predicate = mapping(descriptor).toPredicate(draft[descriptor.field])
      return predicate ? [{ field: descriptor.field, predicate }] : []
    })])
    props.close()
  }}>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{props.descriptors.map(descriptor => <fieldset key={descriptor.field} className="min-w-0 space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{descriptor.label ?? t(`field_${descriptor.field}`)}</legend>
      <FilterInput {...props} descriptor={descriptor} value={draft[descriptor.field]} onChange={value => setDraft(old => ({ ...old, [descriptor.field]: value }))} />
    </fieldset>)}</div>
    <div className="flex gap-2"><Button type="submit" disabled={invalid}>{t('applyFilter')}</Button><Button type="button" variant="outline" onClick={props.close}>{t('cancel')}</Button><Button type="button" variant="outline" onClick={() => setDraft({})}>{t('clearAllFilters')}</Button></div>
  </form>
}
