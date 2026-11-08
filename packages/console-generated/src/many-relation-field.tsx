import { EntityPicker } from '@workbasehq/ui'
import { useEntityTranslation } from './entity-translation'
import { usePickerSearch } from './use-picker-search'
import { useSelectedReferences } from './use-selected-references'
import { recordLabel, type Model, type Capabilities, type ReadQuery, type Result } from './read'

export function ManyRelationField({ model, caps, orgId, entity, name, target, value, onChange, request, error }: {
  model: Model; caps: Capabilities; orgId: string; entity: string; name: string; target: string; value: string; onChange: (value: string) => void; request: (query: ReadQuery) => Promise<Result>; error?: string
}) {
  const { t, i18n } = useEntityTranslation(entity)
  const ids: string[] = value ? JSON.parse(value) : []
  const choices = usePickerSearch(model, caps, orgId, target, request)
  const { allowed, result, rows } = choices
  const selected = useSelectedReferences(model, caps, orgId, target, ids, rows, request)
  const label = (row?: Record<string, any>) => !row ? t('unavailableRecord') : recordLabel(model, target, row, caps, i18n.language, t)
  return <div className="grid gap-2">
    <EntityPicker label={t(`relation_${name}`)} placeholder={t('search', { context: target })} remote value="" options={allowed ? rows.filter(row => !ids.includes(row.id)).map(row => ({ id: row.id, label: label(row) })) : []}
      error={error} multiple={{ selected: allowed ? ids.map(id => ({ id, label: label(selected.rows.find(row => row.id === id)) })) : [], onRemove: id => onChange(JSON.stringify(ids.filter(value => value !== id))), removeLabel: option => t('removeRelation', { name: option.label }) }}
      onChange={id => { if (id) { selected.seed(rows.find(row => row.id === id)); onChange(JSON.stringify([...new Set([...ids, id])])) } }} onFocus={choices.focus} onClose={choices.close} onSearch={choices.setSearch}
      loading={choices.loading} loadingLabel={t('loading')} emptyLabel={t('noResults', { context: target })} hasMore={choices.hasMore} loadMore={choices.loadMore} moreLabel={t('loadMore')} />
    {(result.error || selected.error) && <p role="alert">{t('requestFailed')}</p>}
  </div>
}
