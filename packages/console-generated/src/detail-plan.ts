import type { ConsoleDetailItem } from '../../plugins/console/src/contract'
import type { Capabilities, Model } from './read'

export function detailReadableField(model: Model, name: string, caps: Capabilities, field: string, allowLabel = true): boolean {
  const target = model.entities[name]
  if (!caps.entities[name]?.operations.includes('read') || !caps.entities[name]?.readable.includes(field)) return false
  const reference = target.fields[field]?.entity
  if (reference && (!caps.entities[reference]?.operations.includes('read') || !caps.entities[reference]?.readable.includes('id'))) return false
  if (allowLabel && target.labelDependencies && field === target.displayField) return target.labelDependencies.every(dependency => detailReadableField(model, dependency.entity, caps, dependency.field, false))
  return !target.fields[field]?.ui?.hidden || field === target.displayField && !!target.labelDependencies
}

export const detailItem = (item: ConsoleDetailItem) => typeof item === 'string' ? { field: item } : item
/** A declared group list opts into exact projection. Dependencies are query operands,
 * not extra displayed rows; expression operands remain inside the server SELECT. */
export function detailPlan(model: Model, entity: string, caps: Capabilities) {
  const definition = model.entities[entity]; const detail = definition.detail
  if (!detail?.groups) return undefined
  const readable = (name: string, field: string) => detailReadableField(model, name, caps, field)
  const items = (items: ConsoleDetailItem[]) => items.map(detailItem).filter(item => readable(entity, item.field) && (!item.when || readable(entity, item.when.field)) && (!definition.fields[item.field]?.ui?.signedBy || readable(entity, definition.fields[item.field].ui!.signedBy!.field)))
  const summary = items(detail.summary ?? [])
  const groups = detail.groups.map(group => ({ ...group, fields: items(group.fields) })).filter(group => group.fields.length)
  const metrics = (detail.metrics ?? []).filter(metric => readable(entity, metric.field) && (!metric.unitField || caps.entities[entity]?.readable.includes(metric.unitField)))
  const relations = Object.entries(definition.relations).filter(([name, relation]) => {
    if (!Object.hasOwn(detail.relations ?? {}, name)) return false
    const target = caps.entities[relation.entity]
    return target?.operations.includes('read') && target.readable.includes('id') && caps.entities[relation.cardinality === '1:n' ? relation.entity : entity]?.readable.includes(relation.field)
      && (!relation.through || caps.entities[relation.through.entity]?.operations.includes('read') && caps.entities[relation.through.entity]?.readable.includes('id') && target.readable.includes(relation.through.field))
  })
  const fields = [...summary, ...groups.flatMap(group => group.fields)]
  const display = caps.entities[entity]?.displayField ?? definition.displayField
  const select = [...new Set([
    'id', ...(caps.entities[entity]?.operations.includes('update') ? ['version'] : []),
    ...(display && readable(entity, display) ? [display] : []),
    ...fields.flatMap(item => [item.field, ...item.when ? [item.when.field] : [], ...definition.fields[item.field]?.ui?.signedBy ? [definition.fields[item.field].ui!.signedBy!.field] : []]),
    ...metrics.flatMap(metric => [metric.field, ...metric.unitField ? [metric.unitField] : []]),
    ...relations.filter(([, relation]) => relation.cardinality !== '1:n').map(([, relation]) => relation.field),
  ])].filter(field => caps.entities[entity]?.readable.includes(field))
  const labels = fields.filter(item => definition.fields[item.field]?.type === 'ref').map(item => item.field)
  return { summary, groups, metrics, relations, select, labels: [...new Set(labels)] }
}
