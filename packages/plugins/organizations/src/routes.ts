import { z } from 'zod'
import { ulid } from '@workbasehq/core/crypto'
import { ApiError } from '../../../core/src/errors'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { accountScope, requireScope } from '../../../core/src/authorization'
import { validateRole } from '../../../core/src/organization-permissions'
import { issuerGuard, organizationRule } from '../../../core/src/organization-rules'
import { RuleFailed } from '../../../core/src/execution/errors'
import { membershipExecutor, organizationCreationRule, provisionOrganization } from '../../../core/src/organizations'
import type { App, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig } from '@workbasehq/core/config'
export function organizationRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const execute = membershipExecutor(config, env)
  app.post('/internal/organizations', async c => {
    c.header('Cache-Control', 'no-store')
    const { name, ownerEmail } = z.strictObject({ name: z.string().trim().min(1).max(200), ownerEmail: z.string().trim().email() }).parse(await c.req.json())
    const result = await provisionOrganization(config, env, name, ownerEmail, c.get('correlationId'))
    return c.json(result.body, result.status)
  })
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
    const rule = await organizationCreationRule(config, env, resolved.user, id, name, ownerRole)
    await execute(scope, 'organizations/create', 'organizations.create', {
      rules: [rule],
      event: { operation: 'organization.created', entity: 'organizations', entityId: id },
      result: { status: 201, body: { id, name, role: ownerRole } },
    })
    return c.json({ id, name, role: ownerRole }, 201)
  })
}
