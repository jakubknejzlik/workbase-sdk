import { accountProvisioning } from './account-provisioning'
import { sha256 } from './crypto'
import { ApiError } from './errors'
import { RuleFailed } from './execution/errors'
import { kernelFor } from './kernel/registry'
import { validateRole } from './organization-permissions'
import { organizationRule } from './organization-rules'
import { membershipExecutor } from './organizations'
import { scopeOperations } from './scope-operations'
import type { InstanceConfig } from './config'
import type { RuntimeEnv, Scope } from './types'

/** Called by Members' ops-guarded route; never creates an identity or session. */
export async function bootstrapInstanceOwner(config: InstanceConfig, env: RuntimeEnv, ownerEmail: string, correlationId: string) {
  const kernel = kernelFor(config)
  if (!kernel.providers.has('members') || kernel.providers.has('organizations')) throw new ApiError(404, 'not_found')
  const id = await kernel.resolveScopeId(env.DB)
  const role = validateRole(config, config.organizationOwnerRole)
  const signInRequired = { status: 409 as const, body: { error: 'owner_sign_in_required' } }
  const verifiedOwner = () => env.DB.prepare('SELECT id,email FROM "user" WHERE lower(email)=? AND "emailVerified"=1')
    .bind(ownerEmail.toLowerCase()).first<{ id: string; email: string }>()
  const owner = await verifiedOwner()
  if (!owner) return signInRequired
  const key = 'members.bootstrap'
  const command = 'members/bootstrap'
  const requestHash = await sha256(JSON.stringify([owner.id, owner.email.toLowerCase()]))
  // One durable receipt for the instance. Replays never restore a changed grant.
  const replay = async () => {
    const receipt = await env.DB.prepare('SELECT response_json,request_hash FROM idempotency_keys WHERE organization_id=? AND key=? AND command=?')
      .bind(id, key, command).first<{ response_json: string; request_hash: string }>()
    if (!receipt) return null
    if (receipt.request_hash !== requestHash) throw new ApiError(409, 'instance_owner_exists')
    const result = JSON.parse(receipt.response_json) as { body: { organization_id: string; user_id: string; role: string } }
    return { status: 200 as const, body: { ...result.body, replayed: true } }
  }
  const prior = await replay()
  if (prior) return prior
  const hasOwner = () => env.DB.prepare('SELECT 1 FROM memberships WHERE organization_id=? AND role=?').bind(id, role).first()
  if (await hasOwner()) throw new ApiError(409, 'instance_owner_exists')
  const scope: Scope = { actor: { type: 'service', id: 'instance-owner-bootstrapper' }, organizationId: id, role: '', correlationId }
  scopeOperations.set(scope, { operations: [command] })
  const body = { organization_id: id, user_id: owner.id, role, replayed: false }
  try {
    const account = await accountProvisioning(env, config, owner, id, role, new Date().toISOString())
    await membershipExecutor(config, env)(scope, command, 'members.bootstrap', {
      rules: [organizationRule('instance_owner_bootstrap', ...account, {
        sql: `INSERT INTO memberships (user_id,organization_id,role) SELECT ?,?,?
          WHERE EXISTS (SELECT 1 FROM "user" WHERE id=? AND lower(email)=? AND "emailVerified"=1)
          AND NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id=? AND role=?)`,
        bindings: [owner.id, id, role, owner.id, owner.email.toLowerCase(), id, role],
      }), organizationRule('instance_owner_receipt', {
        sql: 'INSERT INTO idempotency_keys (organization_id,key,command,response_json,request_hash) VALUES (?,?,?,?,?)',
        bindings: [id, key, command, JSON.stringify({ status: 201, body }), requestHash],
      })], event: { operation: 'membership.bootstrapped', entity: 'memberships', entityId: owner.id }, result: { status: 201, body },
    })
  } catch (error) {
    const winner = await replay()
    if (winner) return winner
    if (!await verifiedOwner()) return signInRequired
    if (await hasOwner()) throw new ApiError(409, 'instance_owner_exists')
    if (error instanceof RuleFailed || /UNIQUE constraint failed: memberships\./i.test(String(error))) throw new ApiError(409, 'membership_conflict')
    throw error
  }
  return { status: 201 as const, body }
}
