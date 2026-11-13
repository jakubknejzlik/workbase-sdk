import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileAccess, type EntityAccess } from '../../src/schema'
import { loadConfig } from '../../src/schema/load'
import { accessEntities, accessSystemActions, type AccessInput } from '../../src/access'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const operations = { read: 'allow', create: 'allow', update: 'allow', delete: 'deny' } as const
function shared(): AccessInput {
  return { roles: Object.fromEntries(['admin', 'staff'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) }])),
    entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: operations, staff: 'deny' }])), predicates: { self: { user: { eq: '$actor.id' } } } }
}
function consumer(access = shared(), worker: unknown = { admin: operations, staff: { read: { where: { use: 'self' }, fields: ['id', 'name'] }, create: 'deny', update: 'deny', delete: 'deny' } }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbase-access-'))); roots.push(root)
  mkdirSync(join(root, 'schema'))
  writeFileSync(join(root, 'config.ts'), `import { defineConfig } from '@workbasehq/core/schema'
import worker from './schema/worker.ts'
import access from './access.ts'
export default defineConfig({ id: 'sample', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['en'], entities: { worker }, access })`)
  writeFileSync(join(root, 'access.ts'), `import { defineAccess } from '@workbasehq/core/schema'\nexport default defineAccess(${JSON.stringify(access, null, 2)})`)
  writeFileSync(join(root, 'schema/worker.ts'), `import { defineEntity, accountLink } from '@workbasehq/core/schema'\nexport default defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() }, access: ${JSON.stringify(worker, null, 2)} })`)
  return { root, matrix: worker, load: () => loadConfig(join(root, 'config.ts')) }
}
it('rejects missing role × entity entries with role, entity and file:line', async () => {
  const { load } = consumer(shared(), { admin: operations })
  await expect(load()).rejects.toThrow(/schema\/worker.ts:\d+:\d+:.*staff.*worker/)
  const access = shared(); delete access.entities.users.staff
  await expect(consumer(access).load()).rejects.toThrow(/access.ts:\d+:\d+:.*staff.*users/)
})
it('rejects unknown predicate names with file:line', async () => {
  await expect(consumer(shared(), { admin: { ...operations, read: { where: { use: 'missing' } } }, staff: 'deny' }).load()).rejects.toThrow(/worker.ts:\d+:\d+:.*Unknown predicate.*missing/)
})
it('rejects predicate cycles with cycle path and file:line', async () => {
  const access = shared(); access.predicates = { self: { use: 'again' }, again: { use: 'self' } }
  await expect(consumer(access).load()).rejects.toThrow(/access.ts:\d+:\d+:.*again -> self -> again/)
})
it('rejects oversized named expansion with file:line', async () => {
  const access = shared(); access.predicates = { self: { and: Array.from({ length: 600 }, () => ({ name: { eq: 'sample' } })) } }
  await expect(consumer(access).load()).rejects.toThrow(/access.ts:\d+:\d+:.*budget/)
})
it('rejects relation dependency cycles with the cycle path and file:line', async () => {
  const access = shared(); access.entities.users.admin = { ...operations, read: { where: { actorLinkedIn: 'worker' } } } as any
  await expect(consumer(access, { admin: { ...operations, read: { where: { user_account: { name: { eq: 'sample' } } } } }, staff: 'deny' }).load()).rejects.toThrow(/access.ts:\d+:\d+:.*users -> worker -> users/)
})
it('normalizes deterministically across repeated compilation and shuffled declarations', async () => {
  const first = consumer(); const a = await first.load(); const b = await first.load()
  expect(a.config.effectiveAccess).toEqual(b.config.effectiveAccess)
  expect(compileAccess(a.config, { worker: first.matrix as EntityAccess }, shared())).toEqual(a.config.effectiveAccess)
  const access = shared(); access.roles = Object.fromEntries(Object.entries(access.roles).reverse()); access.entities = Object.fromEntries(Object.entries(access.entities).reverse())
  const shuffled = consumer(access, Object.fromEntries(Object.entries(first.matrix as object).reverse()))
  const { readFileSync } = await import('node:fs')
  const configPath = join(shuffled.root, 'config.ts')
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace("roles: ['admin', 'staff']", "roles: ['staff', 'admin']"))
  const c = await shuffled.load()
  // Source paths are canonical config paths, independent of machine and source order.
  expect(c.config.effectiveAccess).toEqual(a.config.effectiveAccess)
})
it('changes configHash for a policy-only edit without changing schema revision', async () => {
  const access = shared(); const first = consumer(access); const a = await first.load()
  access.entities.users.admin = 'deny'
  writeFileSync(join(first.root, 'access.ts'), `import { defineAccess } from '@workbasehq/core/schema'\nexport default defineAccess(${JSON.stringify(access)})`)
  const b = await first.load()
  expect(b.configHash).not.toBe(a.configHash)
  expect(b.config.revision).toBe(a.config.revision)
  expect(b.config.entities).toEqual(a.config.entities)
})

it('requires explicit operations, roles and SDK entities without implicit defaults', async () => {
  await expect(consumer(shared(), { admin: { read: 'allow' }, staff: 'deny' }).load()).rejects.toThrow(/worker.ts:\d+:\d+:/)
  const access = shared(); delete access.entities.sessions
  await expect(consumer(access).load()).rejects.toThrow(/access.ts:\d+:\d+:.*admin.*sessions/)
  const missing = shared(); delete missing.roles.staff
  await expect(consumer(missing).load()).rejects.toThrow(/access.ts:\d+:\d+:.*staff/)
  const action = shared(); delete action.roles.admin.system['members.read']
  await expect(consumer(action).load()).rejects.toThrow(/access.ts:\d+:\d+:.*members.read.*admin/)
})
it('bounds named predicate depth as well as total expanded size', async () => {
  const access = shared()
  access.predicates = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`p${i}`, i === 23 ? { name: { eq: 'sample' } } : { use: `p${i + 1}` }]))
  await expect(consumer(access).load()).rejects.toThrow(/access.ts:\d+:\d+:.*budget/)
})
it.each([
  ['spread', (text: string) => text.replace('"predicates": {', '"predicates": { ...{},')],
  ['call', (text: string) => text.replace('"predicates": {', '"predicates": Object.assign({')],
  ['identifier', (text: string) => text.replace('"predicates": {', '"predicates": other, "unused": {')],
  ['extra code', (text: string) => text + '\nconsole.log("unexpected")'],
])('reuses the literal boundary for shared access: %s', async (_name, transform) => {
  const { root, load } = consumer()
  writeFileSync(join(root, 'access.ts'), transform(`import { defineAccess } from '@workbasehq/core/schema'\nexport default defineAccess(${JSON.stringify(shared(), null, 2)})`))
  await expect(load()).rejects.toThrow(/access.ts:\d+:\d+:/)
})
it('rejects competing access module candidates using the entity resolver', async () => {
  const { root, load } = consumer()
  writeFileSync(join(root, 'access.js'), 'export default {}')
  await expect(load()).rejects.toThrow(/config.ts:\d+:\d+:.*Ambiguous/)
})
it('includes entity access sources in configHash while preserving physical schema', async () => {
  const { root, load } = consumer(); const a = await load()
  const { readFileSync } = await import('node:fs')
  const path = join(root, 'schema/worker.ts')
  writeFileSync(path, readFileSync(path, 'utf8').replace('"create": "allow"', '"create": "deny"'))
  const b = await load()
  const { initialSchema } = await import('../../src/migrations/schema')
  expect(b.configHash).not.toBe(a.configHash)
  expect(b.config.revision).toBe(a.config.revision)
  expect(initialSchema(b.config)).toBe(initialSchema(a.config))
})
it('rejects an authored effectiveAccess literal instead of trusting it as compiled policy', async () => {
  const { root, load } = consumer()
  const compiled = (await load()).config.effectiveAccess
  // Reviewer repro (PR #18 verify2): no access.ts or entity access, policy injected as a literal.
  writeFileSync(join(root, 'config.ts'), `import { defineConfig } from '@workbasehq/core/schema'
import worker from './schema/worker.ts'
export default defineConfig({ id: 'sample', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['en'], entities: { worker }, effectiveAccess: ${JSON.stringify(compiled)} })`)
  writeFileSync(join(root, 'schema/worker.ts'), `import { defineEntity, accountLink } from '@workbasehq/core/schema'\nexport default defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() } })`)
  await expect(load()).rejects.toThrow(/effectiveAccess.*cannot be authored/)
  // Alongside real declarations the literal is still rejected, not merged or overridden.
  const declared = consumer()
  writeFileSync(join(declared.root, 'config.ts'), `import { defineConfig } from '@workbasehq/core/schema'
import worker from './schema/worker.ts'
import access from './access.ts'
export default defineConfig({ id: 'sample', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['en'], entities: { worker }, access, effectiveAccess: ${JSON.stringify(compiled)} })`)
  await expect(declared.load()).rejects.toThrow(/effectiveAccess.*cannot be authored/)
})
