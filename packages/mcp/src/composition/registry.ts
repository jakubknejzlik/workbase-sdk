import { z } from 'zod'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { permissions } from '@workbasehq/plugins/permissions'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { audit } from '@workbasehq/plugins/audit'
import { consoleUI } from '@workbasehq/plugins/console'
import { identifier, identityOptionsSchema, organizationsOptionsSchema, localAuthOptionsSchema } from '../schemas.ts'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { WorkbasePlugin } from '@workbasehq/core/plugins'

export const permissionsOptionsSchema = z.strictObject({ roles: z.array(identifier).min(1), ownerRole: identifier })
export type CompositionConfig = Pick<InstanceConfig, 'roles' | 'organizationOwnerRole'>
export type PluginName = 'identity' | 'members' | 'organizations' | 'permissions' | 'local-auth' | 'machine-credentials' | 'mail-outbox' | 'audit' | 'console'
export interface RuntimePlugin { plugin: PluginName; options?: unknown }
interface Entry {
  factory: string
  singleton?: string
  options?: z.ZodType
  hydrate(options: unknown): WorkbasePlugin
}
/** Closed built-in inventory; insertion order is the standalone template's import order. */
export const pluginRegistry: Record<PluginName, Entry> = {
  identity: { factory: 'createIdentity', singleton: 'identity', options: identityOptionsSchema, hydrate: options => createIdentity(options as Parameters<typeof createIdentity>[0]) },
  members: { factory: 'createMembers', singleton: 'members', hydrate: () => createMembers() },
  organizations: { factory: 'createOrganizations', singleton: 'organizations', options: organizationsOptionsSchema, hydrate: options => createOrganizations(options as Parameters<typeof createOrganizations>[0]) },
  permissions: { factory: 'permissions', options: permissionsOptionsSchema, hydrate: options => permissions(options as Parameters<typeof permissions>[0]) },
  'local-auth': { factory: 'createLocalAuth', singleton: 'localAuth', options: localAuthOptionsSchema, hydrate: options => createLocalAuth(options as Parameters<typeof createLocalAuth>[0]) },
  'machine-credentials': { factory: 'machineCredentials', hydrate: () => machineCredentials() },
  'mail-outbox': { factory: 'mailOutbox', hydrate: () => mailOutbox() },
  audit: { factory: 'audit', hydrate: () => audit() },
  console: { factory: 'consoleUI', hydrate: () => consoleUI() },
}
export const pluginOrder: readonly PluginName[] = ['identity', 'permissions', 'members', 'organizations', 'local-auth', 'machine-credentials', 'mail-outbox', 'audit', 'console']
export const importOrder = Object.keys(pluginRegistry) as PluginName[]
export function permissionOptions(config: CompositionConfig) {
  return { roles: [...config.roles], ownerRole: config.organizationOwnerRole }
}
export function parsePluginOptions(plugin: PluginName, options: unknown): unknown {
  const entry = pluginRegistry[plugin]
  if (!entry) throw new Error('Unknown built-in plugin')
  if (options === undefined && plugin !== 'permissions') return undefined
  if (!entry.options) {
    if (options !== undefined) throw new Error(`${plugin} does not accept options`)
    return undefined
  }
  return JSON.parse(JSON.stringify(entry.options.parse(options)))
}
export function hydrateRuntimePlugins(model: { plugins: readonly RuntimePlugin[] }, config: CompositionConfig): WorkbasePlugin[] {
  return model.plugins.map(({ plugin, options }) => {
    const parsed = parsePluginOptions(plugin, plugin === 'permissions' ? permissionOptions(config) : options)
    return pluginRegistry[plugin].hydrate(parsed)
  })
}
