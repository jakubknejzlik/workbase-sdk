import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { RuntimeEnv } from './types'
import type { AtomicOperation } from './execution/types'
import { userLinkCommands, registerUserLinkAction } from './user-links'
import { kernelFor } from './kernel/registry'
import { accountCommand } from './account-action-conditions'
import { rowInvitationGuard } from './row-invitations'
import { invitationRole } from './worker-access'
import { issuerGuard } from './organization-rules'
import { actorAccountId } from './policies'
import { ApiError } from './errors'
import { randomToken, sha256, ulid } from './crypto'

export function isAccountAccessCommand(config: InstanceConfig, name: string) {
  return Object.keys(config.effectiveAccess?.accountLinks ?? {}).some(entity => ['invite', 'cancel_invite', 'link_account', 'unlink_account'].some(action => name === accountCommand(entity, action)))
}
/** Internal command schemas own the path id. HTTP input is parsed separately,
 * and cannot supply selectors, grants or server credential destinations. */
export function workerAccessCommands(config: InstanceConfig, env?: RuntimeEnv): AtomicOperation<any>[] {
  return Object.keys(config.effectiveAccess?.accountLinks ?? {}).flatMap(entity => {
    const legacy = userLinkCommands(config)
    const link = legacy.find(command => command.name === `${entity}/link_account`)!
    const unlink = legacy.find(command => command.name === `${entity}/remove_access`)!
    const id = z.string().min(1).meta({ referenceEntity: entity })
    const adapt = (target: AtomicOperation<any>, name: string): AtomicOperation<any> => {
      const map = (input: any) => ({ rowId: input.id, ...(name === 'link_account' ? { userId: input.user_id } : {}) })
      return registerUserLinkAction({ name: accountCommand(entity, name), permission: target.permission,
        input: name === 'link_account' ? z.strictObject({ id, user_id: z.string().min(1) }) : z.strictObject({ id }),
        async prepare(ctx, input) {
          try { return await target.prepare?.(ctx, map(input)) }
          catch (error) { if (error instanceof ApiError && error.status === 404) throw new ApiError(404, 'not_found'); throw error }
        },
        plan: (ctx, input) => target.plan(ctx, map(input)),
      })
    }
    const cancel = registerUserLinkAction({ name: accountCommand(entity, 'cancel_invite'), permission: { entity, operation: 'update' }, input: z.strictObject({ id }),
      plan(ctx, input) {
        const guard = issuerGuard(ctx.config, ctx.scope, 'invitations.revoke', undefined, role => role === ctx.scope.role)
        return { rules: [{ name: 'cancel_invite', statements: [{
          sql: `UPDATE invitations SET revoked_at=? WHERE organization_id=? AND target_entity=? AND target_row=? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>? AND ${guard.sql}`,
          bindings: [ctx.now, ctx.scope.organizationId, entity, input.id, ctx.now, ...guard.values], expectRows: 1,
        }] }], event: { operation: 'invitation.revoked', entity, entityId: input.id }, result: { status: 200, body: { id: input.id } } }
      },
    }, 'invitations.revoke')
    const invite = registerUserLinkAction({ name: accountCommand(entity, 'invite'), permission: { entity, operation: 'create' }, input: z.strictObject({ id, email: z.string().trim().pipe(z.email()).transform(email => email.toLowerCase()) }),
      async prepare(ctx, input) {
        // Resolve credentials and outbox payload privately, never into config/locks.
        const configured = env?.IDENTITY?.baseURL ?? env?.AUTH_BASE_URL
        if (!configured) throw new Error('invitation_origin_required')
        const role = invitationRole(ctx.config, entity)
        const token = randomToken(), invitationId = ulid(), outboxId = ulid()
        const expires = new Date(Date.now() + 7 * 86400000).toISOString()
        const url = new URL('/invitations/accept', configured); url.searchParams.set('token', token)
        const mail = kernelFor(ctx.config).mailOutbox.intent({ id: outboxId, organizationId: ctx.scope.organizationId, recipient: input.email,
          subject: 'Workspace invitation', body: `Accept: ${url.href}`, text: `Accept: ${url.href}`, html: `<a href="${url.href}">Accept</a>`, expiresAt: expires,
        }, 'changes()=1')
        return { role, invitationId, outboxId, expires, hash: await sha256(token), url: url.href, mail }
      },
      plan(ctx, input) {
        const p = ctx.prepared
        const guard = rowInvitationGuard(ctx.config, ctx.scope, { entity, row: input.id })
        return { rules: [{ name: 'invite', statements: [{
          // Migration 004's BEFORE INSERT trigger expires the stale row before
          // its partial unique index is checked, within this same D1 batch.
          sql: `INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,delivery_outbox_id,target_entity,target_row) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`,
          bindings: [p.invitationId, ctx.scope.organizationId, input.email, p.role, p.hash, p.expires, actorAccountId(ctx.scope), ctx.now, p.outboxId, entity, input.id, ...guard.values], expectRows: 1,
        }, p.mail] }], event: { operation: 'invitation.created', entity: 'invitations', entityId: p.invitationId },
          result: { status: 201, body: { invitation_id: p.invitationId, expires_at: p.expires, accept_url: p.url } } }
      },
    })
    return [invite, cancel, adapt(link, 'link_account'), adapt(unlink, 'unlink_account')]
  })
}
