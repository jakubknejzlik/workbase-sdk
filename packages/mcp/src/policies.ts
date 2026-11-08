import type { InstanceConfig } from '@workbasehq/core/config'

/** Loaded configs have expanded shorthand; omitted entity/role pairs still deny all rows. */
export function effectivePolicies(config: InstanceConfig): InstanceConfig['policies'] {
  return Object.fromEntries(Object.keys(config.entities).map(entity => [entity,
    Object.fromEntries(config.roles.map(role => [role, config.policies[entity]?.[role] ?? 'none'])),
  ]))
}
