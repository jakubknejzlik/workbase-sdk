import type { KernelRegistry } from './kernel/registry'
import { isBuiltinPlugin } from './kernel/builtin-source'

export type AccessKernel = Pick<KernelRegistry, 'config' | 'plugins' | 'providers' | 'permissionsActive' | 'authorizationTrust'>
/** Snapshot declarative inputs from the same composed objects enforcement reads.
 * Account/issuer helpers and opaque plugin ports retain their existing contracts;
 * moving those into the grant compiler would change its execution boundary.
 * No grants or predicates are recompiled here. Executable bodies remain opaque.
 */
export function enforcementInputs(kernel: AccessKernel) {
  const { config } = kernel
  const identity = (plugin: KernelRegistry['plugins'][number]) => ({ name: plugin.name, version: plugin.version })
  return {
    authorization: { trust: kernel.authorizationTrust, permissionsActive: kernel.permissionsActive,
      providers: Object.fromEntries([...kernel.providers].map(([contract, plugins]) => [contract, plugins.map(identity).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)])) },
    plugins: [...kernel.plugins].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(plugin => ({ ...identity(plugin),
      builtin: isBuiltinPlugin(plugin), authorization: !!plugin.authorization, policyInConfig: !!plugin.policyInConfig,
      hooks: (['tableFilter', 'fieldMask', 'commandGuard'] as const).filter(hook => plugin[hook]),
    })),
    account: config.account ?? null, organizationOwnerRole: config.organizationOwnerRole,
    // Compatibility projections are also read by live issuer guards/receipts.
    roles: [...config.roles].sort(), permissions: config.permissions, policies: config.policies, organizationPermissions: config.organizationPermissions,
    entities: Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, {
      commandsOnly: !!entity.commandsOnly, relations: entity.relations,
      fields: Object.fromEntries(Object.entries(entity.fields).map(([field, definition]) => [field, {
        type: definition.type, entity: definition.entity, computed: definition.computed,
        readOnly: !!definition.readOnly, sensitive: !!definition.sensitive, userLink: !!definition.userLink,
        values: definition.values ? [...definition.values].sort() : undefined,
      }])),
    }])),
  }
}
