import { actorAccountId } from '../../../core/src/policies'
import { rowTargetSchema, rowLink, rowInvitationGuard } from './row-invitations'
import { quote } from '../../../core/src/migrations/schema'
import { writeFilter } from '../../../core/src/execution/policies'
import { displayIdentity } from '../../identity/src/display-identity'
import { isOrganizationAdministrator } from '../../permissions/src/roles'
import { recipientRoutes } from './recipient-routes'
import { invitationTokenSchema } from './invitation-token'
import { profileNamesSchema } from '../../identity/src/profile'
import { invitationMail, invitationDeliveryStatus, invitationDeliveryEligible, inviterDisplay, invitationOrigin } from './mail'
import { canGrantRole } from '../../../core/src/execution/permissions'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { z } from 'zod'
import type { App, AppContext, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig, OrganizationAction } from '@workbasehq/core/config'
import { scopeMiddleware, requireScope, allowedOperations } from '../../../core/src/authorization'
import { emailSchema } from '@workbasehq/core/identity-providers'
import { randomToken, sha256, ulid } from '@workbasehq/core/crypto'
import { ApiError } from '../../../core/src/errors'
import { RuleFailed } from '../../../core/src/execution/errors'
import { organizationPermission } from '../../../core/src/execution/permissions'
import { issuerGuard, organizationRule, memberMutationRule } from '../../../core/src/organization-rules'
export { organizationPermission } from '../../../core/src/execution/permissions'

import { membershipExecutor, meDocument } from '../../../core/src/organizations'
const nowISO = () => new Date().toISOString()
export function memberRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  if (!kernelFor(config).providers.has('login')) return
  const roleSchema = z.enum(config.roles as [string, ...string[]])
  const scoped = scopeMiddleware(env, config, kernelFor(config))
  const execute = membershipExecutor(config, env)
  function scopeFor(c: AppContext, action?: OrganizationAction) {
    const scope = c.get('scope')
    if (scope.organizationId !== c.req.param('orgId')) throw new ApiError(403, 'organization_forbidden')
    if (action) {
      kernelFor(config).resourcePermission(scope, action)
      organizationPermission(config, scope, action)
    }
    return scope
  }
  app.get('/me', async c => {
    const resolved = await kernelFor(config).requireActor(c.req.raw, env)
    // Opt-in scoped identity keeps the original /me response contract intact.
    const scope = c.req.query('scope') === 'organization'
      ? await requireScope(resolved, c.req.header('X-Organization-Id') ?? '', config, c.get('correlationId')) : undefined
    return c.json({ ...(scope ? { organization_id: scope.organizationId, role: scope.role, operations: allowedOperations(scope) } : {}), ...meDocument(resolved, config) })
  })
  app.get('/orgs/:orgId/members', scoped, async c => {
    const scope = scopeFor(c, 'members.read')
    c.header('Cache-Control', 'no-store')
    // Profile names take precedence, as in Identity's self projection. For an
    // external identity, only use names synchronized from its current binding.
    const members = await env.DB.prepare(`SELECT m.user_id,u.email,m.role,a.name,p.first_name AS firstName,p.last_name AS lastName
      FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN "user" a ON a.id=u.id
      LEFT JOIN identity_profiles p ON p.user_id=u.id AND (
        NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider<>'local')
        OR (p.synced_at IS NOT NULL
          AND (SELECT count(*) FROM identities i WHERE i.user_id=u.id AND i.provider<>'local')=1
          AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider=p.source_provider AND i.issuer=p.source_issuer AND i.subject=p.source_subject)))
      WHERE m.organization_id=? ORDER BY m.user_id`).bind(scope.organizationId).all<{ user_id: string; email: string; role: string; name: string | null; firstName: string | null; lastName: string | null }>()
    if (c.req.query('include') !== 'pending') return c.json({ data: members.results.map(({ name: _name, firstName: _firstName, lastName: _lastName, ...row }) => row) })
    const can = (action: OrganizationAction) => {
      try { kernelFor(config).resourcePermission(scope, action); organizationPermission(config, scope, action); return true } catch { return false }
    }
    const rows = await env.DB.prepare(`SELECT id,email,role,expires_at,inviter_id,created_at FROM invitations
      WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>? ORDER BY id`)
      .bind(scope.organizationId, nowISO()).all<{ id: string; email: string; role: string; expires_at: string; inviter_id: string; created_at: string | null }>()
    const pending = await Promise.all(rows.results.map(async ({ inviter_id, ...row }) => ({ ...row, kind: 'invitation', status: 'pending',
      inviter: { display_name: await inviterDisplay(env.DB, inviter_id) },
      actions: [...(can('invitations.create') && canGrantRole(config, scope.role, row.role) ? ['copy-link', 'resend', 'delivery', 'retry-delivery'] : []), ...(can('invitations.revoke') && canGrantRole(config, scope.role, row.role) ? ['revoke'] : [])],
    })))
    // UI hints are computed here, never by reproducing the role policy in a client.
    // Keep member hidden until the #177 upgrade has run on every instance.
    const roleOptions = config.roles.filter(role => role !== 'member' && canGrantRole(config, scope.role, role)).map(id => ({ id, administrator: isOrganizationAdministrator(config, id) }))
    const breadth = (role: string) => Object.values(config.permissions[role] ?? {}).reduce((n, grants) => n + grants.length, 0) + (config.organizationPermissions[role]?.length ?? 0)
    const defaultRole = [...roleOptions].sort((a, b) => breadth(a.id) - breadth(b.id) || a.id.localeCompare(b.id))[0]?.id
    const administrators = members.results.filter(row => row.role === config.organizationOwnerRole).length
    return c.json({ role_options: roleOptions, default_role: defaultRole, data: [...members.results.map(({ name, firstName, lastName, ...row }) => ({ ...row, display_name: displayIdentity({ name, firstName, lastName, email: row.email }).displayName,
      last_administrator: administrators === 1 && row.role === config.organizationOwnerRole, kind: 'member', status: 'active',
      actions: [...(can('members.update') ? ['update-role'] : []), ...(can('members.remove') ? ['remove'] : [])],
    })), ...pending] })
  })
  async function mutateMember(c: AppContext, remove: boolean, leave = false) {
    const scope = scopeFor(c, leave ? undefined : remove ? 'members.remove' : 'members.update')
    if (scope.actor.type !== 'user') throw new ApiError(403, 'user_required')
    const userId = leave ? scope.actor.id : c.req.param('userId')!
    const role = remove ? null : roleSchema.parse(z.strictObject({ role: roleSchema }).parse(await c.req.json()).role)
    if (role !== null && !canGrantRole(config, scope.role, role)) throw new ApiError(403, 'role_escalation')
    const before = await env.DB.prepare('SELECT role FROM memberships WHERE organization_id=? AND user_id=?').bind(scope.organizationId, userId).first<{ role: string }>()
    if (!before) throw new ApiError(404, 'member_not_found')
    try {
      await execute(scope, remove ? 'members/remove' : 'members/update', leave ? 'members.leave' : remove ? 'members.remove' : 'members.update', {
        rules: [memberMutationRule(config, scope, userId, role, remove, leave)],
        event: { operation: remove ? 'membership.removed' : 'membership.role_changed', entity: 'memberships', entityId: userId },
        result: { status: remove ? 204 : 200, body: remove ? {} : { user_id: userId, organization_id: scope.organizationId, role } },
      })
    } catch (error) {
      if (!(error instanceof RuleFailed)) throw error
      const current = await env.DB.prepare('SELECT role FROM memberships WHERE organization_id=? AND user_id=?').bind(scope.organizationId, userId).first<{ role: string }>()
      if (current?.role === config.organizationOwnerRole && role !== config.organizationOwnerRole) {
        const owners = await env.DB.prepare('SELECT count(*) AS n FROM memberships WHERE organization_id=? AND role=?').bind(scope.organizationId, config.organizationOwnerRole).first<number>('n')
        if (owners === 1) throw new ApiError(409, 'last_owner')
      }
      throw new ApiError(409, 'membership_conflict')
    }
    return remove ? c.body(null, 204) : c.json({ user_id: userId, organization_id: scope.organizationId, role })
  }
  app.patch('/orgs/:orgId/members/:userId', scoped, c => mutateMember(c, false))
  app.delete('/orgs/:orgId/members/:userId', scoped, c => mutateMember(c, true))
  app.post('/orgs/:orgId/leave', scoped, c => mutateMember(c, true, true))

  app.get('/orgs/:orgId/row-access/:entity/:rowId', scoped, async c => {
    c.header('Cache-Control', 'private, no-store')
    const scope = scopeFor(c, 'invitations.read')
    const target = rowTargetSchema.parse({ entity: c.req.param('entity'), row: c.req.param('rowId') })
    const link = rowLink(config, target)
    kernelFor(config).permission(scope, target.entity, 'read')
    const filter = writeFilter(kernelFor(config), scope, target.entity)
    const row = await env.DB.prepare(`SELECT ${quote(link.field)} AS user FROM ${quote(target.entity)} WHERE organization_id=? AND id=? AND ${filter.sql}`)
      .bind(scope.organizationId, target.row, ...(filter.bindings ?? [])).first<{ user: string | null }>()
    if (!row) throw new ApiError(404, 'not_found')
    const latest = await env.DB.prepare(`SELECT id,email,expires_at,expired_at,accepted_at,revoked_at,declined_at FROM invitations WHERE organization_id=? AND target_entity=? AND target_row=?
      ORDER BY created_at DESC,id DESC LIMIT 1`).bind(scope.organizationId, target.entity, target.row).first<{ id: string; email: string; expires_at: string; expired_at: string | null; accepted_at: string | null; revoked_at: string | null; declined_at: string | null }>()
    const invitation = latest && !latest.accepted_at && !latest.revoked_at && !latest.declined_at ? latest : null
    const guard = rowInvitationGuard(config, scope, target, false)
    let invitePermission = false
    try { kernelFor(config).resourcePermission(scope, 'invitations.create'); organizationPermission(config, scope, 'invitations.create'); invitePermission = true } catch {}
    const canInvite = invitePermission && kernelFor(config).can(scope, target.entity, 'create') && !!await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()
    let canCancel = false
    try { kernelFor(config).resourcePermission(scope, 'invitations.revoke'); organizationPermission(config, scope, 'invitations.revoke'); canCancel = true } catch {}
    return c.json({ can_cancel: canCancel, state: row.user ? 'signed_in' : invitation ? invitation.expired_at || invitation.expires_at <= nowISO() ? 'expired' : 'invited' : 'no_account',
      ...(invitation && (canInvite || canCancel) ? { invitation: { id: invitation.id, email: invitation.email, expires_at: invitation.expires_at } } : {}), can_invite: canInvite })
  })
  app.post('/orgs/:orgId/invitations', scoped, async c => {
    const scope = scopeFor(c, 'invitations.create')
    const parsed = z.strictObject({ email: z.string().trim().pipe(emailSchema), role: roleSchema.optional(), target: rowTargetSchema.optional(), profile_prefill: profileNamesSchema.optional() }).parse(await c.req.json())
    if (parsed.target && parsed.role !== undefined && parsed.role !== 'member') throw new ApiError(400, 'invalid_invitation_role')
    const body = { ...parsed, role: parsed.target ? 'member' : roleSchema.parse(parsed.role) }
    if (body.target) {
      const link = rowLink(config, body.target)
      kernelFor(config).permission(scope, body.target.entity, 'create')
      const guard = rowInvitationGuard(config, scope, body.target, false)
      if (!await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()) throw new ApiError(404, 'not_found')
      if (await env.DB.prepare(`SELECT 1 FROM ${quote(link.entity)} WHERE organization_id=? AND id=? AND ${quote(link.field)} IS NOT NULL`).bind(scope.organizationId, body.target.row).first()) throw new ApiError(409, 'account_already_linked')
    }
    if (!canGrantRole(config, scope.role, body.role)) throw new ApiError(403, 'role_escalation')
    const member = await env.DB.prepare('SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND lower(u.email)=?').bind(scope.organizationId, body.email).first()
    if (member && !body.target) return c.json({ message: 'already_member' })
    const token = randomToken(); const id = ulid(); const now = nowISO(); const outboxId = ulid()
    const link = new URL('/invitations/accept', invitationOrigin(env, c.req.url))
    link.searchParams.set('token', token)
    const expires = new Date(Date.now() + 7 * 86400000).toISOString()
    const mail = await invitationMail(env, config, outboxId, scope.organizationId, body.email, link.href, { inviterId: actorAccountId(scope), role: body.role, expiresAt: expires, kind: 'invite' })
    const guard = body.target ? rowInvitationGuard(config, scope, body.target) : issuerGuard(config, scope, 'invitations.create', body.role)
    try {
      await execute(scope, 'invitations/create', 'invitations.create', {
        rules: [organizationRule('invitation_create', {
          sql: `INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,delivery_outbox_id,name_first,name_last,target_entity,target_row)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND (?=1 OR NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND lower(u.email)=?))`,
          bindings: [id, scope.organizationId, body.email, body.role, await sha256(token), expires, actorAccountId(scope), now, outboxId, body.profile_prefill?.firstName ?? null, body.profile_prefill?.lastName ?? null, body.target?.entity ?? null, body.target?.row ?? null, ...guard.values, body.target ? 1 : 0, scope.organizationId, body.email],
        }, mail.intent(expires))],
        event: { operation: 'invitation.created', entity: 'invitations', entityId: id },
        result: { status: 201, body: { id, email: body.email, role: body.role, expires_at: expires } },
      })
    } catch (error) {
      if (/UNIQUE constraint failed: (index 'invitations_one_pending_email'|invitations.organization_id, invitations.target_entity, invitations.target_row)/i.test(String(error))) throw new ApiError(409, 'invitation_pending')
      if (error instanceof RuleFailed) throw new ApiError(409, 'invitation_conflict')
      throw error
    }
    await mail.deliver()
    c.header('Cache-Control', 'no-store')
    return c.json({ id, email: body.email, role: body.role, expires_at: expires, accept_url: link.href, delivery: await invitationDeliveryStatus(env, config, outboxId) }, 201)
  })
  app.post('/orgs/:orgId/invitations/:invitationId/resend', scoped, async c => {
    const scope = scopeFor(c, 'invitations.create'); const id = c.req.param('invitationId')
    const invitation = await env.DB.prepare('SELECT email,role,token_hash,inviter_id,target_entity,target_row FROM invitations WHERE id=? AND organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL').bind(id, scope.organizationId).first<{email: string; role: string; token_hash: string; inviter_id: string; target_entity: string | null; target_row: string | null}>()
    if (!invitation) throw new ApiError(409, 'invitation_unavailable')
    const member = await env.DB.prepare('SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND lower(u.email)=lower(?)').bind(scope.organizationId, invitation.email).first()
    if (member && !invitation.target_entity) return c.json({ message: 'already_member' })
    if (!canGrantRole(config, scope.role, invitation.role)) throw new ApiError(403, 'role_escalation')
    if (invitation.target_entity) kernelFor(config).permission(scope, invitation.target_entity, 'create')
    const token = randomToken(); const outboxId = ulid()
    const link = new URL('/invitations/accept', invitationOrigin(env, c.req.url))
    link.searchParams.set('token', token)
    const guard = invitation.target_entity ? rowInvitationGuard(config, scope, { entity: invitation.target_entity, row: invitation.target_row! }) : issuerGuard(config, scope, 'invitations.create', invitation.role)
    const expires = new Date(Date.now() + 7 * 86400000).toISOString()
    const mail = await invitationMail(env, config, outboxId, scope.organizationId, invitation.email, link.href, { inviterId: invitation.inviter_id, role: invitation.role, expiresAt: expires, kind: 'reminder' })
    try { await execute(scope, 'invitations/resend', 'invitations.create', {
      rules: [organizationRule('invitation_resend', {
        sql: `UPDATE invitations SET token_hash=?,expires_at=?,expired_at=NULL,delivery_outbox_id=? WHERE id=? AND organization_id=? AND token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND NOT EXISTS (SELECT 1 FROM invitations newer WHERE newer.organization_id=invitations.organization_id AND newer.target_entity=invitations.target_entity AND newer.target_row=invitations.target_row AND (newer.created_at>invitations.created_at OR (newer.created_at=invitations.created_at AND newer.id>invitations.id))) AND ${guard.sql}`,
        bindings: [await sha256(token), expires, outboxId, id, scope.organizationId, invitation.token_hash, ...guard.values],
      }, mail.intent(expires))], event: { operation: 'invitation.resent', entity: 'invitations', entityId: id }, result: { status: 200, body: { id } }, conflict: 'invitation_conflict',
    })
    } catch (error) {
      if (error instanceof RuleFailed || /UNIQUE constraint failed/i.test(String(error))) throw new ApiError(409, 'invitation_conflict')
      throw error
    }
    await mail.deliver()
    c.header('Cache-Control', 'no-store')
    return c.json({ id, expires_at: expires, delivery: await invitationDeliveryStatus(env, config, outboxId) })
  })
  async function managedInvitation(c: AppContext) {
    const scope = scopeFor(c, 'invitations.create')
    const invitation = await env.DB.prepare(`SELECT id,email,role,token_hash,expires_at,delivery_outbox_id,target_entity,target_row FROM invitations
      WHERE id=? AND organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>?`)
      .bind(c.req.param('invitationId'), scope.organizationId, nowISO()).first<{ id: string; email: string; role: string; token_hash: string; expires_at: string; delivery_outbox_id: string | null; target_entity: string | null; target_row: string | null }>()
    if (!invitation) throw new ApiError(409, 'invitation_unavailable')
    if (!canGrantRole(config, scope.role, invitation.role)) throw new ApiError(403, 'role_escalation')
    if (invitation.target_entity) kernelFor(config).permission(scope, invitation.target_entity, 'create')
    return { scope, invitation }
  }
  app.post('/orgs/:orgId/invitations/:invitationId/copy-link', scoped, async c => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    const { scope, invitation } = await managedInvitation(c)
    const token = randomToken()
    const link = new URL('/invitations/accept', invitationOrigin(env, c.req.url))
    link.searchParams.set('token', token)
    const guard = invitation.target_entity ? rowInvitationGuard(config, scope, { entity: invitation.target_entity, row: invitation.target_row! }) : issuerGuard(config, scope, 'invitations.create', invitation.role)
    try {
      await execute(scope, 'invitations/copy_link', 'invitations.create', {
        rules: [organizationRule('invitation_rotate', {
          sql: `UPDATE invitations SET token_hash=?,delivery_outbox_id=NULL WHERE id=? AND organization_id=? AND token_hash=?
            AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>? AND ${guard.sql}`,
          bindings: [await sha256(token), invitation.id, scope.organizationId, invitation.token_hash, nowISO(), ...guard.values],
        })], event: { operation: 'invitation.link_rotated', entity: 'invitations', entityId: invitation.id },
        result: { status: 200, body: { id: invitation.id } },
      })
    } catch (error) { if (error instanceof RuleFailed) throw new ApiError(409, 'invitation_conflict'); throw error }
    return c.json({ id: invitation.id, accept_url: link.href, expires_at: invitation.expires_at })
  })
  app.get('/orgs/:orgId/invitations/:invitationId/delivery', scoped, async c => {
    c.header('Cache-Control', 'no-store')
    const { invitation } = await managedInvitation(c)
    return c.json({ id: invitation.id, delivery: await invitationDeliveryStatus(env, config, invitation.delivery_outbox_id) })
  })
  app.post('/orgs/:orgId/invitations/:invitationId/retry-delivery', scoped, async c => {
    c.header('Cache-Control', 'no-store')
    const { scope, invitation } = await managedInvitation(c)
    if (!invitation.delivery_outbox_id) throw new ApiError(409, 'invitation_delivery_unavailable')
    const guard = invitation.target_entity ? rowInvitationGuard(config, scope, { entity: invitation.target_entity, row: invitation.target_row! }) : issuerGuard(config, scope, 'invitations.create', invitation.role)
    await kernelFor(config).mailOutbox.retry(env, config, invitation.delivery_outbox_id, async () =>
      await invitationDeliveryEligible(env.DB, invitation.id, scope.organizationId, invitation.delivery_outbox_id!, invitation.token_hash)
      && !!await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first())
    return c.json({ id: invitation.id, delivery: await invitationDeliveryStatus(env, config, invitation.delivery_outbox_id) })
  })
  app.get('/orgs/:orgId/invitations', scoped, async c => {
    c.header('Cache-Control', 'no-store')
    const scope = scopeFor(c, 'invitations.read')
    const rows = await env.DB.prepare('SELECT id,email,role,expires_at,accepted_at,accepted_user_id,revoked_at,declined_at,created_at FROM invitations WHERE organization_id=? ORDER BY id').bind(scope.organizationId).all()
    return c.json({ data: rows.results })
  })
  app.delete('/orgs/:orgId/invitations/:invitationId', scoped, async c => {
    const scope = scopeFor(c, 'invitations.revoke'); const id = c.req.param('invitationId'); const guard = issuerGuard(config, scope, 'invitations.revoke')
    await execute(scope, 'invitations/revoke', 'invitations.revoke', {
      rules: [organizationRule('invitation_revoke', {
        sql: `UPDATE invitations SET revoked_at=? WHERE id=? AND organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND ${guard.sql}
          AND (role<>? OR EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND user_id=? AND role=?))`,
        bindings: [nowISO(), id, scope.organizationId, ...guard.values, config.organizationOwnerRole, scope.organizationId, scope.actor.id, config.organizationOwnerRole],
      })],
      event: { operation: 'invitation.revoked', entity: 'invitations', entityId: id },
      result: { status: 204, body: {} }, conflict: 'invitation_conflict',
    })
    return c.body(null, 204)
  })
  recipientRoutes(app, config, env)
  app.get('/invitations/accept', c => {
    const token = invitationTokenSchema.parse(c.req.query('token'))
    c.header('Referrer-Policy', 'no-referrer'); c.header('Cache-Control', 'no-store')
    return c.redirect(`/invitation?token=${token}`)
  })
}
