import { devFixtures } from './dev-support.ts'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { isDeepStrictEqual } from 'node:util'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { tenancy, type WorkbasePlugin } from '@workbasehq/core/plugins'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { consoleUI } from '@workbasehq/plugins/console'
import { permissions, type PermissionsOptions } from '@workbasehq/plugins/permissions'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { audit } from '@workbasehq/plugins/audit'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { fail } from './schemas.ts'

export const agentInstance = devFixtures?.agentInstance ?? 'disposable-agent'
export async function createAgentInstance(root: string) {
  if (!devFixtures) return fail('dev_module_required', 'Agent tests require WORKBASE_MCP_DEV_MODULE')
  return devFixtures.createAgentInstance(root)
}

/** Hydrate only exact canonical descriptors from trusted configuration snapshots. */
export async function hydratePlugins(descriptors?: WorkbasePlugin[]) {
  if (!descriptors) return descriptors
  return Promise.all(descriptors.map(async (descriptor: WorkbasePlugin) => {
    const factories: Partial<Record<string, () => WorkbasePlugin>> = {
      identity: () => createIdentity(descriptor.configuration as Parameters<typeof createIdentity>[0]),
      members: () => createMembers(),
      organizations: () => createOrganizations(descriptor.configuration as Parameters<typeof createOrganizations>[0]),
      'local-auth': () => createLocalAuth(descriptor.configuration as Parameters<typeof createLocalAuth>[0]),
      ...(devFixtures?.sources[descriptor.name] ? { [descriptor.name]: devFixtures.sources[descriptor.name].factory } : {}),
    }
    const factory = factories[descriptor.name]
    const canonical = (factory && (descriptor.configuration !== undefined || !!devFixtures?.sources[descriptor.name]) ? factory() : undefined) ?? [identity, localAuth, tenancy, rbac, members, organizations, permissions(descriptor.configuration as PermissionsOptions | undefined), machineCredentials(), mailOutbox(), consoleUI(), audit()].find(plugin => plugin.name === descriptor.name)
    if (!canonical) fail('invalid_template', `Unknown template plugin: ${descriptor.name}`)
    const { name, version, provides, requires, optionalRequires, configuration } = canonical
    if (!isDeepStrictEqual(descriptor, JSON.parse(JSON.stringify({ name, version, provides, requires, optionalRequires, configuration })))) fail('invalid_template', `Noncanonical template plugin: ${name}`)
    return canonical
  }))
}
