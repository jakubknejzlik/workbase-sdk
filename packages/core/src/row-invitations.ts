import { invitationRole } from './worker-access'
import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { Scope } from './types'
import { ApiError } from './errors'
import { quote } from './migrations/schema'
import { userLinks } from './user-links'
import { writeFilter } from './execution/policies'
import { issuerGuard } from './organization-rules'
import { kernelFor } from './kernel/registry'

export const rowTargetSchema = z.strictObject({ entity: z.string().regex(/^[a-z][a-z0-9_]*$/), row: z.string().min(1).max(200) })
export type RowTarget = z.infer<typeof rowTargetSchema>
export function rowLink(config: InstanceConfig, target: RowTarget) {
  const link = userLinks(config).find(link => link.entity === target.entity)
  if (!link) throw new ApiError(400, 'user_link_required')
  return link
}
/** Pin one prepared issuer role and compile its policy once. SQL rechecks the
 * live role and the target pre-image in the same batch as the invitation claim. */
export function rowInvitationGuard(config: InstanceConfig, scope: Scope, target: RowTarget, available = true) {
  const link = rowLink(config, target)
  const policy = writeFilter(kernelFor(config), scope, target.entity, target.entity, 'create')
  const issuer = issuerGuard(config, scope, 'invitations.create', invitationRole(config, target.entity), role => (scope.actor.type === 'agent' || role === scope.role) && !!config.permissions[role]?.[target.entity]?.includes('create'))
  return {
    sql: `${issuer.sql} AND EXISTS (SELECT 1 FROM ${quote(target.entity)} WHERE organization_id=? AND id=? ${available ? `AND ${quote(link.field)} IS NULL` : ''} AND ${policy.sql})`,
    values: [...issuer.values, scope.organizationId, target.row, ...(policy.bindings ?? [])],
  }
}
