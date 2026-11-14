import type { EffectiveRecordAction } from './access'
import type { InstanceConfig } from './config'
import { quote } from './migrations/schema'
import { userLinks } from './user-link-fields'

export type AccountCondition = { opaque: true; kind: 'unlinked' | 'linked' | 'pending' | 'clear'; reason: string }
export { accountActionNames, accountCommand } from './account-command'
import { accountActionNames, accountCommand } from './account-command'
/** Compiler-only macros; authored conditions remain strict {when, reason} data. */
export function accountActions(entity: string): EffectiveRecordAction[] {
  const unlinked: AccountCondition = { opaque: true, kind: 'unlinked', reason: 'access.already_linked' }
  return accountActionNames.map(name => ({ entity, name, command: accountCommand(entity, name),
    conditions: name === 'invite' ? [unlinked, { opaque: true, kind: 'clear', reason: 'access.invitation_pending' }]
      : name === 'cancel_invite' ? [{ opaque: true, kind: 'pending', reason: 'access.no_invitation' }]
      : name === 'link_account' ? [unlinked] : [{ opaque: true, kind: 'linked', reason: 'access.not_linked' }],
    dependencies: [`${entity}.user`], source: `access.accountLinks.${entity}`,
  }))
}
export function accountConditionSql(config: InstanceConfig, entity: string, condition: AccountCondition) {
  const link = userLinks(config).find(link => link.entity === entity)
  if (!link || !config.effectiveAccess?.accountLinks?.[entity]) throw new Error('Unregistered account condition')
  const field = `${quote(entity)}.${quote(link.field)}`
  if (condition.kind === 'unlinked') return { sql: `${field} IS NULL`, bindings: [] }
  if (condition.kind === 'linked') return { sql: `${field} IS NOT NULL`, bindings: [] }
  const pending = `EXISTS (SELECT 1 FROM invitations card_invitation WHERE card_invitation.organization_id=${quote(entity)}.organization_id AND card_invitation.target_entity=? AND card_invitation.target_row=${quote(entity)}.id AND card_invitation.accepted_at IS NULL AND card_invitation.revoked_at IS NULL AND card_invitation.declined_at IS NULL AND card_invitation.expired_at IS NULL AND card_invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  return { sql: condition.kind === 'clear' ? `NOT ${pending}` : `(${field} IS NULL AND ${pending})`, bindings: [entity] }
}
