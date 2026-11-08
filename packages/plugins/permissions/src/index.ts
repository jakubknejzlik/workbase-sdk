import { z } from 'zod'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { legacyPermissions } from './provider'

const definition = z.strictObject({
  roles: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).refine(roles => new Set(roles).size === roles.length, 'Duplicate role'),
  ownerRole: z.string().default('owner'),
}).refine(value => value.ownerRole === 'owner' || value.roles.includes(value.ownerRole), 'Unknown owner role')
export type PermissionsOptions = z.input<typeof definition>

/** Role definitions and owner rank belong to this provider; Members consumes the projection. */
export function permissions(options?: PermissionsOptions): WorkbasePlugin {
  const defaults = options === undefined ? undefined : definition.parse(options)
  return builtinPlugin({
    ...legacyPermissions, name: 'permissions',
    ...(defaults === undefined ? {} : { configuration: Object.freeze({ ...defaults, roles: Object.freeze([...defaults.roles]) }) }),
    configSchema: defaults === undefined ? definition : definition.default(defaults),
    configure(configuration) {
      const value = definition.parse(configuration)
      return { roles: [...value.roles], organizationOwnerRole: value.ownerRole }
    },
  })
}

export { legacyPermissions } from './provider'
