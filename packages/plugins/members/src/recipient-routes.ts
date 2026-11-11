import { rowInvitationGuard } from './row-invitations'
import { loadActorProjection } from '../../../core/src/policies'
import { z } from 'zod'
import type { App, AppContext, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig } from '@workbasehq/core/config'
import { accountScope, requireVerifiedSession, type ResolvedActor } from '../../../core/src/authorization'
import { assertIdentityTransport, devLocalIdentityEnabled } from '../../../core/src/identity-settings'
import { accountProvisioning } from '../../../core/src/account-provisioning'
import { invitationAccountLink } from '../../../core/src/user-links'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { membershipExecutor } from '../../../core/src/organizations'
import { organizationRule, issuerGuard } from '../../../core/src/organization-rules'
import { RuleFailed } from '../../../core/src/execution/errors'
import { ApiError } from '../../../core/src/errors'
import { sha256 } from '@workbasehq/core/crypto'
import { invitationOrigin, inviterDisplay } from './mail'
import { hasInvitationMailboxProof, invitationSelector, invitationTokenSchema } from './invitation-token'

interface Invitation {
  target_entity: string | null; target_row: string | null
  id: string; organization_id: string; email: string; role: string; token_hash: string; inviter_id: string
  expires_at: string; accepted_at: string | null; accepted_user_id: string | null; revoked_at: string | null
  expired_at: string | null; declined_at: string | null; bound_user_id: string | null
  name_first: string | null; name_last: string | null
}
const nowISO = () => new Date().toISOString()
const tokenBody = z.object({ token: invitationTokenSchema, return_to: z.string().optional() })
function state(row: Invitation) {
  return row.accepted_at ? 'accepted' : row.declined_at ? 'declined' : row.revoked_at ? 'revoked'
    : row.expired_at || row.expires_at <= nowISO() ? 'expired' : 'pending'
}
function assertPending(row: Invitation) {
  const value = state(row)
  if (value !== 'pending') throw new ApiError(value === 'expired' ? 410 : 409,
    value === 'accepted' ? 'invitation_used' : `invitation_${value}`)
}

export function recipientRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const kernel = kernelFor(config)
  const execute = membershipExecutor(config, env)
  // Apply even on errors: credentials, account match and private metadata never reach shared caches.
  for (const path of ['/invitations/*', '/me/invitations', '/auth/register']) app.use(path, async (c, next) => {
    c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer')
    await next()
  })
  async function authenticate(c: AppContext, recover = false) {
    assertIdentityTransport(c.req.raw, 403)
    if (c.req.header('Authorization')?.startsWith('Bearer wb_')) throw new ApiError(403, 'user_required')
    let actor: ResolvedActor | null
    try { actor = await kernel.authenticate(c.req.raw, env) }
    catch (error) {
      if (!recover || !(error instanceof ApiError) || error.code !== 'unauthenticated' || c.req.header('Authorization') || !c.req.header('Cookie')?.includes('__Host-workbase.session=')) throw error
      const headers = new Headers(c.req.raw.headers)
      headers.set('Cookie', headers.get('Cookie')!.split(';').filter(cookie => !cookie.trim().startsWith('__Host-workbase.session=')).join(';'))
      actor = await kernel.authenticate(new Request(c.req.raw.clone() as Request, { headers }), env)
    }
    if (!actor && (c.req.header('Authorization') || (!recover && c.req.header('Cookie')?.includes('__Host-workbase.session=')))) throw new ApiError(401, 'unauthenticated')
    if (actor) await requireVerifiedSession(actor, env.DB)
    return actor
  }
  function matches(row: Invitation, actor: ResolvedActor) {
    return !!actor.user && row.email.toLowerCase().trim() === actor.user.email.toLowerCase()
      && (!row.bound_user_id || row.bound_user_id === actor.user.id)
  }
  async function lookup(selector: { id: string } | { token: string }, actor?: ResolvedActor | null) {
    const row = await env.DB.prepare(`SELECT * FROM invitations WHERE ${'id' in selector ? 'id' : 'token_hash'}=?`)
      .bind('id' in selector ? selector.id : await sha256(invitationSelector(selector.token))).first<Invitation>()
    if (!row || ('id' in selector && (!actor || !matches(row, actor)))) throw new ApiError(404, 'invitation_not_found')
    await kernel.resolveScopeId(env.DB, row.organization_id)
    return row
  }
  async function eligible(row: Invitation, actor: ResolvedActor, checkMember = true) {
    if (!matches(row, actor)) throw new ApiError(403, 'invitation_not_for_this_account')
    assertPending(row)
    if (!config.roles.includes(row.role)) throw new ApiError(403, 'invalid_invitation_role')
    if (checkMember && !row.target_entity && await env.DB.prepare('SELECT 1 FROM memberships WHERE organization_id=? AND user_id=?').bind(row.organization_id, actor.user!.id).first()) throw new ApiError(409, 'already_member', undefined, { organization_id: row.organization_id })
    // Enforce the existing single-domain-account rule before offering an actionable invitation.
    if (config.account?.entity === 'users') {
      const account = await env.DB.prepare('SELECT organization_id FROM users WHERE id=?').bind(actor.user!.id).first<{ organization_id: string }>()
      if (account && account.organization_id !== row.organization_id) throw new ApiError(409, 'account_already_assigned')
    }
  }
  async function metadata(row: Invitation, actor: ResolvedActor | null) {
    const organization = await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind(row.organization_id).first<{ name: string }>()
    return { id: row.id, organization: { id: row.organization_id, name: organization?.name ?? null },
      inviter: { display_name: await inviterDisplay(env.DB, row.inviter_id) }, role: row.role, expires_at: row.expires_at,
      ...(row.target_entity ? { target: { entity: row.target_entity, row: row.target_row } } : {}), state: state(row), account_match: actor ? matches(row, actor) : null }
  }
  function navigation(row: Invitation) { return `/invitation?id=${encodeURIComponent(row.id)}` }
  // Return targets are local product destinations and must be accessible now (or after this invitation).
  function returnTarget(raw: string | undefined, actor: ResolvedActor, row?: Invitation) {
    if (raw === undefined) return undefined
    if (raw === '/' || raw === '/organizations') return raw
    if (row && raw === navigation(row)) return raw
    const match = /^\/o\/([A-Za-z0-9_-]+)(.*)$/.exec(raw)
    const org = match?.[1]; const tail = match?.[2]
    const entity = /^\/e\/([A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)?$/.exec(tail ?? '')?.[1]
    const validPath = ['', '/', '/members', '/invitations', '/tokens', '/audit', '/workflows', '/workflows/new', '/settings',
      '/settings/workspace-members', '/settings/workspace-settings', '/settings/api-tokens', '/settings/invitations'].includes(tail ?? 'invalid')
      || !!entity && Object.hasOwn(config.entities, entity)
      || /^\/workflows\/[A-Za-z0-9_-]+$/.test(tail ?? '')
    if (org && validPath && (actor.organizations.some(value => value.id === org) || org === row?.organization_id)) return raw
    throw new ApiError(400, 'invalid_return_target')
  }
  async function bind(row: Invitation, actor: ResolvedActor) {
    await eligible(row, actor)
    const result = await env.DB.prepare(`UPDATE invitations SET bound_user_id=? WHERE id=? AND token_hash=?
      AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>?
      AND (bound_user_id IS NULL OR bound_user_id=?)
      AND EXISTS (SELECT 1 FROM "user" WHERE id=? AND lower(email)=lower(trim(invitations.email)))`).bind(actor.user!.id, row.id, row.token_hash, nowISO(), actor.user!.id, actor.user!.id).run()
    if (result.meta.changes !== 1) throw new ApiError(409, 'invitation_conflict')
    row.bound_user_id = actor.user!.id
    if (row.name_first && row.name_last) {
      await kernel.identity.prefillProfile(env, config, actor.user!.id, { firstName: row.name_first, lastName: row.name_last })
    }
  }
  async function preview(row: Invitation, actor: ResolvedActor, rawReturn?: string, bindRecipient = false) {
    const target = returnTarget(rawReturn, actor, row)
    if (state(row) === 'pending') {
      await eligible(row, actor)
      if (bindRecipient) await bind(row, actor)
    }
    const profile = await kernel.identity.readProfile(env.DB, config, actor.user!.id)
    return { ...await metadata(row, actor), navigation_target: navigation(row), return_to: target ?? `/o/${row.organization_id}`,
      profile_complete: profile.completeness.complete, next: state(row) !== 'pending' ? 'terminal' : profile.completeness.complete ? 'preview' : 'profile',
      actions: state(row) === 'pending' ? [...(profile.completeness.complete ? ['accept'] : []), 'decline'] : [] }
  }
  app.get('/me/invitations', async c => {
    const actor = await authenticate(c)
    if (!actor) throw new ApiError(401, 'unauthenticated')
    const rows = await env.DB.prepare(`SELECT * FROM invitations WHERE lower(trim(email))=?
      AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at>? ORDER BY created_at,id`)
      .bind(actor.user!.email.toLowerCase(), nowISO()).all<Invitation>()
    const data = []
    for (const row of rows.results) {
      try { await eligible(row, actor); await kernel.resolveScopeId(env.DB, row.organization_id) }
      catch (error) { if (error instanceof ApiError) continue; throw error }
      data.push({ ...await metadata(row, actor), navigation_target: navigation(row) })
    }
    const raw = c.req.query('return_to')
    const target = data.some(row => row.navigation_target === raw) ? raw : returnTarget(raw, actor)
    return c.json({ data, next: target ?? (!actor.organizations.length && data.length ? data[0].navigation_target : '/organizations') })
  })
  app.post('/invitations/preflight', async c => {
    const actor = await authenticate(c, true)
    const { token } = tokenBody.parse(await c.req.json())
    const row = await lookup({ token })
    return c.json(await metadata(row, actor))
  })
  async function resolve(c: AppContext, body: z.infer<typeof tokenBody>, initial: ResolvedActor | null) {
    let actor = initial
    let login: Awaited<ReturnType<typeof kernel.signInInvitation>> | undefined
    const row = await lookup({ token: body.token })
    assertPending(row)
    // Reject stale roles before creating any session; preview validates return-target authorization.
    if (!config.roles.includes(row.role)) throw new ApiError(403, 'invalid_invitation_role')
    if (!actor) {
      // Login CSRF must be checked even when SameSite withheld an existing session cookie.
      const origin = invitationOrigin(env, c.req.url)
      const site = c.req.header('Sec-Fetch-Site')
      if (c.req.header('Origin') !== origin || (site && site !== 'same-origin') ||
        c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(403, 'csrf_failed')
      // A creator/copy-link token (including legacy links) selects an invitation, never an identity.
      if (!await hasInvitationMailboxProof(env, body.token)) throw new ApiError(401, 'unauthenticated')
      login = await kernel.signInInvitation(row.email, c.req.raw, env)
      actor = login.actor
    }
    try {
      await requireVerifiedSession(actor, env.DB)
      // Re-read after the login adapter; expiry/rotation/revocation may race session establishment.
      const current = await lookup({ token: body.token })
      assertPending(current)
      const result = await preview(current, actor, body.return_to, true)
      if (login) {
        for (const cookie of login.response.headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true })
        const bearer = login.response.headers.get('set-auth-token')
        if (bearer) c.header('set-auth-token', bearer)
      }
      return c.json(result)
    } catch (error) { await login?.revoke(); throw error }
  }
  app.post('/invitations/resolve', async c => {
    const actor = await authenticate(c, true)
    return resolve(c, tokenBody.parse(await c.req.json()), actor)
  })
  app.post('/invitations/:invitationId/resolve', async c => {
    const actor = await authenticate(c)
    if (!actor) throw new ApiError(401, 'unauthenticated')
    const body = z.strictObject({ return_to: z.string().optional() }).parse(await c.req.json())
    const row = await lookup({ id: c.req.param('invitationId') }, actor)
    assertPending(row)
    return c.json(await preview(row, actor, body.return_to, true))
  })
  app.get('/invitations/:invitationId/preview', async c => {
    const actor = await authenticate(c)
    if (!actor) throw new ApiError(401, 'unauthenticated')
    return c.json(await preview(await lookup({ id: c.req.param('invitationId') }, actor), actor, c.req.query('return_to')))
  })
  async function mutate(c: AppContext, action: 'accept' | 'decline', byId: boolean) {
    const actor = await authenticate(c, !byId && action === 'accept')
    const body = byId
      ? z.strictObject({ return_to: z.string().optional() }).parse(JSON.parse(await c.req.text() || '{}'))
      : tokenBody.parse(await c.req.json())
    // Legacy anonymous entry now establishes a session and previews; it cannot grant membership.
    if (!actor) {
      if (!byId && action === 'accept') return resolve(c, body as z.infer<typeof tokenBody>, actor)
      throw new ApiError(401, 'unauthenticated')
    }
    const row = await lookup(byId ? { id: c.req.param('invitationId')! } : { token: (body as z.infer<typeof tokenBody>).token }, actor)
    if (!matches(row, actor)) throw new ApiError(403, 'invitation_not_for_this_account')
    const target = returnTarget(body.return_to, actor, row)
    const response = (replayed: boolean) => ({ id: row.id, state: action === 'accept' ? 'accepted' : 'declined', replayed,
      ...(action === 'accept' ? { organization_id: row.organization_id, role: row.role, entry_target: target ?? `/o/${row.organization_id}` } : {}) })
    // Replays never restore removed membership or update the role/account.
    if (action === 'accept' && row.accepted_user_id === actor.user!.id && row.accepted_at
      || action === 'decline' && row.bound_user_id === actor.user!.id && row.declined_at) return c.json(response(true))
    await eligible(row, actor, false)
    if (action === 'accept' && !(await kernel.identity.readProfile(env.DB, config, actor.user!.id)).completeness.complete) throw new ApiError(409, 'profile_incomplete')
    const now = nowISO()
    const provision = action === 'accept' ? await accountProvisioning(env, config, actor.user!, row.organization_id, row.role, now, 'invalid_invitation_role') : []
    const scope = await accountScope(actor, row.organization_id, row.role, c.get('correlationId'))
    // Acceptance consumes the stored grant; the recipient never grants themselves
    // authority. Recheck the original issuer's live membership in the claim SQL.
    let grant: { sql: string; values: import("../../../core/src/execution/types").SqlValue[] } = action === 'accept' ? issuerGuard(config, { ...scope, actor: { type: 'user', id: row.inviter_id } }, undefined, row.role) : { sql: '1', values: [] }
    if (action === 'accept' && row.target_entity) {
      const membership = await env.DB.prepare('SELECT role FROM memberships WHERE organization_id=? AND user_id=?').bind(row.organization_id, row.inviter_id).first<{ role: string }>()
      if (!membership || row.role !== 'member') throw new ApiError(403, 'permission_denied')
      const issuerScope = { ...scope, actor: { type: 'user' as const, id: row.inviter_id }, role: membership.role }
      await loadActorProjection(config, issuerScope, (sql, bindings) => env.DB.prepare(sql).bind(...bindings).first())
      grant = rowInvitationGuard(config, issuerScope, { entity: row.target_entity, row: row.target_row! })
    }
    const dev = devLocalIdentityEnabled(env, c.req.raw)
    const provider = await requireVerifiedSession(actor, env.DB)
    try {
      await execute(scope, `invitations/${action}`, 'invitations.accept', {
        rules: [organizationRule('invitation_recipient_once', ...provision, {
          sql: `UPDATE invitations SET ${action === 'accept' ? 'accepted_at=?,accepted_user_id=?,' : 'declined_at=?,'}bound_user_id=?
            WHERE id=? AND token_hash=? AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND expires_at>?
            AND (bound_user_id IS NULL OR bound_user_id=?)
            AND role=? AND inviter_id=? AND ${grant.sql}
            AND EXISTS (SELECT 1 FROM "user" WHERE id=? AND lower(email)=lower(trim(invitations.email)) AND (?=1 OR "emailVerified"=1))
            AND (?=1 OR NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id=invitations.organization_id AND user_id=?))
            AND ${config.account?.entity === 'users' ? 'NOT EXISTS (SELECT 1 FROM users account WHERE account.id=? AND account.organization_id<>invitations.organization_id)' : '1'}
            AND (?=0 OR EXISTS (SELECT 1 FROM identity_profiles p WHERE p.user_id=? AND length(trim(p.first_name))>0 AND length(trim(p.last_name))>0
              AND (NOT EXISTS (SELECT 1 FROM identities WHERE user_id=p.user_id AND provider<>'local') OR (p.synced_at IS NOT NULL
                AND (SELECT count(*) FROM identities WHERE user_id=p.user_id AND provider<>'local')=1
                AND EXISTS (SELECT 1 FROM identities WHERE user_id=p.user_id AND provider=p.source_provider AND issuer=p.source_issuer AND subject=p.source_subject)))))`,
          bindings: [...(action === 'accept' ? [now, actor.user!.id] : [now]), actor.user!.id, row.id, row.token_hash, now,
            actor.user!.id, row.role, row.inviter_id, ...grant.values, actor.user!.id, dev || provider ? 1 : 0, row.target_entity ? 1 : 0, actor.user!.id, ...(config.account?.entity === 'users' ? [actor.user!.id] : []), action === 'accept' ? 1 : 0, actor.user!.id],
        }), ...(action === 'accept' ? [{ name: 'invitation_membership', statements: [{
          sql: 'INSERT INTO memberships (user_id,organization_id,role) SELECT ?,organization_id,role FROM invitations WHERE id=? AND accepted_user_id=? AND accepted_at=? AND NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id=invitations.organization_id AND user_id=?)',
          bindings: [actor.user!.id, row.id, actor.user!.id, now, actor.user!.id],
          expectRows: row.target_entity ? undefined : 1 as const,
        }] }] : []), ...(action === 'accept' ? invitationAccountLink({ config, scope, now }, { entity: row.target_entity, row: row.target_row }, actor.user!.id) : [])],
        event: { operation: `invitation.${action === 'accept' ? 'accepted' : 'declined'}`, entity: 'invitations', entityId: row.id },
        result: { status: action === 'accept' ? 201 : 200, body: response(false) },
      })
    } catch (error) {
      if (!(error instanceof RuleFailed) || error.code === 'account_already_linked') throw error
      const current = await lookup({ id: row.id }, actor)
      if (action === 'accept' && current.accepted_user_id === actor.user!.id && current.accepted_at
        || action === 'decline' && current.bound_user_id === actor.user!.id && current.declined_at) return c.json(response(true))
      await eligible(current, actor)
      throw new ApiError(409, 'invitation_conflict')
    }
    return c.json(response(false), action === 'accept' ? 201 : 200)
  }
  app.post('/invitations/:invitationId/accept', c => mutate(c, 'accept', true))
  app.post('/invitations/:invitationId/decline', c => mutate(c, 'decline', true))
  app.post('/invitations/accept', c => mutate(c, 'accept', false))
  app.post('/auth/register', c => mutate(c, 'accept', false))
  app.post('/invitations/decline', c => mutate(c, 'decline', false))
}
