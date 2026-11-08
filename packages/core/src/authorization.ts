import { loadActorProjection, type ActorMembership } from './policies'
import { scopeOperations } from './scope-operations'
import { kernelFor, type KernelRegistry } from './kernel/registry'
import type { MiddlewareHandler } from 'hono'
import type { InstanceConfig } from './config'
import { ulid } from './crypto'
import { ApiError } from './errors'
import type { Actor, AppEnv, RuntimeEnv, Scope } from './types'
import { timed, databaseIdentity } from './request-timing'

/** Compatibility helper bound to the installed login providers. */
export async function resolveActor(request: Request, env: RuntimeEnv, config?: InstanceConfig): Promise<ResolvedActor> {
  if (!config) throw new Error('A bound instance config is required to resolve an actor')
  return kernelFor(config).requireActor(request, env)
}

export interface AvailableOrganization { id: string; name: string; role: string }
export interface ResolvedActor {
  actor: Actor
  user: { id: string; email: string; name?: string } | null
  organizations: AvailableOrganization[]
}
/** Internal login proof: only a trusted adapter can construct one. The optional
 * SQL predicate correlates the session to memberships alias m in the same read. */
export interface LoginSessionProof {
  valid(): Promise<boolean>
  verified(): Promise<boolean>
  recipientVerification: 'local-profile' | 'provider'
  membershipCondition?(now: string): { sql: string; bindings: unknown[] }
}
interface Verification { env: RuntimeEnv; hash: string; session?: LoginSessionProof }
/** Internal provider seam. Proof is retained privately and rechecked on every scoped use. */
export function sealActor(result: ResolvedActor, verification: Verification): ResolvedActor {
  Object.freeze(result.actor)
  if (result.user) Object.freeze(result.user)
  result.organizations.forEach(Object.freeze)
  Object.freeze(result.organizations)
  Object.freeze(result)
  verified.set(result, verification)
  return result
}
// Runtime provenance prevents a JSON object or client-supplied identity from becoming an authority.
const verified = new WeakMap<ResolvedActor, Verification>()
interface TokenRow { id: string; organization_id: string; role: string; operations: string | null; name: string }
const tokenQuery = `SELECT t.id,t.organization_id,t.role,t.operations,o.name FROM access_tokens t JOIN organizations o ON o.id=t.organization_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`
/** Client-supplied identity/org is a selector, never an authority. Call for each execution; do not cache scopes. */
export async function requireScope(actor: ResolvedActor, organizationId: string, config?: InstanceConfig, correlationId = ulid(), operation?: string): Promise<Scope> {
  const verification = verified.get(actor)
  if (!verification) throw new ApiError(401, 'unverified_actor')
  const { env, hash } = verification
  const now = new Date().toISOString()
  if (config) organizationId = await kernelFor(config).resolveScopeId(env.DB, organizationId)
  if (!organizationId) throw new ApiError(403, 'organization_required')
  let role: string; let operations: string[] | null = null
  let membership: ActorMembership | undefined
  if (actor.actor.type === 'agent') {
    const token = await env.DB.prepare(tokenQuery).bind(hash, now).first<TokenRow>()
    if (!token) throw new ApiError(401, 'unauthenticated')
    if (token.organization_id !== organizationId) throw new ApiError(403, 'organization_forbidden')
    role = token.role; operations = token.operations === null ? null : JSON.parse(token.operations)
    const used = await env.DB.batch([env.DB.prepare('UPDATE access_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>?').bind(now, token.id, now)])
    if (used[0].meta.changes !== 1) throw new ApiError(401, 'unauthenticated')
  } else {
    const proof = verification.session
    if (!proof) throw new ApiError(401, 'unauthenticated')
    if (!proof.membershipCondition && !await proof.valid()) throw new ApiError(401, 'unauthenticated')
    const condition = proof.membershipCondition?.(now) ?? { sql: '1=1', bindings: [] }
    const member = await env.DB.prepare(`SELECT m.user_id,m.organization_id,m.role FROM memberships m
      WHERE m.user_id=? AND m.organization_id=? AND (${condition.sql})`).bind(actor.actor.id, organizationId, ...condition.bindings).first<ActorMembership>()
    if (!member) throw new ApiError(403, 'organization_forbidden')
    role = member.role
    membership = member
  }
  const scope: Scope = { organizationId, actor: { ...actor.actor }, role, correlationId }
  if (config) await loadActorProjection(config, scope, (sql, bindings) => env.DB.prepare(sql).bind(...bindings).first(), membership)
  Object.freeze(scope.actor)
  Object.freeze(scope)
  scopeOperations.set(scope, { operations })
  if (operation) authorizeOperation(scope, operation)
  return scope
}
/** Check the actual operation on every path. A requireScope bound operation is only
 * an additional preflight; it must never substitute for the operation being executed. */
export function authorizeOperation(scope: Scope, operation: string) {
  const restriction = scopeOperations.get(scope)
  if (!restriction) throw new ApiError(403, 'unverified_scope')
  if (restriction.operations && !restriction.operations.includes(operation)) throw new ApiError(403, 'operation_forbidden')
}
export function scopeMiddleware(env: RuntimeEnv, config?: InstanceConfig, kernel?: KernelRegistry): MiddlewareHandler<AppEnv> {
  kernel ??= config ? kernelFor(config) : undefined
  if (!kernel) throw new Error('A bound kernel is required for scope middleware')
  const selected = kernel
  config = selected.config
  return async (c, next) => {
    const actor = await selected.requireActor(c.req.raw, env)
    if (actor.user) c.set('userId', actor.user.id)
    const org = c.req.param('org') ?? c.req.header('X-Organization-Id') ?? ''
    // A command allowlist contains exact registered names. CRUD uses entity.read/create/update/delete.
    const operation = c.req.path.startsWith('/commands/') ? c.req.path.slice('/commands/'.length) : undefined
    c.set('scope', { organizationId: org, actor: actor.actor, role: '', correlationId: c.get('correlationId') })
    const scope = await timed('scope', () => requireScope(actor, org, config, c.get('correlationId'), operation))
    c.set('resolvedActor', actor)
    c.set('scope', scope)
    if (scope.actor.type === 'agent' && c.req.path.startsWith('/audit/')) authorizeOperation(scope, 'audit.read')
    await timed('handler', next)
  }
}

/** Core-only account scope: creation/acceptance precede membership. Never accept a
 * client role here; callers supply the new owner role or the stored invitation role.
 */
export async function accountScope(actor: ResolvedActor, organizationId: string, role: string, correlationId: string): Promise<Scope> {
  const verification = verified.get(actor)
  if (!verification) throw new ApiError(401, 'unverified_actor')
  if (!actor.user) throw new ApiError(403, 'user_required')
  if (!await verification.session?.valid()) throw new ApiError(401, 'unauthenticated')
  const scope: Scope = Object.freeze({ organizationId, actor: actor.actor, role, correlationId })
  scopeOperations.set(scope, { operations: null })
  return scope
}

export async function requireVerifiedSession(actor: ResolvedActor, db?: D1Database) {
  const verification = verified.get(actor)
  if (!verification || !actor.user || (db && databaseIdentity(verification.env.DB) !== databaseIdentity(db))) throw new ApiError(403, 'verified_session_required')
  const proof = verification.session
  if (!proof || !await proof.verified()) throw new ApiError(403, 'verified_session_required')
  return proof.recipientVerification === 'provider'
}

/** Informational copy only; never an authorization context or capability. */
export function allowedOperations(scope: Scope): string[] | null {
  const restriction = scopeOperations.get(scope)
  if (!restriction) throw new ApiError(403, 'unverified_scope')
  return restriction.operations ? [...restriction.operations] : null
}
