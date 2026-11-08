import { expect, it } from 'vitest'
import { defineInstance, organizationActions } from '@workbasehq/core/config'
import { prepare } from '../src/planning'
import { changeSchema, type Change } from '../src/schemas'

const config = defineInstance({ id: 'roles_demo', revision: 1, roles: ['owner', 'viewer', 'reviewer'],
  entities: { assets: { fields: { name: { type: 'string' } } } },
  permissions: { owner: { assets: ['read'] } }, organizationPermissions: { owner: ['members.update'] },
})
it('175 four strict role change kinds replace grants and start a role empty', () => {
  const changes = [
    { kind: 'add_role', role: 'operator' },
    { kind: 'set_permissions', entity: 'assets', role: 'operator', operations: ['read'] },
    { kind: 'set_organization_permissions', role: 'operator', actions: ['members.update'] },
    { kind: 'set_permissions', entity: 'assets', role: 'operator', operations: [] },
    { kind: 'set_organization_permissions', role: 'operator', actions: [] },
  ]
  for (const change of changes) expect(changeSchema.safeParse(change).success).toBe(true)
  const target = prepare(config, [], changes as Change[]).target
  expect(target.permissions.operator).toEqual({ assets: [] })
  expect(target.organizationPermissions.operator).toEqual([])
  const added = prepare(config, [], [{ kind: 'add_role', role: 'operator' }] as Change[]).target
  expect(added.permissions.operator).toEqual({ assets: [] })
  expect(added.organizationPermissions.operator ?? []).toEqual([])
  expect(prepare(config, [], [{ kind: 'remove_role', role: 'reviewer' }] as Change[]).target.roles).not.toContain('reviewer')
})

it.each([
  { kind: 'add_role', role: 'owner' }, { kind: 'add_role', role: 'member' },
  { kind: 'add_role', role: 'viewer' }, { kind: 'remove_role', role: 'owner' },
  { kind: 'remove_role', role: 'member' }, { kind: 'remove_role', role: 'missing' },
  { kind: 'set_permissions', entity: 'missing', role: 'owner', operations: [] },
  { kind: 'set_permissions', entity: 'assets', role: 'missing', operations: [] },
  { kind: 'set_permissions', entity: 'assets', role: 'owner', operations: ['execute'] },
  { kind: 'set_organization_permissions', role: 'missing', actions: [] },
  { kind: 'set_organization_permissions', role: 'owner', actions: ['members.erase'] },
  { kind: 'add_role', role: 'Uppercase' }, { kind: 'add_role', role: 'operator', permissions: {} },
] as const)('175 rejects invalid role mutation %j', change => {
  expect(() => prepare(config, [], [change] as unknown as Change[])).toThrow()
})
it.each(['permissions', 'organizationPermissions', 'policies', 'navigation', 'managedBy'])('175 remove_role rejects %s references, including empty grants', source => {
  const next = defineInstance({ ...config,
    ...(source === 'permissions' ? { permissions: { ...config.permissions, reviewer: {} } } : {}),
    ...(source === 'organizationPermissions' ? { organizationPermissions: { ...config.organizationPermissions, reviewer: [] } } : {}),
    ...(source === 'policies' ? { policies: { assets: { reviewer: 'none' } } } : {}),
    ...(source === 'navigation' ? { ui: { entities: {}, navigation: { groups: [], items: [{ id: 'assets', entity: 'assets', roles: ['reviewer'] }] } } } : {}),
    ...(source === 'managedBy' ? { account: { entity: 'assets', managedBy: ['reviewer'] } } : {}),
  })
  expect(() => prepare(next, [], [{ kind: 'remove_role', role: 'reviewer' }])).toThrow(expect.objectContaining({ code: 'role_in_use' }))
})
it('175 adding roles before entities/policies uses the evolving role list and only revision SQL', () => {
  const result = prepare(config, [], [
    { kind: 'add_role', role: 'operator' },
    { kind: 'set_policy', entity: 'assets', role: 'operator', policy: 'all' },
    { kind: 'set_permissions', entity: 'assets', role: 'operator', operations: ['read'] },
  ])
  expect(result.sql).not.toMatch(/CREATE|ALTER|DROP|UPDATE|DELETE/)
  expect(result.target.policies.assets.operator).toBe('all')
  expect(result.target.permissions.operator).toEqual({ assets: ['read'] })
})

it('175 MCP organization action schema stays in parity with core without loading core during CLI init', () => {
  expect(changeSchema.parse({ kind: 'set_organization_permissions', role: 'owner', actions: [...organizationActions] })).toEqual({
    kind: 'set_organization_permissions', role: 'owner', actions: [...organizationActions],
  })
})
