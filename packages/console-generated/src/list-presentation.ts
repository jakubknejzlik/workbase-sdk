import type { Model, Capabilities } from './read'
import { detailReadableField } from './detail-plan'
/** Full descriptors own presentation; dependencies join the existing SELECT. */
export function listColumnFields(model: Model, entity: string): string[] {
  const definition = model.entities[entity]
  return [...new Set(definition.list?.columns?.flatMap(column => [column.field, ...column.secondary ? [column.secondary] : []]) ?? definition.listColumns ?? definition.columns)]
}
export function listLabelEntity(model: Model, entity: string, field: string): string | undefined {
  const definition = model.entities[entity]; const related = definition.list?.relatedColumns?.[field]
  const first = definition.fields[related?.via ?? field]
  return related ? model.entities[first?.entity ?? '']?.fields[related.field]?.entity : first?.entity
}
/** Recheck every hop and display dependency before using labels from a cached response. */
export function readableListField(model: Model, entity: string, caps: Capabilities, field: string): boolean {
  const definition = model.entities[entity]
  const related = definition.list?.relatedColumns?.[field]
  const explicit = definition.list?.columns?.some(column => column.field === field || column.secondary === field) ?? definition.listColumns?.includes(field) ?? false
  if (!related) return detailReadableField(model, entity, caps, field, true, explicit)
  const target = model.entities[entity].fields[related.via]?.entity
  return !!target && detailReadableField(model, entity, caps, related.via) && detailReadableField(model, target, caps, related.field)
}
export function readableListLabel(model: Model, entity: string, caps: Capabilities, field: string): boolean {
  if (!readableListField(model, entity, caps, field)) return false
  const target = listLabelEntity(model, entity, field)
  const display = target && (caps.entities[target]?.displayField ?? model.entities[target]?.displayField)
  return !!target && !!display && detailReadableField(model, target, caps, display)
}

/** Alignment follows schema metadata, including label-only related columns; never row values or cell renderers. */
export function listColumnAlignment(model: Model, entity: string, field: string): 'left' | 'right' | 'center' {
  const definition = model.entities[entity]
  if (definition.list?.relatedColumns?.[field]) return 'center'
  switch (definition.fields[field]?.type) {
    case 'int': case 'float': case 'number': return 'right'
    case 'date': case 'datetime': case 'bool': case 'ref': return 'center'
    default: return 'left'
  }
}
