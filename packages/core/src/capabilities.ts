import type { KernelRegistry } from './kernel/registry'
import type { App, RuntimeEnv, Scope } from './types'
import { scopeMiddleware } from './authorization'
import { ApiError } from './errors'
import { writableFields } from './policies'
import { hasOwnerRole } from './policies'
import { organizationPermission } from './execution/permissions'

/** Projection of the live authorization ports; never serialize their predicates. */
export function capabilities(kernel: KernelRegistry, scope: Scope) {
  function permits(check: () => void) {
    try { check(); return true } catch (error) { if (error instanceof ApiError && [403, 405].includes(error.status)) return false; throw error }
  }
  const entities = Object.fromEntries(Object.entries(kernel.config.entities).map(([name, entity]) => [name, {
    readable: kernel.fieldMask(name, scope), writable: writableFields(kernel.config, name, scope),
    operations: (['read', 'create', 'update', 'delete'] as const).filter(operation => (operation === 'read' || !entity.commandsOnly) && kernel.tableFilter(name, scope).kind !== 'none' && kernel.can(scope, name, operation)),
    ...(entity.displayField && kernel.fieldMask(name, scope).includes(entity.displayField) ? { displayField: entity.displayField } : {}),
  }]))
  const commands = [...kernel.commands.values()].filter(command => kernel.config.commands.includes(command.name) && !('system' in command.permission) && permits(() => kernel.atomicPermission(scope, command))).map(command => command.name)
  const workflows = Object.fromEntries([...kernel.workflows.values()].map(workflow => [workflow.name, [
    ...(permits(() => { for (const step of workflow.steps ?? []) kernel.atomicPermission(scope, step.operation) }) ? ['start' as const] : []),
    ...(['cancel', 'resume'] as const).filter(action => permits(() => kernel.resourcePermission(scope, `workflows.${action}`))),
  ]]))
  // Match the read routes' complete gates, including their identity/owner checks.
  // Navigation needs grants, not whole member/token/workflow/audit collections.
  const resources = {
    'organizations.update': kernel.providers.has('organizations') && kernel.permissionsActive && permits(() => kernel.resourcePermission(scope, 'organizations.update')),
    ...Object.fromEntries((['members.read', 'members.update', 'members.remove', 'invitations.read', 'invitations.create', 'invitations.revoke', 'tokens.read'] as const).map(action => [action,
      permits(() => { kernel.resourcePermission(scope, action); organizationPermission(kernel.config, scope, action) }),
    ])),
    ...Object.fromEntries((['tokens.create', 'tokens.revoke'] as const).map(action => [action,
      permits(() => { kernel.resourcePermission(scope, action); organizationPermission(kernel.config, scope, action) }),
    ])),
    'workflows.read': permits(() => kernel.resourcePermission(scope, 'workflows.read')),
    'audit.read': !!kernel.audit && hasOwnerRole(scope, kernel.config) && permits(() => kernel.resourcePermission(scope, 'audit.read')),
  }
  return { revision: kernel.config.revision, entities, commands, workflows, resources, organization: { role: scope.role } }
}
export function capabilityRoutes(app: App, kernel: KernelRegistry, env: RuntimeEnv) {
  app.get('/o/:org/capabilities', scopeMiddleware(env, kernel.config, kernel), c => c.json(capabilities(kernel, c.get('scope'))))
}
