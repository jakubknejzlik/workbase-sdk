import { afterEach, expect, it, vi } from 'vitest'
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
import { serializeAccessLock, syncAccessLock, type AccessLockOptions } from '../../src/access-lock'
import { enforcementInputs } from '../../src/access-inputs'
import { Cond, Fn, Q } from '../../src/config'
import { sealActor, requireScope } from '../../src/authorization'
import { loadActorProjection } from '../../src/policies'
import { expressionInfo, readableComputed } from '../../src/query/expressions'
import { labelDependencies, labelPath, readableDisplay, readableLabel } from '../../src/query/labels'
import { validateQuery } from '../../src/query/schema'
import { compileRoot } from '../../src/query/compiler'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' }
function consumer(shuffled = false) {
  const root = mkdtempSync(join(tmpdir(), 'workbase-lock-')); roots.push(root)
  mkdirSync(join(root, 'schema'))
  writeFileSync(join(root, 'schema.lock.json'), JSON.stringify({ lockVersion: 1, revision: 1, parent: null, tables: [] }))
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
  writeFileSync(join(root, 'config.ts'), `import { defineConfig } from '@workbasehq/core/schema'\nimport worker from './schema/worker'\nimport access from './access'\nexport default defineConfig({ id: 'lock_probe', interactive: false, languages: ['en'], roles: ${JSON.stringify(shuffled ? ['worker', 'staff', 'admin'] : ['admin', 'staff', 'worker'])}, organizationOwnerRole: 'admin', entities: { worker }, access })\n`)
  writeFileSync(join(root, 'config.ts'), readFileSync(join(root, 'config.ts'), 'utf8').replace('{ defineConfig }', '{ defineConfig, bindSchemaLock }').replace("import worker", "import lock from './schema.lock.json'\nimport worker").replace('export default defineConfig(', 'export default bindSchemaLock(defineConfig(').replace('access })', 'access }), lock)'))
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
it('generates identical locks when the host locale reverses collation', async () => {
  const options = await consumer().load()
  const generate = () => serializeAccessLock(new KernelRegistry(options.kernel.config, { commands: createCommandRegistry([{
    name: 'locale', permission: { entity: 'worker', operation: 'read' }, input: z.object({}),
    additionalPermissions: [{ entity: 'aa', operation: 'read' }, { entity: 'z', operation: 'read' }],
    plan: () => { throw new Error('opaque') },
  }]) }), options)
  const before = generate()
  const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) {
    return this < other ? 1 : this > other ? -1 : 0
  })
  try { expect(generate()).toEqual(before) } finally { locale.mockRestore() }
})
it('CLI detects relation binding and provider drift; regeneration makes each current', () => {
  const fixture = consumer()
  symlinkSync(resolve('node_modules'), join(fixture.root, 'node_modules'), 'dir')
  const worker = join(fixture.root, 'schema/worker.ts')
  writeFileSync(worker, readFileSync(worker, 'utf8')
    .replace('user: accountLink()', "user: accountLink(), manager: { type: 'ref', entity: 'users' }")
    .replace('access:', "relations: { owner: { field: 'user', entity: 'users' } }, access:")
    .replace('"use":"self"', '"owner":{"name":{"eq":"Alice"}}'))
  const cli = resolve('packages/core/src/access-lock/cli.ts')
  const run = (...args: string[]) => spawnSync('bun', [cli, '--root', fixture.root, ...args], { encoding: 'utf8' })
  expect(run('--write').status).toBe(0)
  const grants = JSON.parse(readFileSync(join(fixture.root, 'access.lock.json'), 'utf8')).effectiveAccess
  writeFileSync(worker, readFileSync(worker, 'utf8').replace("field: 'user'", "field: 'manager'"))
  const relation = run()
  expect(relation.status).toBe(1)
  expect(relation.stdout).toContain('worker / relations / owner / field')
  expect(run('--write').status).toBe(0)
  expect(run().status).toBe(0)
  expect(JSON.parse(readFileSync(join(fixture.root, 'access.lock.json'), 'utf8')).effectiveAccess).toEqual(grants)
  const config = join(fixture.root, 'config.ts')
  writeFileSync(config, `import { permissions } from '${resolve('packages/plugins/permissions/src/index.ts')}'\n` + readFileSync(config, 'utf8')
    .replace("id: 'lock_probe'", "plugins: [permissions({ roles: ['admin', 'staff', 'worker'], ownerRole: 'admin' })], id: 'lock_probe'"))
  const provider = run()
  expect(provider.status).toBe(1)
  expect(provider.stdout).toContain('permissions')
  expect(run('--write').status).toBe(0)
  expect(run().status).toBe(0)
})
it('audits the resolved runtime ports, bypass and account/schema objects without deriving grants', async () => {
  const options = await consumer().load()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let kernel: KernelRegistry
  try {
    kernel = new KernelRegistry(options.kernel.config, { authorization: 'trust', plugins: [{
      name: 'runtime', version: '1.0.0', provides: { permissions: '1.x' }, authorization: true,
      tableFilter: () => ({ kind: 'all' }), fieldMask: () => ['id'], commandGuard: () => ({ allow: true }),
    }] })
  } finally { warn.mockRestore() }
  const inputs = enforcementInputs(kernel!)
  expect(inputs.authorization).toMatchObject({ trust: true, permissionsActive: false, providers: { permissions: [{ name: 'runtime', version: '1.0.0' }] } })
  expect(inputs.account).toBe(kernel!.config.account)
  expect(inputs.policies).toBe(kernel!.config.policies)
  expect(inputs.organizationPermissions).toBe(kernel!.config.organizationPermissions)
  expect(inputs.entities.worker.relations).toBe(kernel!.config.entities.worker.relations)
  expect(inputs.entities.worker.fields.user).toMatchObject({ type: 'ref', entity: 'users', userLink: true, readOnly: true })
  const lock = serializeAccessLock(kernel!, options)
  expect(JSON.parse(lock.json).enforcementInputs).toEqual(JSON.parse(JSON.stringify(inputs)))
  expect(lock.md).toContain('runtime')
  expect(lock).not.toEqual(serializeAccessLock(options.kernel, options))
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
it.each(['./config', './config.ts'])('CLI checks and regenerates runtime locks beside unrelated config files (%s)', configImport => {
  const { root } = consumer()
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  writeFileSync(join(root, 'runtime.ts'), `import config from '${configImport}'\nexport default { ...config }`)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
    'check:access': 'bun node_modules/@workbasehq/core/src/access-lock/cli.ts --config runtime.ts',
    'access:lock': 'bun node_modules/@workbasehq/core/src/access-lock/cli.ts --config runtime.ts --write',
  } }))
  const run = (script: string) => spawnSync('bun', ['run', script], { cwd: root, encoding: 'utf8' })
  expect(run('access:lock').status).toBe(0)
  const before = ['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(root, file), 'utf8'))
  writeFileSync(join(root, 'config.local.ts'), `throw new Error('unrelated config must not execute')`)
  writeFileSync(join(root, 'config.indexes.json'), '[]')
  const results = ['check:access', 'access:lock', 'check:access'].map(run)
  for (const result of results) {
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }
  expect(['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(root, file), 'utf8'))).toEqual(before)
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

// Real authored declarations and loader source maps; labels are attached only at the
// supported normalized/runtime seam (defineEntity intentionally rejects inline labels).
async function queryConsumer() {
  const fixture = consumer()
  const matrix = { admin: all, staff: all, worker: { ...all, read: { where: { id: { ne: '' } }, fields: ['id', 'name', 'label_value', 'contact_id'] } } }
  const entity = (fields: unknown, displayField: string, access: unknown = matrix) =>
    `import { defineEntity } from '@workbasehq/core/schema'\nexport default defineEntity(${JSON.stringify({ fields, displayField, access })})\n`
  const fields = { name: { type: 'string' }, private_name: { type: 'string' }, label_value: { type: 'string', readOnly: true } }
  writeFileSync(join(fixture.root, 'schema/contacts.ts'), entity(fields, 'name', { ...matrix, worker: { ...all, read: { where: { id: { ne: '' } }, fields: ['id', 'name', 'label_value'] } } }))
  writeFileSync(join(fixture.root, 'schema/clients.ts'), entity({ ...fields, contact_id: { type: 'ref', entity: 'contacts' }, hidden_contact_id: { type: 'ref', entity: 'contacts' } }, 'name'))
  writeFileSync(join(fixture.root, 'schema/jobs.ts'), entity({ title: { type: 'string' }, client_id: { type: 'ref', entity: 'clients' }, description: { type: 'string', computed: '#client_id#' }, summary: { type: 'string', computed: Q.expr('description').serialize() } }, 'title', { admin: all, staff: all, worker: all }))
  const config = join(fixture.root, 'config.ts')
  writeFileSync(config, readFileSync(config, 'utf8').replace("import worker from './schema/worker'", "import clients from './schema/clients'\nimport contacts from './schema/contacts'\nimport jobs from './schema/jobs'").replace('entities: { worker }', 'entities: { clients, contacts, jobs }'))
  const load = async (labels: Record<string, ReturnType<typeof Q.expr>> = {}) => {
    const options = await fixture.load()
    writeFileSync(join(fixture.root, 'labels.ts'), `import { Q } from '@workbasehq/core/config'\n${['clients', 'contacts'].map(name => labels[name] ? `export const ${name} = Q.expr(${JSON.stringify(labels[name].serialize())})` : `// No ${name} label`).join('\n')}\n`)
    for (const [name, label] of Object.entries(labels)) {
      options.kernel.config.entities[name].displayField = 'label_value'
      options.kernel.config.entities[name].label = label
      // Equivalent executable registrations can supply exact label source metadata.
      options.sources[`entities.${name}.label`] = { file: 'labels.ts', line: name === 'clients' ? 2 : 3, column: 1 }
    }
    return { ...options, kernel: new KernelRegistry(options.kernel.config, { plugins: [{ name: 'query_audit', version: '1', provides: { permissions: '1.x' }, authorization: true, tableFilter: () => ({ kind: 'all' }), commandGuard: () => ({ allow: true }) }] }) }
  }
  const env: any = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ user_id: 'worker', organization_id: 'org-a', role: 'worker' }) }) }) } }
  const actor = sealActor({ actor: { type: 'user', id: 'worker' }, user: { id: 'worker', email: 'worker@example.test' }, organizations: [] },
    { env, hash: 'synthetic', session: { valid: async () => true, verified: async () => true, recipientVerification: 'local-profile' } })
  const scope = await requireScope(actor, 'org-a', undefined, 'lock_probe')
  const initial = await load()
  await loadActorProjection(initial.kernel.config, scope, async <T>() => ({ id: 'worker', role: 'worker', organization_id: 'org-a' }) as T, { user_id: 'worker', organization_id: 'org-a', role: 'worker' })
  return { ...fixture, load, scope }
}
async function expectQueryDrift(before: AccessLockOptions & { kernel: KernelRegistry }, after: typeof before, path: string, source: string) {
  const file = source.endsWith('.label') ? 'labels.ts' : source.startsWith('ui.') ? 'config.ts' : 'schema/clients.ts'
  const line = source.endsWith('.label') ? source.includes('contacts') ? 3 : 2 : source.startsWith('ui.') ? 7 : 2
  const old = serializeAccessLock(before.kernel, before)
  const current = serializeAccessLock(after.kernel, after)
  await syncAccessLock({ ...before, write: true })
  const stale = await syncAccessLock(after)
  // Assert stale first so the pre-fix red run exposes the false-negative check.
  expect(stale.ok, stale.message).toBe(false)
  expect(stale.message).toContain(path)
  expect(stale.message).toContain(`${file}:${line}`)
  expect(current.json).not.toBe(old.json)
  expect(current.md).not.toBe(old.md)
  expect(JSON.parse(current.json).effectiveAccess).toEqual(JSON.parse(old.json).effectiveAccess)
  expect(JSON.parse(current.json).sources).toMatchObject({ [source]: { file, line } })
  expect(current.md).toContain(`${file}:${line}`)
  expect(['access.lock.json', 'access.lock.md'].map(file => readFileSync(join(before.root, file), 'utf8'))).toEqual([old.json, old.md])
  expect(serializeAccessLock(after.kernel, after)).toEqual(current)
  await syncAccessLock({ ...after, write: true })
  expect((await syncAccessLock(after)).ok).toBe(true)
}
it('displayField drift masks an unchanged computed expression and its transitive consumer; check is nonwriting', async () => {
  const fixture = await queryConsumer(); const before = await fixture.load()
  const file = join(fixture.root, 'schema/clients.ts')
  writeFileSync(file, readFileSync(file, 'utf8').replace('"displayField":"name"', '"displayField":"private_name"'))
  const after = await fixture.load()
  for (const field of ['description', 'summary']) {
    expect(before.kernel.config.entities.jobs.fields[field].computed).toBe(after.kernel.config.entities.jobs.fields[field].computed)
    expect(readableComputed(before.kernel, fixture.scope, 'jobs', field)).toBe(true)
    expect(readableComputed(after.kernel, fixture.scope, 'jobs', field)).toBe(false)
  }
  const sql = (kernel: KernelRegistry) => {
    const { query, cost } = validateQuery(kernel, fixture.scope, { entity: 'jobs', select: ['id', 'description'], limit: 10 })
    return compileRoot(kernel, fixture.scope, query, undefined, cost).sql
  }
  expect(sql(before.kernel)).not.toContain('NULL AS `description`')
  expect(sql(after.kernel)).toContain('NULL AS `description`')
  expect(expressionInfo(before.kernel.config, 'jobs', 'description', '#client_id#').dependencies[0].field).toBe('name')
  expect(expressionInfo(after.kernel.config, 'jobs', 'description', '#client_id#').dependencies[0].field).toBe('private_name')
  await expectQueryDrift(before, after, 'clients / displayField: "name" -> "private_name"', 'entities.clients.displayField')
})
it.each(['operand', 'hop', 'transitive'] as const)('structured label %s drift changes runtime readability and fails the lock', async mutation => {
  const fixture = await queryConsumer()
  const label = (column: string) => Fn.concat(column, Q.value('!'))
  const a = mutation === 'operand' ? label('name') : mutation === 'hop' ? label('contact_id.name') : label('contact_id.label_value')
  const b = mutation === 'operand' ? label('private_name') : mutation === 'hop' ? label('hidden_contact_id.name') : a
  const before = await fixture.load({ clients: a, ...(mutation === 'transitive' ? { contacts: label('name') } : {}) })
  const after = await fixture.load({ clients: b, ...(mutation === 'transitive' ? { contacts: label('private_name') } : {}) })
  expect(readableDisplay(before.kernel, fixture.scope, 'clients')).toBe('label_value')
  expect(readableDisplay(after.kernel, fixture.scope, 'clients')).toBeUndefined()
  expect(readableComputed(before.kernel, fixture.scope, 'jobs', 'summary')).toBe(true)
  expect(readableComputed(after.kernel, fixture.scope, 'jobs', 'summary')).toBe(false)
  expect(labelDependencies(before.kernel.config, 'clients')).not.toEqual(labelDependencies(after.kernel.config, 'clients'))
  const target = mutation === 'transitive' ? 'contacts' : 'clients'
  await expectQueryDrift(before, after, `${target} / label`, `entities.${target}.label`)
  expect(JSON.parse(serializeAccessLock(after.kernel, after).json).enforcementInputs.entities[target].label).toBe(after.kernel.config.entities[target].label!.serialize())
})
it('relatedColumns drift resolves a different masked hop and retains the UI registration source', async () => {
  const fixture = await queryConsumer()
  const config = join(fixture.root, 'config.ts')
  const text = readFileSync(config, 'utf8').replace("id: 'lock_probe'", "ui: { entities: { jobs: { list: { relatedColumns: { contact: { via: 'client_id', field: 'contact_id' } } } } } }, id: 'lock_probe'")
  writeFileSync(config, text)
  const before = await fixture.load()
  writeFileSync(config, text.replace("field: 'contact_id'", "field: 'hidden_contact_id'"))
  const after = await fixture.load()
  expect(labelPath(before.kernel.config, 'jobs', 'contact')!.hops[1].field).toBe('contact_id')
  expect(labelPath(after.kernel.config, 'jobs', 'contact')!.hops[1].field).toBe('hidden_contact_id')
  expect(readableLabel(before.kernel, fixture.scope, 'jobs', 'contact')!.display).toBe('name')
  expect(readableLabel(after.kernel, fixture.scope, 'jobs', 'contact')).toBeUndefined()
  await expectQueryDrift(before, after, 'ui / entities / jobs / list / relatedColumns / contact / field', 'ui.entities.jobs.list.relatedColumns.contact')
})

it('normalized display expressions, structured conditional labels and related bindings are deterministic across declaration order and locale', async () => {
  const fixture = await queryConsumer()
  const file = join(fixture.root, 'schema/jobs.ts')
  const display = Fn.concat('title', Q.value('!')).serialize()
  writeFileSync(file, readFileSync(file, 'utf8').replace('"displayField":"title"', `"displayField":${JSON.stringify(display)}`))
  const options = await fixture.load({ clients: Fn.if(Cond.isNotNull('name'), Fn.concat('name', Q.value('!')), Q.value('unknown')) })
  const config = options.kernel.config
  config.ui = { entities: { jobs: { list: { relatedColumns: { aa: { via: 'client_id', field: 'contact_id' }, zz: { via: 'client_id', field: 'contact_id' } } } }, contacts: { list: { relatedColumns: {} } } } }
  const before = serializeAccessLock(options.kernel, options)
  const inputs = JSON.parse(before.json).enforcementInputs
  expect(inputs.entities.jobs.displayField).toBe(config.entities.jobs.displayField)
  expect(inputs.entities.jobs.displayField).not.toBe(display)
  expect(inputs.entities.jobs.fields[config.entities.jobs.displayField!].computed).toBe(display)
  const reverse = <T>(value: Record<string, T>) => Object.fromEntries(Object.entries(value).reverse())
  const shuffled = new KernelRegistry({ ...config, roles: [...config.roles].reverse(),
    entities: reverse(Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, { ...entity, fields: reverse(entity.fields) }]))),
    ui: { entities: { contacts: config.ui.entities!.contacts, jobs: { list: { relatedColumns: reverse(config.ui.entities!.jobs.list!.relatedColumns!) } } } },
  }, { plugins: options.kernel.plugins })
  const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) { return this < other ? 1 : this > other ? -1 : 0 })
  try { expect(serializeAccessLock(shuffled, options)).toEqual(before) } finally { locale.mockRestore() }
})
