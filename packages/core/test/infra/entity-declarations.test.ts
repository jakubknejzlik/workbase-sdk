import { describe, expect, expectTypeOf, it } from 'vitest'
import { defineConfig, defineEntity, accountLink, isSchemaConfig, bindSchemaLock, type ConfigInput } from '../../src/schema'
import { bodyValidator, defineInstance, Fn, Q } from '../../src/config'
import { permissions } from '@workbasehq/plugins/permissions'
import { publicSchema } from '../../src/public-schema'

const worker = () => defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() }, displayField: 'name' })
const input = (): ConfigInput => ({ id: 'sample', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['cs', 'en'], entities: { worker: worker() } })

it('keeps required nonempty text and protected account writes in core validators', () => {
  const config = defineConfig(input())
  const body = bodyValidator(config.entities.worker)
  expect(body.parse({ name: 'Sample worker' })).toEqual({ name: 'Sample worker' })
  for (const data of [{}, { name: '' }, { name: null }, { name: 'Sample', user: 'account-id' }]) expect(body.safeParse(data).success).toBe(false)
  expect(bodyValidator(config.entities.worker, true).safeParse({ user: null }).success).toBe(false)
  expect(config.entities.worker.fields.user).toEqual({ type: 'ref', entity: 'users', required: false, readOnly: true, userLink: true })
  expect(config.entities.worker.relations.user_account).toEqual({ field: 'user', entity: 'users' })
})

it('preserves literal entity and field types at the declaration boundary', () => {
  const entity = worker()
  expectTypeOf(entity.fields.name.type).toEqualTypeOf<'text'>()
  expectTypeOf(entity.fields.name.required).toEqualTypeOf<true>()
  expectTypeOf(entity.fields.user.entity).toEqualTypeOf<'users'>()
  expectTypeOf(entity.displayField).toEqualTypeOf<'name'>()
})

it('uses core scalar, enum, computed and display normalization for public metadata', () => {
  const config = defineConfig({ ...input(), entities: { probe: defineEntity({ fields: {
    name: { type: 'text', required: true }, count: { type: 'int', min: 0 }, amount: { type: 'float', min: -1.5 }, active: { type: 'bool', default: false },
    code: { type: 'string' }, time: { type: 'datetime' }, state: { type: 'enum', values: ['open', 'closed'] },
    derived: { type: 'float', computed: Fn.add('amount', Q.value(1)).serialize() },
  }, displayField: 'name' }) } })
  const fields = config.entities.probe.fields
  expect(fields.amount.type).toBe('float')
  expect(fields.active.type).toBe('bool')
  expect(fields.derived.readOnly).toBe(true)
  expect(bodyValidator(config.entities.probe).safeParse({ name: 'Sample', active: true, amount: 2.5, count: 1 }).success).toBe(true)
  expect(bodyValidator(config.entities.probe).safeParse({ name: 'Sample', amount: '2' }).success).toBe(false)
  // The public metadata projection consumes this normalized schema, including computed fields.
  const metadata = publicSchema(bindSchemaLock(config, { lockVersion: 1, revision: 1, parent: null, tables: [] }), {}).entities.probe
  expect(metadata.displayField).toBe('name')
  expect(metadata.fields.amount.type).toBe('float')
  expect(metadata.fields.active.type).toBe('bool')
  expect(metadata.fields.derived).toMatchObject({ type: 'float', readOnly: true })
})

it('normalizes display expressions and explicit display suppression through the core', () => {
  const config = defineConfig({ ...input(), entities: {
    probe: defineEntity({ fields: { name: { type: 'text' } }, displayField: Fn.concat('name', Q.value('!')).serialize() }),
    worker: defineEntity({ fields: { name: { type: 'text' } }, displayField: false }),
  } })
  expect(config.entities.probe.displayField).toBe('computed_display')
  expect(config.entities.probe.fields.computed_display).toMatchObject({ readOnly: true, computed: Fn.concat('name', Q.value('!')).serialize() })
  expect(config.entities.worker.displayField).toBeUndefined()
})

it('keeps new-era roles exact even with the SDK permissions provider', () => {
  const config = defineConfig({ ...input(), interactive: false, plugins: [permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' })] })
  expect(config.roles).toEqual(['admin', 'staff'])
  expect(config.organizationPermissions).toEqual({})
  expect(config.entities.users.fields.role.values).toEqual(['admin', 'staff'])
  expect(() => defineConfig({ ...input(), interactive: false, plugins: [permissions({ roles: ['admin', 'staff'] })] })).toThrow('must match')
  expect(() => defineConfig({ ...input(), organizationOwnerRole: 'owner' })).toThrow('organizationOwnerRole')
})

it('leaves inline legacy role additions and grants unchanged', () => {
  const config = defineInstance({ id: 'sample', revision: 1, roles: ['owner'], entities: {}, permissions: {} })
  expect(config.roles).toEqual(['owner', 'member'])
  expect(config.organizationPermissions.owner).toContain('members.read')
  expect(config).not.toHaveProperty('languages')
})

it('keeps SDK plugin requires checks and supports plugin migrations without domain hooks', () => {
  const plugin = { name: 'sample-plugin', version: '1', requires: { 'sample-port': '^1' as const }, migrations: [{ name: '0001', sql: 'SELECT 1' }] }
  expect(() => defineConfig({ ...input(), interactive: false, plugins: [plugin] })).toThrow('missing required contract sample-port@^1')
  const config = defineConfig({ ...input(), interactive: false, plugins: [plugin, { name: 'sample-provider', version: '1', provides: { 'sample-port': '1.x' } }] })
  expect(config.plugins?.[0].migrations).toEqual(plugin.migrations)
  expect(config.entities.worker).not.toHaveProperty('migrations')
  expect(config.entities.worker).not.toHaveProperty('checkSchema')
})

it('rejects plugin-contributed domain entities and account ownership', () => {
  for (const plugin of [
    { name: 'sample', version: '1', model: { entities: { probe: { fields: {} } } } },
    { name: 'sample', version: '1', entities: { probe: { fields: {} } } },
    { name: 'sample', version: '1', model: { account: { entity: 'users' } } },
  ]) expect(() => defineConfig({ ...input(), plugins: [plugin] })).toThrow('must be imported explicitly')
  expect(() => defineConfig({ ...input(), entities: { users: worker() } })).toThrow('SDK-owned')
  expect(() => defineConfig({ ...input(), entities: { worker: { fields: {} } } } as any)).toThrow('defineEntity')
})

describe('language and role validation', () => {
  it.each([[], [''], ['en_US'], ['en', 'en'], ['en-US', 'en-us']].map(languages => ({ languages })))('rejects invalid or duplicate languages: $languages', ({ languages }) => {
    expect(() => defineConfig({ ...input(), languages })).toThrow('languages')
  })
  it('preserves configured language order and accepts standard language tags', () => {
    expect(defineConfig({ ...input(), languages: ['de-DE', 'cs', 'en'] }).languages).toEqual(['de-DE', 'cs', 'en'])
  })
  it.each([[], ['admin', 'admin'], ['Admin']].map(roles => ({ roles })))('rejects invalid roles: $roles', ({ roles }) => {
    expect(() => defineConfig({ ...input(), roles })).toThrow('roles')
  })
})

it('rejects inline labels, domain lifecycle hooks and unknown field options', () => {
  for (const invalid of [
    { fields: {}, labels: { en: 'Sample' } }, { fields: {}, label: 'Sample' },
    { fields: {}, migrations: [] }, { fields: {}, checkSchema() {} },
    { fields: { name: { type: 'text', label: 'Sample' } } },
    { fields: { name: { type: 'text', typeAlias: 'number' } } },
  ]) expect(() => defineEntity(invalid as any)).toThrow()
})

it('validates protected link options and forces the canonical to-one metadata', () => {
  for (const options of [{ required: true }, { computed: 'name' }, { default: 'id' }, { entity: 'probe' }]) {
    expect(() => defineEntity({ fields: { user: { ...accountLink(), ...options } } } as any)).toThrow()
  }
  expect(() => defineEntity({ fields: { user: accountLink() }, relations: { user_account: { field: 'user', entity: 'users', many: true } } })).toThrow('user_account')
  const config = defineConfig({ ...input(), entities: { worker: defineEntity({ fields: { name: { type: 'text' }, user: { type: 'ref', entity: 'users', userLink: true, readOnly: false } } }) } })
  expect(config.entities.worker.fields.user.readOnly).toBe(true)
})

// These calls are checked by root typecheck and intentionally never executed.
function invalidDeclarationTypes() {
  // @ts-expect-error The core field type is float/int, never number.
  defineEntity({ fields: { amount: { type: 'number' } } })
  // @ts-expect-error The core field type is bool, never boolean.
  defineEntity({ fields: { active: { type: 'boolean' } } })
  // @ts-expect-error Labels belong to dictionaries.
  defineEntity({ fields: {}, labels: { en: 'Sample' } })
  // @ts-expect-error Field labels also belong to dictionaries.
  defineEntity({ fields: { name: { type: 'text', label: 'Sample' } } })
  // @ts-expect-error Roles and organizationOwnerRole are mandatory on this path.
  defineConfig({ id: 'sample', languages: ['en'], entities: {} })
  // @ts-expect-error Languages are mandatory on this path.
  defineConfig({ id: 'sample', roles: ['admin'], organizationOwnerRole: 'admin', entities: {} })
}
void invalidDeclarationTypes

it('recognizes SDK era on the config value and its spread copy', () => {
  const config = defineConfig(input())
  expect(isSchemaConfig(config)).toBe(true)
  // This is an era check, not a claim about the copy's provenance or access.
  expect(() => ({ ...config })).toThrow('schema lock not bound')
  bindSchemaLock(config, { lockVersion: 1, revision: 1, parent: null, tables: [] })
  expect(isSchemaConfig({ ...config })).toBe(true)
})
