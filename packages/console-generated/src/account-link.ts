import type { Model, Relation } from './read'

/** Match the link's FK and target, never a presentation alias. Other account refs stay visible. */
export function accountLinkField(model: Model, entity: string, field: string) {
  return model.entities[entity].accountLink?.field === field
}
export function accountLinkRelation(model: Model, entity: string, relation: Relation) {
  const link = model.entities[entity].accountLink
  return !!link && relation.cardinality === 'n:1' && !relation.through && relation.field === link.field && relation.entity === link.entity
}
