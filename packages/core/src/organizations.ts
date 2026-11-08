import { authorizeOperation } from './authorization'
import { organizationPermission } from './execution/permissions'
import { ApiError } from './errors'
import { z } from 'zod'
import { coreExecutionContext } from './execution/context'
import { D1AtomicStore, D1AtomicReader } from './execution/d1'
import { executeAtomic, defineAtomicOperation } from './execution/atomic'
import type { InstanceConfig } from './config'
import type { RuntimeEnv, Scope } from './types'
import type { AtomicOperation, AtomicPlan, ExecutionContext } from './execution/types'
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
    if (['members.update', 'organizations.create', 'invitations.accept'].includes(system)) {
      if (context.scope.actor.type !== 'user') throw new ApiError(403, 'field_forbidden')
      if (system === 'members.update') organizationPermission(config, context.scope, system)
      const capability = Object.freeze({ operation, mode: system === 'members.update' ? 'update' as const : 'create' as const })
      memberCapabilities.add(capability)
      memberSlots.set(context, capability)
    }
    return executeAtomic(operation, {}, context)
  }
}
