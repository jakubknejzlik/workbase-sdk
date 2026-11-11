// Core-only account-link writers. No raw SQL or capability is exposed to clients.
import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { Scope } from './types'
import { ApiError } from './errors'
import { quote } from './migrations/schema'
import type { AtomicOperation, AtomicRule, GuardedStatement, PlanningContext, SqlStatement } from './execution/types'
import { writeFilter } from './execution/policies'
import { kernelFor } from './kernel/registry'
import { organizationPermission } from './organization-permissions'
import { issuerGuard } from './organization-rules'

type LinkContext = Pick<PlanningContext, 'config' | 'scope' | 'now'>
// Frozen statement identity, rather than caller-supplied metadata, grants the exception.
const writers = new WeakMap<GuardedStatement, 'link' | 'cleanup'>()
const livePolicies = new WeakMap<GuardedStatement, SqlStatement>()
function writer(statement: GuardedStatement, mode: 'link' | 'cleanup'): GuardedStatement {
  if (statement.bindings) Object.freeze(statement.bindings)
  if (statement.diagnose) { Object.freeze(statement.diagnose.bindings); Object.freeze(statement.diagnose) }
  Object.freeze(statement)
  writers.set(statement, mode)
  return statement
}
export const userLinkWriter = (statement: GuardedStatement) => writers.get(statement)
// Only these core-minted statements can substitute a prepared-role policy filter.
export const userLinkPolicyFilter = (statement: GuardedStatement) => livePolicies.get(statement)
export function userLinks(config: InstanceConfig) {
  return Object.entries(config.entities).flatMap(([entity, definition]) => Object.entries(definition.fields)
    .filter(([, field]) => field.userLink).map(([field]) => ({ entity, field })))
}
export function assertUnprotectedFields(definition: Pick<InstanceConfig['entities'][string], 'fields'>, fields: string[]) {
  if (fields.some(field => definition.fields[field]?.userLink)) throw new ApiError(400, 'protected_field')
}
function linkField(config: InstanceConfig, entity: string) {
  const found = userLinks(config).find(link => link.entity === entity)
  if (!found) throw new ApiError(400, 'user_link_required')
  return quote(found.field)
}
/** One SQL mutation rechecks uniqueness and membership inside the atomic batch.
 * The invitation caller runs this AFTER its membership insert, in the same plan. */
export function linkAccountRow(ctx: LinkContext, entity: string, rowId: string, userId: string, invitation = false): AtomicRule {
  const field = linkField(ctx.config, entity); const table = quote(entity)
  const unique = `NOT EXISTS (SELECT 1 FROM ${table} other WHERE other.organization_id=? AND other.${field}=? AND other.id<>?)`
  return { name: 'account_link', statements: [writer({
    sql: `UPDATE ${table} SET ${field}=?,updated_at=?,version=version+1 WHERE organization_id=? AND id=? AND ${unique}
      AND EXISTS (SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id WHERE u.id=? AND u.organization_id=?)`,
    bindings: [userId, ctx.now, ctx.scope.organizationId, rowId, ctx.scope.organizationId, userId, rowId, userId, ctx.scope.organizationId], expectRows: 1,
    diagnose: { sql: `SELECT ${unique} AS ok`, bindings: [ctx.scope.organizationId, userId, rowId] }, failureCode: 'account_already_linked',
  }, invitation ? 'cleanup' : 'link')] }
}
function revokeAccountInvitations(scope: Scope, userId: string): GuardedStatement {
  return writer({ sql: `UPDATE invitations SET revoked_at=? WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL
    AND lower(trim(email))=(SELECT lower(trim(email)) FROM users WHERE id=? AND organization_id=?)`,
    bindings: [new Date().toISOString(), scope.organizationId, userId, scope.organizationId] }, 'cleanup')
}
/** Config-derived registry, scoped to the removed membership's organization. */
export function clearAccountLinks(config: InstanceConfig, scope: Scope, userId: string): GuardedStatement[] {
  return [revokeAccountInvitations(scope, userId), ...userLinks(config).map(({ entity, field }) => writer({
    sql: `UPDATE ${quote(entity)} SET ${quote(field)}=NULL,updated_at=?,version=version+1 WHERE organization_id=? AND ${quote(field)}=?`,
    bindings: [new Date().toISOString(), scope.organizationId, userId],
  }, 'cleanup'))]
}
/** Remove access clears ALL links of the account selected by this row. The source
 * is cleared last so every statement reads the same selector inside the batch. */
export function unlinkAccountRow(ctx: LinkContext, entity: string, rowId: string): AtomicRule {
  const field = linkField(ctx.config, entity)
  const links = userLinks(ctx.config).sort((a, b) => Number(a.entity === entity) - Number(b.entity === entity))
  return { name: 'account_unlink', statements: [writer({
    sql: `UPDATE invitations SET revoked_at=? WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL
      AND lower(trim(email))=(SELECT lower(trim(email)) FROM users WHERE organization_id=? AND id=(SELECT ${field} FROM ${quote(entity)} WHERE organization_id=? AND id=?))`,
    bindings: [ctx.now, ctx.scope.organizationId, ctx.scope.organizationId, ctx.scope.organizationId, rowId],
  }, 'cleanup'), ...links.map(link => writer({
    sql: `UPDATE ${quote(link.entity)} SET ${quote(link.field)}=NULL,updated_at=?,version=version+1 WHERE organization_id=? AND ${quote(link.field)}=(SELECT ${field} FROM ${quote(entity)} WHERE organization_id=? AND id=?)`,
    bindings: [ctx.now, ctx.scope.organizationId, ctx.scope.organizationId, rowId],
  }, 'cleanup'))] }
}
/** The recipient route supplies only the persisted invitation target. */
export function invitationAccountLink(ctx: LinkContext, invitation: { entity?: string | null; row?: string | null }, userId: string): AtomicRule[] {
  return invitation.entity && invitation.row ? [linkAccountRow(ctx, invitation.entity, invitation.row, userId, true)] : []
}

const actions = new WeakSet<object>()
export function userLinkActionPermission(config: InstanceConfig, scope: Scope, operation: AtomicOperation<any>) {
  if (!actions.has(operation.plan)) return
  kernelFor(config).resourcePermission(scope, 'invitations.create')
  organizationPermission(config, scope, 'invitations.create')
}
interface PreparedIssuer { role: string; filter: SqlStatement }
export function userLinkCommands(config: InstanceConfig): AtomicOperation<any>[] {
  return userLinks(config).flatMap(({ entity }) => (['link_account', 'remove_access'] as const).map(action => {
    const rowId = z.string().min(1).meta({ referenceEntity: entity })
    const inputSchema: z.ZodType<{ rowId: string; userId?: string }> = action === 'link_account'
      ? z.strictObject({ rowId, userId: z.string().min(1).meta({ referenceEntity: 'users' }) }) : z.strictObject({ rowId })
    const operation: AtomicOperation<typeof inputSchema, PreparedIssuer> = {
      name: `${entity}/${action}`, permission: { entity, operation: 'update' },
      ui: { label: action === 'link_account' ? { en: 'Link', cs: 'Propojit účet' } : { en: 'Remove access', cs: 'Odebrat přístup' } },
      input: inputSchema,
      async prepare(ctx, input) {
        const policy = kernelFor(ctx.config).tableFilter(entity, ctx.scope)
        if (policy.kind === 'none') throw new ApiError(404, 'not_found')
        if (!await ctx.reader.first({ sql: `SELECT id FROM ${quote(entity)} WHERE organization_id=? AND id=?`, bindings: [ctx.scope.organizationId, input.rowId] })) throw new ApiError(404, 'not_found')
        if (action === 'link_account' && !await ctx.reader.first({ sql: 'SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id WHERE u.id=? AND u.organization_id=?', bindings: [input.userId!, ctx.scope.organizationId] })) throw new ApiError(404, 'member_not_found')
        const kernel = kernelFor(ctx.config)
        kernel.atomicPermission(ctx.scope, operation, input)
        return { role: ctx.scope.role, filter: writeFilter(kernel, ctx.scope, entity) }
      },
      plan(ctx, input) {
        // A concurrent role change requires a fresh request under that role.
        const guard = issuerGuard(ctx.config, ctx.scope, 'invitations.create', undefined,
          role => role === ctx.prepared.role)
        const policy = ctx.prepared.filter
        const mutation = action === 'link_account' ? linkAccountRow(ctx, entity, input.rowId, input.userId!) : unlinkAccountRow(ctx, entity, input.rowId)
        if (action === 'link_account') for (const statement of mutation.statements) livePolicies.set(statement, policy)
        const issuer: GuardedStatement = Object.freeze({
          // Revocation requires the source pre-image only; clearing its link must
          // not create a post-image policy requirement. Link checks both images
          // through the normal policy guards on its actual mutation below.
          sql: `UPDATE ${quote(entity)} SET version=version WHERE organization_id=? AND id=? AND ${guard.sql} AND ${policy.sql}`,
          bindings: Object.freeze([ctx.scope.organizationId, input.rowId, ...guard.values, ...(policy.bindings ?? [])]), expectRows: 1,
        })
        // Its WHERE checks the live pre-image. Keep the executor's row capture
        // and 403 denial, without checking the cleared source against the policy.
        livePolicies.set(issuer, Object.freeze({ sql: '1=1' }))
        return { rules: [{ name: 'account_link_issuer', statements: [issuer] }, mutation],
        event: { operation: action === 'link_account' ? 'account.linked' : 'account.access_removed', entity, entityId: input.rowId },
        result: { status: 200, body: { id: input.rowId } } }
      },
    }
    actions.add(operation.plan)
    return operation
  }))
}
