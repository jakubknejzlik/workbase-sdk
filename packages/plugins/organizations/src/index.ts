import { migrations } from './migrations/index'
import { z } from 'zod'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { organizationRoutes } from './routes'

export const organizations: WorkbasePlugin = builtinPlugin({
  name: 'organizations', version: '0.1.0', provides: { organizations: '1.x' }, requires: { identity: '^1' },
  optionalRequires: { console: '^1' },
  contributes: { console: {
    pages: [{ id: 'organizations.settings', path: '/settings/workspace-settings', label: 'organizationSettings', grant: 'organizations.update', renderer: 'organizations.settings' }],
    navigation: [{ id: 'organizations.settings', placement: 'settings', page: 'organizations.settings', label: 'organizationSettings', order: 20, grant: 'organizations.update' }],
  } },
  configSchema: z.strictObject({ allowCreate: z.boolean().default(true) }).default({ allowCreate: true }),
  // The legacy organizations table also backs domain FKs. Adoption is an identity
  // mapping: scope IDs, domain references and pending invitation keys stay stable.
  migrations,
  async checkSchema(db) { await db.prepare('SELECT scope_id FROM organization_scopes LIMIT 0').all() },
  async resolveScopeId(db, selected) {
    if (!selected) return null
    // Members seeds this reserved scope even in multi-tenant databases. Keep
    // populated single-tenant upgrades usable, but never resolve the empty artifact.
    const row = await db.prepare(`SELECT scope_id FROM organization_scopes WHERE scope_id=?
      AND (scope_id<>'instance' OR EXISTS (
        SELECT 1 FROM memberships WHERE organization_id=organization_scopes.scope_id
      ))`).bind(selected).first<{ scope_id: string }>()
    return row?.scope_id ?? null
  },
  routes: organizationRoutes,
})

export interface OrganizationsOptions { allowCreate?: boolean }
/** Explicit factory; organizations remains the compatibility descriptor. */
export function createOrganizations(options?: OrganizationsOptions): WorkbasePlugin {
  const configuration = Object.freeze(organizations.configSchema!.parse(options))
  return builtinPlugin({ ...organizations, configuration, configSchema: organizations.configSchema!.default(configuration) })
}
