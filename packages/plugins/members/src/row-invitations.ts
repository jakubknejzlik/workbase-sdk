import { z } from 'zod'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { Scope } from '../../../core/src/types'
import { ApiError } from '../../../core/src/errors'
import { quote } from '../../../core/src/migrations/schema'
import { userLinks } from '../../../core/src/user-links'
import { writeFilter } from '../../../core/src/execution/policies'
import { issuerGuard } from '../../../core/src/organization-rules'
import { kernelFor } from '@workbasehq/core/kernel/registry'

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
  const issuer = issuerGuard(config, scope, 'invitations.create', 'member', role => (scope.actor.type === 'agent' || role === scope.role) && !!config.permissions[role]?.[target.entity]?.includes('create'))
  return {
    sql: `${issuer.sql} AND EXISTS (SELECT 1 FROM ${quote(target.entity)} WHERE organization_id=? AND id=? ${available ? `AND ${quote(link.field)} IS NULL` : ''} AND ${policy.sql})`,
    values: [...issuer.values, scope.organizationId, target.row, ...(policy.bindings ?? [])],
  }
}
