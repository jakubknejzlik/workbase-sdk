import { describe, expect, it } from 'vitest'
import { defineInstance, type InstanceInput } from '../src/config'
import { expand, type ShorthandInput } from '../src/config-shorthand'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { policyFilter } from '../src/policies'
import type { Scope } from '../src/types'
import sample from './fixtures/sample/config'
import accounts from './fixtures/accounts/config'
import { sampleDx, accountsDx } from './fixtures/shorthand'

// Only object keys are sorted. Arrays are ordered data, and functions are forbidden.
function normalize(value: unknown): unknown {
  expect(typeof value).not.toBe('function')
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]))
  return value
}
const minimal = (): ShorthandInput => ({ id: 'dx', revision: 1, roles: ['owner', 'viewer'], entities: { clients: { fields: { name: 'string!' } } }, permissions: { owner: { '*': 'all' }, viewer: { '*': 'read' } } })
const unsafe = (value: unknown) => value as ShorthandInput

describe('one additive configuration grammar', () => {
  for (const [name, canonical, shorthand] of [['sample', sample, sampleDx], ['accounts', accounts, accountsDx]] as const) {
    it(`${name}: canonical input is unchanged, including array order`, () => {
      expect(expand(canonical)).toEqual(canonical)
      expect(expand(expand(canonical))).toEqual(canonical)
      normalize({ ...canonical, plugins: canonical.plugins?.map(plugin => plugin.name) })
    })
    it(`${name}: shorthand through defineInstance equals the live canonical revision`, () => {
      // A derived canonical fixture explicitly declares an all policy for every
      // parsed role; the shorthand omits the new member policy. Both grant no
      // member operations. Compare existing role policies byte-for-byte.
      const existing = (config: typeof canonical) => ({ ...config, policies: Object.fromEntries(Object.entries(config.policies).map(([entity, roles]) => [entity, Object.fromEntries(Object.entries(roles).filter(([role]) => role !== 'member'))])) })
      expect(normalize({ ...existing(defineInstance(shorthand)), plugins: shorthand.plugins?.map(plugin => plugin.name) })).toEqual(normalize({ ...existing(canonical), plugins: canonical.plugins?.map(plugin => plugin.name) }))
      expect(expand(expand(shorthand))).toEqual(expand(shorthand))
    })
  }
  it('the parity normalizer retains array order and rejects functions', () => {
    expect(normalize({ b: [2, 1], a: 1 })).toEqual({ a: 1, b: [2, 1] })
    expect(() => normalize({ nested: [() => 1] })).toThrow()
  })
  it('supports scalar/ref/enum tokens and relation directions with canonical options', () => {
    const input = minimal()
    input.enums = { state: ['open', 'closed'] }
    input.entities.jobs = { displayField: 'state', fields: { client_id: 'ref:clients!', state: 'enum:state!', count: { type: 'int', min: 1, default: 1, readOnly: true } }, relations: { client: 'clients@client_id' } }
    input.entities.clients.relations = { jobs: 'jobs@client_id[]' }
    const config = defineInstance(input)
    expect(config.entities.jobs.fields.client_id).toEqual({ type: 'ref', entity: 'clients', required: true })
    expect(config.entities.jobs.fields.state.values).toEqual(['open', 'closed'])
    expect(config.entities.jobs.relations.client).toEqual({ entity: 'clients', field: 'client_id' })
    expect(config.entities.clients.relations.jobs).toEqual({ entity: 'jobs', field: 'client_id', many: true })
    expect(config.entities.jobs.fields.count).toMatchObject({ min: 1, default: 1, readOnly: true })
    expect(config.entities.clients.displayField).toBe('name')
    expect(config.entities.jobs.displayField).toBe('state')
  })
  it('canonical partial policies and omitted displayField are unchanged', () => {
    const input: InstanceInput = { id: 'canonical', revision: 1, roles: ['owner'], entities: { clients: { fields: { name: { type: 'string' } } } }, permissions: { owner: {} } }
    expect(expand(input)).toEqual(input)
    expect(expand(input).entities.clients.displayField).toBeUndefined()
  })
  it('title is the second display default, and an explicit value wins', () => {
    const input = minimal(); input.entities.clients = { displayField: 'code', fields: { title: 'text!', code: 'string' } }
    expect(defineInstance(input).entities.clients.displayField).toBe('code')
    delete input.entities.clients.displayField
    expect(defineInstance(input).entities.clients.displayField).toBe('title')
  })
  it('an explicit false display default cannot bypass the display-field gate', () => {
    const input = minimal(); input.entities.clients.displayField = false
    expect(() => defineInstance(input)).toThrow('Invalid displayField: clients')
  })
  it('canonical invalid-role errors keep their existing behavior', () => {
    const input: InstanceInput = { id: 'canonical', revision: 1, roles: ['owner'], entities: {}, permissions: { missing: {} } }
    expect(() => defineInstance(input)).toThrow('Unknown role missing')
  })
  it('does not mutate input, enums, policy scopes or canonical field options', () => {
    const input = minimal(); const before = structuredClone(input)
    expand(input)
    expect(input).toEqual(before)
  })
  for (const [token, expected] of [['strng!', 'clients.name'], ['ref:missing!', 'clients.name'], ['enum:missing', 'clients.name']] as const) {
    it(`rejects unknown field token or target ${token}`, () => {
      const input = minimal(); input.entities.clients.fields.name = unsafe(token) as never
      expect(() => defineInstance(input)).toThrow(expected)
    })
  }
  for (const relation of ['missing@name', 'clients@missing', 'clients@name', 'clients.missing']) {
    it(`rejects invalid shorthand relation ${relation}`, () => {
      const input = minimal(); input.entities.clients.relations = unsafe({ broken: relation }) as never
      expect(() => defineInstance(input)).toThrow('clients.broken')
    })
  }
  it('canonical schema still rejects invalid field options through the public entry', () => {
    const input = minimal(); input.entities.clients.fields.name = { type: 'string', min: 1 }
    expect(() => defineInstance(input)).toThrow('min requires a numeric field')
  })
})

describe('permission expansion is explicit and fail closed', () => {
  for (const reverse of [false, true]) it(`explicit narrower grant wins in either declaration order (${reverse})`, () => {
    const input = minimal()
    input.permissions = [{ role: 'owner', entity: '*', operations: 'all' }, { role: 'owner', entity: 'clients', operations: 'read' }]
    if (reverse) input.permissions.reverse()
    expect(defineInstance(input).permissions.owner.clients).toEqual(['read'])
  })
  it('wildcards capture entities added later, preserving operation and role order', () => {
    const input = minimal(); input.entities.jobs = { fields: { title: 'string!' } }
    const config = defineInstance(input)
    expect(config.roles).toEqual(['owner', 'viewer', 'member'])
    expect(config.permissions.member).toBeUndefined()
    expect(config.permissions.owner.jobs).toEqual(['read', 'create', 'update', 'delete'])
    expect(config.permissions.viewer.jobs).toEqual(['read'])
  })
  it('F4 role wildcards capture later roles, with none policies', () => {
    const input = minimal(); input.permissions = { '*': { '*': 'all' } }; input.roles.push('later')
    const config = defineInstance(input)
    expect(config.permissions.later.clients).toEqual(['read', 'create', 'update', 'delete'])
    expect(config.policies.clients.later).toBe('none')
    const scope: Scope = { actor: { type: 'user', id: 'actor' }, role: 'later', organizationId: 'org', correlationId: 'role-capture' }
    expect(policyFilter(config, 'clients', scope)).toEqual({ kind: 'none' })
    for (const operation of ['create', 'update', 'delete'] as const) {
      expect(rbac.commandGuard!.call({ config }, { name: operation, kind: 'entity', permission: { entity: 'clients', operation } }, scope, {})).toEqual({ allow: false, code: 'permission_denied' })
    }
  })
  it('operation * is all and canonical operation arrays retain order', () => {
    const input = minimal(); input.permissions = { owner: { '*': '*' }, viewer: { clients: ['update', 'read'] } }
    expect(defineInstance(input).permissions.owner.clients).toEqual(['read', 'create', 'update', 'delete'])
    expect(defineInstance(input).permissions.viewer.clients).toEqual(['update', 'read'])
  })
  for (const declarations of [
    [{ role: 'owner', entity: 'clients', operations: 'read' }, { role: 'owner', entity: 'clients', operations: 'all' }],
    [{ role: '*', entity: 'clients', operations: 'read' }, { role: 'owner', entity: '*', operations: 'all' }],
  ]) it('rejects duplicate explicit pairs or overlapping wildcards', () => {
    const input = minimal(); input.permissions = unsafe(declarations) as never
    expect(() => defineInstance(input)).toThrow(/Duplicate permission.*owner.*clients/)
  })
  for (const [role, entity] of [['missing', '*'], ['owner', 'missing'], ['*', 'missing']]) it(`rejects unknown wildcard axis ${role}/${entity}`, () => {
    const input = minimal(); input.permissions = [{ role, entity, operations: 'read' }]
    expect(() => defineInstance(input)).toThrow(role === 'missing' ? 'missing' : 'missing')
  })
  it('rejects unknown operation tokens with role and entity context', () => {
    const input = minimal(); input.permissions = unsafe({ owner: { clients: 'reed' } }) as never
    expect(() => defineInstance(input)).toThrow(/owner.*clients/)
  })
})

describe('policy scopes never widen missing policies', () => {
  it('expands named filters unchanged and emits every entity/role pair', () => {
    const input = minimal(); input.policyScopes = [{ name: 'own', where: { id: { eq: '$actor.id' } } }]
    input.policies = { clients: { owner: { scope: 'own', fields: ['name', 'id'] } } }
    const config = defineInstance(input)
    expect(config.policies).toEqual({ clients: { owner: { where: { id: { eq: '$actor.id' } }, fields: ['name', 'id'] }, viewer: 'none' } })
  })
  it('supports scope:name and deny-only wildcards with explicit overrides', () => {
    const input = minimal(); input.policyScopes = [{ name: 'own', where: { id: { eq: '$actor.id' } } }]
    input.policies = { '*': { '*': 'none' }, clients: { owner: 'scope:own' } }
    expect(defineInstance(input).policies.clients).toEqual({ owner: { where: { id: { eq: '$actor.id' } } }, viewer: 'none' })
  })
  for (const [scopes, expected] of [
    [[{ name: 'own', where: {} }], /Empty policy scope.*own/],
    [[{ name: 'own', where: { id: { eq: '$actor.id' } } }, { name: 'own', where: { id: { eq: '$actor.id' } } }], /Duplicate policy scope.*own/],
  ] as const) it(`rejects unsafe named scope: ${String(expected)}`, () => {
    const input = minimal(); input.policyScopes = unsafe(scopes) as never
    expect(() => defineInstance(input)).toThrow(expected)
  })
  for (const policies of [{ '*': { owner: 'all' } }, { clients: { '*': { where: { id: { eq: '$actor.id' } } } } }]) it('rejects granting policy wildcards', () => {
    const input = minimal(); input.policies = unsafe(policies) as never
    expect(() => defineInstance(input)).toThrow(/Policy wildcard.*none/)
  })
  it('rejects an unknown scope, naming entity and role', () => {
    const input = minimal(); input.policies = { clients: { owner: 'scope:missing' } }
    expect(() => defineInstance(input)).toThrow(/clients.*owner.*missing/)
  })
  it('validates the existing filter grammar and actor references after expansion', () => {
    const input = minimal(); input.policyScopes = [{ name: 'bad', where: { missing: { eq: '$actor.id' } } }]; input.policies = { clients: { owner: 'scope:bad' } }
    expect(() => defineInstance(input)).toThrow()
  })
})
it('rejects misspelt scope options instead of silently dropping a requested field mask', () => {
  const input = minimal(); input.policyScopes = [{ name: 'own', where: { id: { eq: '$actor.id' } } }]
  input.policies = unsafe({ clients: { owner: { scope: 'own', feilds: ['name'] } } }) as never
  expect(() => defineInstance(input)).toThrow(/clients.*owner.*feilds/)
})
it('rejects mixing a scope with an additional where instead of discarding a predicate', () => {
  const input = minimal(); input.policyScopes = [{ name: 'own', where: { id: { eq: '$actor.id' } } }]
  input.policies = unsafe({ clients: { owner: { scope: 'own', where: { name: { eq: 'restricted' } } } } }) as never
  expect(() => defineInstance(input)).toThrow(/clients.*owner.*where/)
})

describe('post-review fail-closed regressions', () => {
  for (const where of [{ and: [{}] }, { or: [{}, { name: { eq: 'x' } }] }, { not: { id: { in: [] } } }]) {
    it(`B1 rejects semantically all-row scope ${JSON.stringify(where)}`, () => {
      const input = minimal(); input.policyScopes = [{ name: 'unsafe', where }]
      input.policies = { clients: { owner: 'scope:unsafe' } }
      expect(() => defineInstance(input)).toThrow('Empty policy scope (always true): unsafe')
    })
  }
  for (const where of [{ id: { in: [] } }, { id: { eq: '$actor.id' } }]) {
    it(`B1 allows deny or nonconstant scope ${JSON.stringify(where)}`, () => {
      const input = minimal(); input.policyScopes = [{ name: 'safe', where }]
      input.policies = { clients: { owner: 'scope:safe' } }
      expect(defineInstance(input).policies.clients.owner).toEqual({ where })
    })
  }
  it('B1 rejects always-true declarations even before a scope is used', () => {
    const input = minimal(); input.policyScopes = [{ name: 'unsafe', where: { and: [{}] } }]
    expect(() => defineInstance(input)).toThrow('Empty policy scope (always true): unsafe')
  })
  for (const fields of [null, false, '', 'name', ['missing']]) it(`C-F1 rejects invalid mask ${JSON.stringify(fields)}`, () => {
    const input = minimal(); input.policyScopes = [{ name: 'own', where: { id: { eq: '$actor.id' } } }]
    input.policies = unsafe({ clients: { owner: { scope: 'own', fields } } }) as never
    expect(() => defineInstance(input)).toThrow(/clients.owner.*fields/)
  })
  for (const deny of [null, false, '', 'unknown']) it(`C-F1 rejects invalid deny ${JSON.stringify(deny)}`, () => {
    const input = minimal(); input.policyScopes = [{ name: 'own', where: { id: { eq: '$actor.id' } } }]
    input.policies = unsafe({ clients: { owner: { scope: 'own', deny } } }) as never
    expect(() => defineInstance(input)).toThrow(/clients.owner.*deny/)
  })
  for (const scope of [null, false, 12, 'bad-name']) it(`C-F1 validates scope identifier ${scope}`, () => {
    const input = minimal(); input.policies = unsafe({ clients: { owner: { scope } } }) as never
    expect(() => defineInstance(input)).toThrow(/clients.owner.*scope/)
  })
  it('C-F1 rejects unknown scope declaration options', () => {
    const input = minimal(); input.policyScopes = unsafe([{ name: 'own', where: { id: { eq: '$actor.id' } }, fields: ['name'] }]) as never
    expect(() => defineInstance(input)).toThrow(/own.*fields/)
  })
  for (const declaration of [
    { role: 'owner', entity: 'clients', operations: 'read', extra: true },
    { role: 1, entity: 'clients', operations: 'read' },
    { role: 'owner', entity: null, operations: 'read' },
  ]) it(`C-F1 validates permission declaration ${JSON.stringify(declaration)}`, () => {
    const input = minimal(); input.permissions = unsafe([declaration]) as never
    expect(() => defineInstance(input)).toThrow(/Invalid permission declaration/)
  })
  for (const [values, message] of [
    ['active', 'not an array'], [[], 'empty'], [['active', 'active'], 'duplicate value'], [[1], 'non-string value'], [[''], 'empty value'],
  ] as const) it(`C-F2 rejects enum ${message}`, () => {
    const input = minimal(); input.enums = unsafe({ status: values }) as never
    input.entities.clients.fields.name = 'enum:status'
    expect(() => defineInstance(input)).toThrow(new RegExp(`status.*${message}`))
  })
  it('F7 rejects declared but unused scopes', () => {
    const input = minimal(); input.policyScopes = [{ name: 'unused', where: { id: { eq: '$actor.id' } } }]
    expect(() => defineInstance(input)).toThrow('Unused policy scope: unused')
  })
})
