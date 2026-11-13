import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { defineInstance } from '../../src/config'
import { accessEntities, accessSystemActions } from '../../src/schema'
import { loadConfig } from '../../src/schema/load'
import { KernelRegistry } from '../../src/kernel/registry'
import { createCommandRegistry } from '../../src/commands'
import { effectiveEntityGrants } from '../../src/access-evaluator'
import { serializeAccessLock, syncAccessLock } from '../../src/access-lock'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' }
function consumer(shuffled = false) {
  const root = mkdtempSync(join(tmpdir(), 'workbase-lock-')); roots.push(root)
  mkdirSync(join(root, 'schema'))
  const order = (entries: [string, unknown][]) => Object.fromEntries(shuffled ? entries.reverse() : entries)
  const access = {
    predicates: { self: { user: { eq: '$actor.id' } } },
    roles: order(['admin', 'staff', 'worker'].map(role => [role, { system: order(accessSystemActions.map(action => [action, 'deny'])) }])),
    entities: order(accessEntities.map(entity => [entity, order([['admin', all], ['staff', 'deny'], ['worker', 'none']])])),
  }
  const matrix = order([['admin', all], ['staff', 'deny'], ['worker', { ...all, read: { where: { use: 'self' }, fields: ['id', 'name'] } }]])
  // One-line literals preserve file:line attribution when declarations are shuffled.
  writeFileSync(join(root, 'access.ts'), `import { defineAccess } from '@workbasehq/core/schema'\nexport default defineAccess(${JSON.stringify(access)})\n`)
  const worker = () => `import { defineEntity, accountLink } from '@workbasehq/core/schema'\nexport default defineEntity({ fields: { name: { type: 'text' }, user: accountLink() }, access: ${JSON.stringify(matrix)} })\n`
  writeFileSync(join(root, 'schema/worker.ts'), worker())
  writeFileSync(join(root, 'config.ts'), `import { defineConfig } from '@workbasehq/core/schema'\nimport worker from './schema/worker'\nimport access from './access'\nexport default defineConfig({ id: 'lock_probe', revision: 1, interactive: false, languages: ['en'], roles: ${JSON.stringify(shuffled ? ['worker', 'staff', 'admin'] : ['admin', 'staff', 'worker'])}, organizationOwnerRole: 'admin', entities: { worker }, access })\n`)
  return { root, matrix, worker, load: async () => {
    const { config, sources } = await loadConfig(join(root, 'config.ts'))
    return { kernel: new KernelRegistry(config), sources, root }
  } }
}
it('generates byte-identical JSON and Markdown twice and with shuffled declaration order', async () => {
  const first = await consumer().load(); const shuffled = await consumer(true).load()
  const a = serializeAccessLock(first.kernel, first)
  expect(serializeAccessLock(first.kernel, first)).toEqual(a)
  expect(serializeAccessLock(shuffled.kernel, shuffled)).toEqual(a)
  expect(a.json).not.toContain(first.root)
  expect(a.md).toContain('schema/worker.ts:2')
  await syncAccessLock({ ...first, write: true })
  const before = ['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(first.root, file), 'utf8'))
  await syncAccessLock({ ...first, write: true })
  expect(['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(first.root, file), 'utf8'))).toEqual(before)
})
it('serializes kernel.config.effectiveAccess exactly, without re-derivation', async () => {
  const options = await consumer().load()
  // A sentinel in the final composed value cannot be recovered from authored inputs.
  options.kernel.config.effectiveAccess!.opaqueHooks.push('sentinel.commandGuard')
  const lock = serializeAccessLock(options.kernel, options)
  expect(JSON.parse(lock.json).effectiveAccess).toEqual(options.kernel.config.effectiveAccess)
  expect(lock.md).toContain('sentinel.commandGuard')
  const rule = JSON.parse(lock.json).effectiveAccess.entities.find((r: any) => r.role === 'worker' && r.entity === 'worker' && r.operation === 'read')
  expect(rule).toMatchObject({ where: { user: { eq: '$actor.id' } }, fields: ['id', 'name'], predicates: ['self'] })
})
it('policy-only drift names role/entity/operation, never writes, and passes after regeneration', async () => {
  const fixture = consumer(); const before = await fixture.load()
  await syncAccessLock({ ...before, write: true })
  const old = ['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(fixture.root, file), 'utf8'))
  fixture.matrix.admin = { ...all, update: 'deny' }
  writeFileSync(join(fixture.root, 'schema/worker.ts'), fixture.worker())
  const after = await fixture.load()
  expect(after.kernel.config.revision).toBe(before.kernel.config.revision)
  const result = await syncAccessLock(after)
  expect(result.ok).toBe(false)
  expect(result.message).toContain('admin / worker / update')
  expect(['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(fixture.root, file), 'utf8'))).toEqual(old)
  await syncAccessLock({ ...after, write: true })
  expect((await syncAccessLock(after)).ok).toBe(true)
})
it('includes composed command permissions, additional guards, SDK account commands and opaque hooks', async () => {
  const options = await consumer().load()
  const command = { name: 'worker/custom', permission: { entity: 'worker', operation: 'update' as const },
    additionalPermissions: [{ entity: 'memberships', operation: 'read' as const }], input: z.object({}),
    plan: () => { throw new Error('Opaque code must never execute during audit') } }
  const pluginCommand = { ...command, name: 'plugin/system', permission: { system: 'members.read' as const } }
  const kernel = new KernelRegistry({ ...options.kernel.config, commands: ['worker/unresolved'], plugins: [{ name: 'custom', version: '1.0.0', commands: [pluginCommand], commandGuard: () => ({ allow: true }) }] }, { commands: createCommandRegistry([command]) })
  const lock = serializeAccessLock(kernel, options)
  const policy = JSON.parse(lock.json).effectiveAccess
  expect(policy.guards).toEqual(kernel.config.effectiveAccess!.guards)
  expect(policy.guards).toContainEqual({ name: pluginCommand.name, permission: pluginCommand.permission, additionalPermissions: pluginCommand.additionalPermissions, opaque: true })
  expect(policy.guards).toContainEqual({ name: 'worker/unresolved', permission: null, additionalPermissions: [], opaque: true })
  expect(policy.guards).toContainEqual({ name: command.name, permission: command.permission, additionalPermissions: command.additionalPermissions, opaque: true })
  expect(policy.guards.some((guard: any) => guard.name.includes('remove_access'))).toBe(true)
  expect(policy.opaqueHooks).toContain('custom.commandGuard')
  expect(lock.md).toContain('opaque')
  expect(lock.md).toContain('custom.commandGuard')
  expect(policy.system).toEqual(kernel.config.effectiveAccess!.system)
})
it('combined admin and denied staff stays denied in the serialized enforcement value', async () => {
  const options = await consumer().load()
  const lock = serializeAccessLock(options.kernel, options)
  const policy = JSON.parse(lock.json).effectiveAccess
  expect(effectiveEntityGrants(policy, ['admin', 'staff'], 'worker', 'read')).toEqual([])
  expect(policy.entities).toContainEqual(expect.objectContaining({ role: 'staff', entity: 'worker', operation: 'read', decision: 'deny' }))
  expect(lock.md).toContain('intersection')
  expect(lock.md).toMatch(/staff.*worker.*deny/)
})
it('missing locks fail actionably, malformed or independently stale artifacts fail without writing', async () => {
  const options = await consumer().load()
  const files = readdirSync(options.root)
  const missing = await syncAccessLock(options)
  expect(missing).toMatchObject({ ok: false })
  expect(missing.message).toMatch(/missing.*access.lock.json.*access:lock/s)
  expect(readdirSync(options.root)).toEqual(files)
  await syncAccessLock({ ...options, write: true })
  writeFileSync(join(options.root, 'access.lock.md'), 'stale\n')
  expect((await syncAccessLock(options)).message).toContain('access.lock.md')
  writeFileSync(join(options.root, 'access.lock.json'), '{invalid')
  expect((await syncAccessLock(options)).message).toContain('access.lock.json')
})
it('legacy defineInstance skips clearly without creating any lock or changing config bytes', async () => {
  const root = consumer().root
  const kernel = new KernelRegistry(defineInstance({ id: 'legacy', revision: 1, entities: {} }))
  const before = JSON.stringify(kernel.config); const files = readdirSync(root)
  expect(await syncAccessLock({ kernel, root, sources: {}, write: true })).toMatchObject({ ok: true, message: expect.stringMatching(/skip.*legacy.*defineInstance/i) })
  expect(JSON.stringify(kernel.config)).toBe(before)
  expect(readdirSync(root)).toEqual(files)
})
it('CLI checks the committed SDK fixture and returns nonzero on a missing lock', () => {
  const cli = resolve('packages/core/src/access-lock/cli.ts')
  const config = resolve('packages/core/test/fixtures/config-era/config.ts')
  const root = resolve('.')
  const missing = consumer().root
  const run = (directory: string) => spawnSync('bun', [cli, '--config', config, '--root', root, '--directory', directory], { encoding: 'utf8' })
  expect(run(missing).status).toBe(1)
  const check = run(resolve('packages/core/test/fixtures/config-era'))
  expect(check.stderr).toBe('')
  expect(check.status).toBe(0)
})

it('CLI policy-only change fails with the changed operation; write then check passes; legacy skips', () => {
  const fixture = consumer()
  symlinkSync(resolve('node_modules'), join(fixture.root, 'node_modules'), 'dir')
  const configPath = join(fixture.root, 'config.ts')
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace("id: 'lock_probe'", "plugins: [{ name: 'inline', version: '1.0.0', commandGuard() { throw new Error('never execute') } }], id: 'lock_probe'"))
  const cli = resolve('packages/core/src/access-lock/cli.ts')
  const run = (...args: string[]) => spawnSync('bun', [cli, '--root', fixture.root, ...args], { encoding: 'utf8' })
  expect(run('--write').status).toBe(0)
  expect(JSON.parse(readFileSync(join(fixture.root, 'access.lock.json'), 'utf8')).effectiveAccess.opaqueHooks).toContain('inline.commandGuard')
  fixture.matrix.admin = { ...all, delete: 'deny' }
  writeFileSync(join(fixture.root, 'schema/worker.ts'), fixture.worker())
  const stale = run()
  expect(stale.status).toBe(1)
  expect(stale.stdout).toContain('admin / worker / delete')
  expect(run('--write').status).toBe(0)
  expect(run().status).toBe(0)
  writeFileSync(join(fixture.root, 'legacy.ts'), `import { defineInstance } from '@workbasehq/core/config'
export default defineInstance({ id: 'legacy', revision: 1, entities: {} })
`)
  const old = ['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(fixture.root, file), 'utf8'))
  const legacy = run('--config', 'legacy.ts', '--write')
  expect(legacy.status).toBe(0)
  expect(legacy.stdout).toMatch(/skip legacy defineInstance/)
  expect(['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(fixture.root, file), 'utf8'))).toEqual(old)
})
it('refuses source locations outside the repository instead of emitting host paths', async () => {
  const options = await consumer().load()
  expect(() => serializeAccessLock(options.kernel, { ...options, root: join(options.root, 'schema') })).toThrow('outside the repository root')
})
