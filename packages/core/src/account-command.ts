import type { InstanceConfig } from './config'

// Data-only names shared by build-time projection and runtime command adapters.
export const accountActionNames = ['invite', 'cancel_invite', 'link_account', 'unlink_account'] as const
export const accountCommand = (entity: string, action: string) => `${entity}/access_${action}`
export function isAccountAccessCommand(config: InstanceConfig, name: string) {
  return Object.keys(config.effectiveAccess?.accountLinks ?? {}).some(entity => accountActionNames.some(action => name === accountCommand(entity, action)))
}
