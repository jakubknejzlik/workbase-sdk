import { requireOrganizationName } from './organization-name'
import { authorizeOperation } from './authorization'
import { organizationPermission } from './execution/permissions'
import { ApiError } from './errors'
import { RuleFailed } from './execution/errors'
import { sha256 } from './crypto'
import { accountProvisioning } from './account-provisioning'
import { validateRole } from './organization-permissions'
import { organizationRule } from './organization-rules'
import { kernelFor } from './kernel/registry'
import { scopeOperations } from './scope-operations'
import { z } from 'zod'
import { coreExecutionContext } from './execution/context'
import { D1AtomicStore, D1AtomicReader } from './execution/d1'
import { executeAtomic, defineAtomicOperation } from './execution/atomic'
import type { InstanceConfig } from './config'
import type { RuntimeEnv, Scope } from './types'
import type { AtomicOperation, AtomicPlan, ExecutionContext, SqlStatement } from './execution/types'
import type { ResolvedActor } from './authorization'
// Only the trusted plugin route executors below can mint these values. Nothing on a
// public context, callback prototype or operation permission grants membership.
const memberCapabilities = new WeakSet<object>()
const memberSlots = new WeakMap<ExecutionContext, Readonly<{ operation: AtomicOperation; mode: 'update' | 'create' }>>()
/** Read-only execution seam; never returns the capability itself. */
export function memberManagementMode(context: ExecutionContext, operation: AtomicOperation): 'update' | 'create' | undefined {
  const capability = memberSlots.get(context)
  return capability && memberCapabilities.has(capability) && capability.operation === operation ? capability.mode : undefined
}

export function meDocument(resolved: ResolvedActor, config: InstanceConfig) {
  const provider = config.plugins?.find(plugin => plugin.provides?.organizations)
  const organizationCreationAllowed = !!provider && (config.pluginConfig?.[provider.name] as { allowCreate?: boolean } | undefined)?.allowCreate !== false
  return { organizationsEnabled: !!provider, organizationCreationAllowed, user: resolved.user, actor: resolved.actor, memberships: resolved.organizations.map(org => ({ organization_id: org.id, name: org.name, role: org.role })) }
}

export function membershipExecutor(config: InstanceConfig, env: RuntimeEnv) {
  // Only core-resolved scopes reach this seam. The HTTP schemas have already
  // validated input; the plan is a synchronous, fully bound SQL description.
  return async function execute(scope: Scope, name: string, system: Extract<AtomicOperation['permission'], { system: string }>['system'], plan: AtomicPlan) {
    authorizeOperation(scope, name)
    const context = coreExecutionContext(config, scope, new D1AtomicStore(env.DB, { env, config }), new D1AtomicReader(env.DB))
    const operation = defineAtomicOperation({ name, permission: { system }, input: z.strictObject({}), plan: () => plan })
    if (['members.update', 'organizations.create', 'organizations.provision', 'members.bootstrap', 'invitations.accept'].includes(system)) {
      if (context.scope.actor.type !== (['organizations.provision', 'members.bootstrap'].includes(system) ? 'service' : 'user')) throw new ApiError(403, 'field_forbidden')
      if (system === 'members.update') organizationPermission(config, context.scope, system)
      const capability = Object.freeze({ operation, mode: system === 'members.update' ? 'update' as const : 'create' as const })
      memberCapabilities.add(capability)
      memberSlots.set(context, capability)
    }
    return executeAtomic(operation, {}, context)
  }
}

/** Shared creation statements: organization, optional domain account, then owner membership. */
export async function organizationCreationRule(config: InstanceConfig, env: RuntimeEnv, owner: { id: string; email: string }, id: string, name: string, role: string, ownerGuard?: SqlStatement) {
  name = requireOrganizationName(name)
  if (!kernelFor(config).providers.has('members')) throw new ApiError(403, 'members_required')
  const provision = await accountProvisioning(env, config, owner, id, role, new Date().toISOString())
  return organizationRule('organization_create',
    { sql: `INSERT INTO organizations (id,name) SELECT ?,?${ownerGuard ? ` WHERE ${ownerGuard.sql}` : ''}`, bindings: [id, name, ...(ownerGuard?.bindings ?? [])] },
    ...provision,
    { sql: 'INSERT INTO memberships (user_id,organization_id,role) SELECT ?,?,? WHERE changes()=1', bindings: [owner.id, id, role] })
}

/** Called only by the ops-guarded organization route; no user session or credential is minted. */
export async function provisionOrganization(config: InstanceConfig, env: RuntimeEnv, name: string, ownerEmail: string, correlationId: string) {
  name = requireOrganizationName(name)
  const signInRequired = { status: 409 as const, body: { error: 'owner_sign_in_required' } }
  const verifiedOwner = () => env.DB.prepare('SELECT id,email FROM "user" WHERE lower(email)=? AND "emailVerified"=1').bind(ownerEmail.toLowerCase()).first<{ id: string; email: string }>()
  const owner = await verifiedOwner()
  // Return this precondition failure directly so the HTTP error logger writes no rows either.
  if (!owner) return signInRequired
  // A stable primary key makes concurrent retries converge without a new table or migration.
  const id = `provision_${await sha256(JSON.stringify([owner.email.toLowerCase(), name]))}`
  const role = validateRole(config, config.organizationOwnerRole)
  const key = 'organizations.provision'
  const requestHash = await sha256(JSON.stringify([owner.id, owner.email.toLowerCase(), name]))
  const replay = async () => {
    const receipt = await env.DB.prepare('SELECT response_json,request_hash FROM idempotency_keys WHERE organization_id=? AND key=? AND command=?')
      .bind(id, key, 'organizations/provision').first<{ response_json: string; request_hash: string }>()
    if (!receipt) return null
    if (receipt.request_hash !== requestHash) throw new ApiError(409, 'organization_conflict')
    const result = JSON.parse(receipt.response_json) as { body: { id: string; name: string; role: string } }
    return { status: 200 as const, body: { id: result.body.id, name: result.body.name, role: result.body.role, replayed: true } }
  }
  const prior = await replay()
  if (prior) return prior
  const scope: Scope = { actor: { type: 'service', id: 'organization-provisioner' }, organizationId: id, role: '', correlationId }
  scopeOperations.set(scope, { operations: ['organizations/provision'] })
  const body = { id, name, role, replayed: false }
  try {
    const rule = await organizationCreationRule(config, env, owner, id, name, role, {
      sql: 'EXISTS (SELECT 1 FROM "user" WHERE id=? AND lower(email)=? AND "emailVerified"=1)', bindings: [owner.id, owner.email.toLowerCase()],
    })
    await membershipExecutor(config, env)(scope, 'organizations/provision', 'organizations.provision', {
      // Persist the receipt in the same batch, independent of later tenant mutations.
      rules: [rule, organizationRule('organization_provision_receipt', {
        sql: 'INSERT INTO idempotency_keys (organization_id,key,command,response_json,request_hash) VALUES (?,?,?,?,?)',
        bindings: [id, key, 'organizations/provision', JSON.stringify({ status: 201, body }), requestHash],
      })], event: { operation: 'organization.provisioned', entity: 'organizations', entityId: id }, result: { status: 201, body },
    })
  } catch (error) {
    const winner = await replay()
    if (winner) return winner
    if (!await verifiedOwner()) return signInRequired
    // A concurrent assignment must preserve the same single-account conflict as the preflight.
    await accountProvisioning(env, config, owner, id, role, new Date().toISOString())
    // Rule diagnostics are internal; the public contract is a fixed conflict.
    if (error instanceof RuleFailed) throw new ApiError(409, 'organization_conflict')
    throw error
  }
  return { status: 201 as const, body }
}
