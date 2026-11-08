import { expect, it } from 'vitest'
import { defineInstance, organizationActions, type InstanceInput } from '../src/config'
import { permissions } from '../../plugins/permissions/src/index'
import type { WorkbasePlugin } from '../src/kernel/plugin'

const roles = ['owner', 'dispatcher', 'viewer']
const plugin: WorkbasePlugin = { ...permissions({ roles }), configure: () => ({ organizationPermissions: { dispatcher: ['members.read'] } }) }
const input = { id: 'permission_matrix', revision: 1, interactive: false, roles, entities: {}, permissions: {}, plugins: [plugin] }

it.each<{ name: string; grants?: InstanceInput['organizationPermissions']; x: string[]; y: string[] }>([
  { name: 'plugin only', x: ['members.read'], y: [] },
  { name: 'explicit empty list denies', grants: { dispatcher: [] }, x: [], y: [] },
  { name: 'top-level other role only', grants: { viewer: ['tokens.read'] }, x: ['members.read'], y: ['tokens.read'] },
  { name: 'both roles explicit', grants: { dispatcher: ['tokens.revoke'], viewer: ['tokens.read'] }, x: ['tokens.revoke'], y: ['tokens.read'] },
])('resolves organization permissions per role: $name', ({ grants, x, y }) => {
  expect(defineInstance({ ...input, ...(grants ? { organizationPermissions: grants } : {}) }).organizationPermissions).toEqual({
    owner: [...organizationActions], dispatcher: x, viewer: y,
  })
})

it('rejects two configuring permissions providers for the same role', () => {
  expect(() => defineInstance({ ...input, plugins: [{ ...plugin, name: 'first' }, { ...plugin, name: 'second' }] })).toThrow('Duplicate provider for permissions')
})

it('lets configured grants replace model grants for a role in either plugin order', () => {
  const model: WorkbasePlugin = { name: 'model-grants', version: '1.0.0', model: { organizationPermissions: { dispatcher: ['tokens.read'] } } }
  for (const plugins of [[model, plugin], [plugin, model]]) {
    expect(defineInstance({ ...input, plugins }).organizationPermissions).toEqual({ owner: [...organizationActions], dispatcher: ['members.read'], viewer: [] })
  }
})
