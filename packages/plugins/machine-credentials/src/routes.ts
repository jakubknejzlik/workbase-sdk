import { z } from 'zod'
import { displayIdentity } from '../../identity/src/display-identity'
import type { App, AppContext, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig, OrganizationAction } from '@workbasehq/core/config'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { scopeMiddleware } from '../../../core/src/authorization'
import { organizationPermission, canGrantRole } from '../../../core/src/execution/permissions'
import { membershipExecutor } from '../../../core/src/organizations'
import { issuerGuard, organizationRule } from '../../../core/src/organization-rules'
import { randomToken, ulid, sha256 } from '@workbasehq/core/crypto'
import { ApiError } from '../../../core/src/errors'
import { RuleFailed } from '../../../core/src/execution/errors'

export function machineCredentialRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const roleSchema = z.enum(config.roles as [string, ...string[]])
  const nowISO = () => new Date().toISOString()
  const expirySchema = (maxDays: number) => z.iso.datetime().transform(value => {
    const expires = Date.parse(value); const now = Date.now()
    if (expires <= now || expires > now + maxDays * 86400000) throw new ApiError(400, 'validation_error', undefined, { field: 'expires_at', max_days: maxDays })
    return new Date(value).toISOString()
  })
  const execute = membershipExecutor(config, env)
  const scoped = scopeMiddleware(env, config, kernelFor(config))
  function scopeFor(c: AppContext, action: OrganizationAction) {
    const scope = c.get('scope')
    if (scope.organizationId !== c.req.param('orgId')) throw new ApiError(403, 'organization_forbidden')
    kernelFor(config).resourcePermission(scope, action)
    organizationPermission(config, scope, action)
    return scope
  }
  app.post('/orgs/:orgId/tokens', scoped, async c => {
    const scope = scopeFor(c, 'tokens.create')
    const body = z.strictObject({ name: z.string().trim().min(1).max(200), role: roleSchema, operations: z.array(z.string().regex(/^[a-z][a-z0-9_]*(?:[/.][a-z][a-z0-9_]*)+$/)).max(100).optional(), expires_at: expirySchema(365).optional() }).parse(await c.req.json())
    if (!canGrantRole(config, scope.role, body.role)) throw new ApiError(403, 'role_escalation')
    const id = ulid(); const token = `wb_${randomToken()}`; const prefix = token.slice(0, 11); const now = nowISO()
    const expires = body.expires_at ?? new Date(Date.now() + 7 * 86400000).toISOString(); const guard = issuerGuard(config, scope, 'tokens.create', body.role)
    try {
      await execute(scope, 'tokens/create', 'tokens.create', {
        rules: [organizationRule('access_token_create', {
          sql: `INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,operations,expires_at,created_at)
            SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`,
          bindings: [id, scope.organizationId, scope.actor.id, body.name, await sha256(token), prefix, body.role, body.operations ? JSON.stringify(body.operations) : null, expires, now, ...guard.values],
        })],
        event: { operation: 'access_token.created', entity: 'access_tokens', entityId: id },
        result: { status: 201, body: { id, token, prefix, role: body.role, operations: body.operations ?? null, expires_at: expires } },
      })
    } catch (error) {
      if (error instanceof RuleFailed) throw new ApiError(403, 'permission_denied')
      throw error
    }
    c.header('Cache-Control', 'no-store')
    return c.json({ id, token, prefix, role: body.role, operations: body.operations ?? null, expires_at: expires }, 201)
  })
  app.get('/orgs/:orgId/tokens', scoped, async c => {
    const scope = scopeFor(c, 'tokens.read')
    c.header('Cache-Control', 'no-store')
    // One joined lookup for the entire authorized collection, never one profile
    // request per token. Keep private identity fields out of the response.
    const result = await env.DB.prepare(`SELECT t.id,t.name,t.prefix,t.role,t.operations,t.expires_at,t.revoked_at,t.last_used_at,t.created_at,
      u.name AS issuer_name,a.email AS issuer_email,
      EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id=t.organization_id AND m.user_id=t.issuer_id) AS issuer_active
      FROM access_tokens t LEFT JOIN users a ON a.id=t.issuer_id LEFT JOIN "user" u ON u.id=t.issuer_id
      WHERE t.organization_id=? ORDER BY t.id`).bind(scope.organizationId)
      .all<{ operations: string | null; issuer_active: number; issuer_name: string | null; issuer_email: string | null }>()
    return c.json({ data: result.results.map(({ issuer_name, issuer_email, ...row }) => {
      const display = displayIdentity({ name: issuer_name, email: issuer_email }).displayName
      return { ...row, operations: row.operations === null ? null : JSON.parse(row.operations), issuer_active: Boolean(row.issuer_active), issuer: display ? { display_name: display } : null }
    }) })
  })
  app.delete('/orgs/:orgId/tokens/:tokenId', scoped, async c => {
    const scope = scopeFor(c, 'tokens.revoke'); const id = c.req.param('tokenId'); const guard = issuerGuard(config, scope, 'tokens.revoke')
    await execute(scope, 'tokens/revoke', 'tokens.revoke', {
      rules: [organizationRule('access_token_revoke', {
        sql: `UPDATE access_tokens SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL AND ${guard.sql}`,
        bindings: [nowISO(), id, scope.organizationId, ...guard.values],
      })],
      event: { operation: 'access_token.revoked', entity: 'access_tokens', entityId: id },
      result: { status: 204, body: {} }, conflict: 'token_conflict',
    })
    return c.body(null, 204)
  })
}
