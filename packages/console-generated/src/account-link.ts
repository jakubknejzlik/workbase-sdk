import type { Model, Relation } from './read'

/** Match the link's FK and target, never a presentation alias. Other account refs stay visible. */
export function accountLinkField(model: Model, entity: string, field: string) {
  return model.entities[entity].accountLink?.field === field
}
export function accountLinkRelation(model: Model, entity: string, relation: Relation) {
  const link = model.entities[entity].accountLink
  return !!link && relation.cardinality === 'n:1' && !relation.through && relation.field === link.field && relation.entity === link.entity
}

/** Account actions belong to Application access, never generic command menus. */
export const accountActions = ['link_account', 'remove_access', 'access_invite', 'access_cancel_invite', 'access_link_account', 'access_unlink_account'] as const
export function isAccountAction(model: Model, name: string) {
  const entity = name.split('/')[0]
  return !!model.entities[entity]?.accountLink && accountActions.some(action => name === `${entity}/${action}`)
}
/** Any surviving grant identifies the record-action transport, including link-only roles. */
export function hasRecordAccess(model: Model, entity: string) {
  return !!model.commands?.some(command => ['invite', 'cancel_invite', 'link_account', 'unlink_account'].some(action => command.name === `${entity}/access_${action}`))
}
