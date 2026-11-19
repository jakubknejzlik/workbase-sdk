import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { ListColumn, ListTone } from '../../core/src/list-contract'
import type { Model, Capabilities } from './read'
import { formatValue, recordLabel, shortRecordId } from './labels'
import { useEntityTranslation } from './entity-translation'
import { listLabelEntity, readableListField, readableListLabel } from './list-presentation'
const tones: Record<ListTone, string> = {
  neutral: 'bg-muted text-foreground', positive: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100', negative: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100',
}
/** Shared by table, mobile cards and embedded generated lists. No cell hydration. */
export function GeneratedListCell({ model, entity, caps, row, column, orgId, primary, signed }: {
  model: Model; entity: string; caps: Capabilities; row: Record<string, any>; column: ListColumn; orgId: string; primary: boolean
  signed: (row: Record<string, any>, field: import('./read').Field, value: ReactNode, locale: string) => ReactNode
}) {
  const { t, i18n } = useEntityTranslation(entity)
  const [feedback, setFeedback] = useState<string>()
  const definition = model.entities[entity]; const field = column.field; const cell = column.cell
  const value = (field: string, secondary = false): ReactNode => {
    const spec = definition.fields[field]
    const reference = !!definition.list?.relatedColumns?.[field] || spec?.type === 'ref'
    if (!readableListField(model, entity, caps, field) || secondary && reference && !readableListLabel(model, entity, caps, field)) return null
    if (reference) {
      const target = row.__labels?.[field]
      if (target?.status === 'empty' || spec?.type === 'ref' && row[field] == null) return secondary ? null : '—'
      if (target?.status !== 'ok' || target.entity !== listLabelEntity(model, entity, field) || !readableListLabel(model, entity, caps, field)) return t('unavailableRecord')
      const display = caps.entities[target.entity]?.displayField ?? model.entities[target.entity].displayField
      if (!display || target.row?.[display] == null) return t('unavailableRecord')
      const label = recordLabel(model, target.entity, target.row, caps, i18n.language, t)
      return !primary && !secondary ? <Link to="/o/$orgId/e/$entity/$id" params={{ orgId, entity: target.entity, id: String(target.row.id) }}>{label}</Link> : label
    }
    if (row[field] == null) return secondary ? null : '—'
    if (!secondary && cell?.kind === 'identifier') return <span className="font-mono tabular-nums [overflow-wrap:anywhere]">{String(row[field])}</span>
    if (!secondary && cell?.kind === 'badge') {
      const configured = cell.tones?.[String(row[field])]
      const tone = configured && Object.hasOwn(tones, configured) ? configured : 'neutral'
      return <span data-list-badge="" data-tone={tone} className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{t(`value_${row[field]}`, { defaultValue: String(row[field]) })}</span>
    }
    if (field === 'id') return <span title={String(row.id)}>{shortRecordId(row.id)}</span>
    if (field === (caps.entities[entity]?.displayField ?? definition.displayField)) return recordLabel(model, entity, row, caps, i18n.language, t)
    if (spec?.type === 'enum') return t(`value_${row[field]}`, { defaultValue: String(row[field]) })
    if (spec?.ui?.signedBy && readableListField(model, entity, caps, spec.ui.signedBy.field)) return signed(row, spec, row[field], i18n.language)
    return formatValue(row[field], spec, i18n.language, t('yes'), t('no'), t('nullValue'), model.timeZone, secondary ? undefined : cell?.kind)
  }
  const content = value(field)
  const secondary = column.secondary ? value(column.secondary, true) : null
  const copy = cell?.kind === 'identifier' && cell.copy === true && row[field] != null && readableListField(model, entity, caps, field)
  return <span className="inline-grid min-w-0 max-w-full gap-0.5">
    <span className="inline-flex min-w-0 items-center gap-1">{primary ? <Link data-row-name="" title={String(row.id)} to="/o/$orgId/e/$entity/$id" params={{ orgId, entity, id: String(row.id) }}>{content}</Link> : content}
      {copy && <button type="button" className="rounded px-1 text-xs underline focus-visible:outline" aria-label={t('listIdentifierCopy')} onClick={async event => {
        event.preventDefault(); event.stopPropagation()
        if (!readableListField(model, entity, caps, field)) return
        try { if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(String(row[field])); setFeedback('listIdentifierCopied') }
        catch { setFeedback('listIdentifierCopyFailed') }
      }}>{t('listIdentifierCopy')}</button>}
    </span>
    {secondary != null && <span data-list-secondary="" className="block text-xs text-muted-foreground">{secondary}</span>}
    {feedback && <span role="status" className="text-xs text-muted-foreground">{t(feedback)}</span>}
  </span>
}
