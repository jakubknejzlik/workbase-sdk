import { z } from 'zod'
import { ulid } from '@workbasehq/core/crypto'
import { ApiError } from '../../../core/src/errors'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { accountScope, requireScope } from '../../../core/src/authorization'
import { validateRole } from '../../../core/src/organization-permissions'
import { accountProvisioning } from '../../../core/src/account-provisioning'
import { issuerGuard, organizationRule } from '../../../core/src/organization-rules'
import { RuleFailed } from '../../../core/src/execution/errors'
import { membershipExecutor } from '../../../core/src/organizations'
import type { App, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig } from '@workbasehq/core/config'
export function organizationRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const execute = membershipExecutor(config, env)
  const nowISO = () => new Date().toISOString()
  for (const path of ['/organizations/:orgId', '/orgs/:orgId']) app.patch(path, async c => {
    c.header('Cache-Control', 'no-store')
    const kernel = kernelFor(config)
    const resolved = await kernel.requireActor(c.req.raw, env)
    const scope = await requireScope(resolved, c.req.param('orgId')!, config, c.get('correlationId'))
    kernel.resourcePermission(scope, 'organizations.update')
    const { name } = z.strictObject({ name: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)) }).parse(await c.req.json())
    const result = { id: scope.organizationId, name, invalidates: ['me', 'memberships', 'selectedOrganization'] }
    const guard = issuerGuard(config, scope, 'organizations.update')
    try {
      await execute(scope, 'organizations/update', 'organizations.update', {
        rules: [organizationRule('organization_update', { sql: `UPDATE organizations SET name=? WHERE id=? AND ${guard.sql}`, bindings: [name, scope.organizationId, ...guard.values] })],
        event: { operation: 'organization.renamed', entity: 'organizations', entityId: scope.organizationId }, result: { status: 200, body: result },
      })
    } catch (error) {
      if (error instanceof RuleFailed) throw new ApiError(409, 'organization_conflict')
      throw error
    }
    return c.json(result)
  })
  app.post('/orgs', async c => {
    if (!(config.pluginConfig?.organizations as { allowCreate: boolean }).allowCreate) throw new ApiError(403, 'organization_creation_disabled')
    const resolved = await kernelFor(config).requireActor(c.req.raw, env)
    if (!resolved.user) throw new ApiError(403, 'user_required')
    const { name } = z.strictObject({ name: z.string().trim().min(1).max(200) }).parse(await c.req.json())
    const id = ulid(); const ownerRole = validateRole(config, config.organizationOwnerRole)
    const scope = await accountScope(resolved, id, ownerRole, c.get('correlationId'))
    if (!kernelFor(config).providers.has('members')) throw new ApiError(403, 'members_required')
    const provision = await accountProvisioning(env, config, resolved.user, id, ownerRole, nowISO())
    await execute(scope, 'organizations/create', 'organizations.create', {
      rules: [organizationRule('organization_create',
        { sql: 'INSERT INTO organizations (id,name) VALUES (?,?)', bindings: [id, name] },
        ...provision,
        { sql: 'INSERT INTO memberships (user_id,organization_id,role) SELECT ?,?,? WHERE changes()=1', bindings: [resolved.user.id, id, ownerRole] })],
      event: { operation: 'organization.created', entity: 'organizations', entityId: id },
      result: { status: 201, body: { id, name, role: ownerRole } },
    })
    return c.json({ id, name, role: ownerRole }, 201)
  })
}
