import type { KernelRegistry } from './kernel/registry'
import { isBuiltinPlugin } from './kernel/builtin-source'
import type { AtomicOperation } from './execution/types'
import { canonical } from './canonical'

export type AccessKernel = Pick<KernelRegistry, 'config' | 'plugins' | 'providers' | 'permissionsActive' | 'authorizationTrust' | 'workflows' | 'workflowRegistrations'>
/** Snapshot selected declarative inputs from the same composed objects enforcement reads.
 * Curated, not exhaustive: see docs/sdk/access-lock.md § Scope for what is not covered.
 * Account/issuer helpers and opaque plugin ports retain their existing contracts;
 * moving those into the grant compiler would change its execution boundary.
 * No grants or predicates are recompiled here. Executable bodies remain opaque.
 */
export function enforcementInputs(kernel: AccessKernel) {
  const { config } = kernel
  const identity = (plugin: KernelRegistry['plugins'][number]) => ({ name: plugin.name, version: plugin.version })
  const permission = (value: AtomicOperation['permission']) => 'system' in value
    ? { system: value.system } : { entity: value.entity, operation: value.operation }
  const operation = (value: AtomicOperation<any>) => ({ name: value.name, permission: permission(value.permission),
    additionalPermissions: (value.additionalPermissions ?? []).map(permission).sort((a, b) => {
      const x = JSON.stringify(canonical(a)); const y = JSON.stringify(canonical(b))
      return x < y ? -1 : x > y ? 1 : 0
    }), opaque: true as const })
  return {
    // Occurrences are distinct even when operations share a command name. This
    // projection never registers guards or changes commandGuard lookup semantics.
    workflows: Object.fromEntries([...kernel.workflows].map(([name, workflow]) => {
      const registration = kernel.workflowRegistrations.get(name)!
      return [name, { version: workflow.version,
        registration: { kind: registration.kind, ...(registration.plugin ? { plugin: registration.plugin } : {}) },
        stepOrder: (workflow.steps ?? []).map(step => step.id),
        steps: Object.fromEntries((workflow.steps ?? []).map(step => [step.id, {
          forward: operation(step.operation), compensation: step.compensate ? operation(step.compensate.operation) : null,
        }])),
      }]
    })),
    authorization: { trust: kernel.authorizationTrust, permissionsActive: kernel.permissionsActive,
      providers: Object.fromEntries([...kernel.providers].map(([contract, plugins]) => [contract, plugins.map(identity).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)])) },
    plugins: [...kernel.plugins].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(plugin => ({ ...identity(plugin),
      builtin: isBuiltinPlugin(plugin), authorization: !!plugin.authorization, policyInConfig: !!plugin.policyInConfig,
      hooks: (['tableFilter', 'fieldMask', 'commandGuard'] as const).filter(hook => plugin[hook]),
    })),
    account: config.account ?? null, organizationOwnerRole: config.organizationOwnerRole,
    // Compatibility projections are also read by live issuer guards/receipts.
    roles: [...config.roles].sort(), permissions: config.permissions, policies: config.policies, organizationPermissions: config.organizationPermissions,
    // labelPath reads this mapping even though the surrounding UI is presentation.
    ui: { entities: Object.fromEntries(Object.entries(config.ui?.entities ?? {}).flatMap(([name, ui]) =>
      ui.list?.relatedColumns ? [[name, { list: { relatedColumns: ui.list.relatedColumns } }]] : [])) },
    entities: Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, {
      commandsOnly: !!entity.commandsOnly, relations: entity.relations,
      // Keep the same normalized selector and structured wire that the runtime
      // expression/label resolvers consume. Ref targets and computed wires below
      // cover subsequent hops; no second dependency or grant compiler is needed.
      ...(entity.displayField ? { displayField: entity.displayField } : {}),
      ...(entity.label ? { label: entity.label.serialize() } : {}),
      fields: Object.fromEntries(Object.entries(entity.fields).map(([field, definition]) => [field, {
        type: definition.type, entity: definition.entity, computed: definition.computed,
        readOnly: !!definition.readOnly, sensitive: !!definition.sensitive, userLink: !!definition.userLink,
        values: definition.values ? [...definition.values].sort() : undefined,
      }])),
    }])),
  }
}
