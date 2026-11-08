import { kernelFor } from '../kernel/registry'
import type { InstanceConfig } from '../config'
import type { Scope } from '../identity'
import type { AtomicOperation } from './types'

export { isOrganizationAdministrator, canGrantRole, organizationPermission } from '../organization-permissions'
export function atomicPermission(config: InstanceConfig, scope: Scope, operation: AtomicOperation, input?: unknown) {
  kernelFor(config).atomicPermission(scope, operation, input)
}
