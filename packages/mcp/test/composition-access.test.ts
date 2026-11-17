import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { loadConfig } from '@workbasehq/core/schema/load'
import { createServer } from '../src/server.ts'
import { schemas } from '../src/schemas.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const grants = Object.fromEntries(accessSystemActions.map(action => [action, 'deny']))
const systemChange = { kind: 'set_system_access', role: 'staff', grants: { ...grants, 'audit.read': 'allow' } }
async function fixture(openapi = false) {
  const root = await mkdtemp(join(tmpdir(), 'composition-access-')); roots.push(root)
  const { server, workflow, store } = await createServer({ root })
  expect(await workflow.call('bootstrap_instance', { id: 'access_fixture', target: 'cloudflare-github' })).toMatchObject({ ok: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
  await writeFile(join(root, 'runtime.ts'), `import { identity } from '@workbasehq/plugins/identity'
import { permissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import config from './config'
export default { ...config, plugins: [identity, permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }), members] }
`)
  if (openapi) execFileSync('bun', [resolve('packages/core/src/openapi/cli.ts'), '--root', root, '--write'], { encoding: 'utf8' })
  else {
    // Keep the absent-artifact cases on a valid, unbound V3 config. The scaffold
    // now binds OpenAPI (#105), so its normal runtime requires generation first.
    const path = join(root, 'config.ts')
    await writeFile(path, (await readFile(path, 'utf8'))
      .replace(', bindOpenApi', '').replace("import spec from './openapi.json'\n", '')
      .replace('bindOpenApi(bindSchemaLock(', 'bindSchemaLock(').replace('}), lock), spec)', '}), lock)'))
  }
  execFileSync('bun', ['run', 'access:lock'], { cwd: root, encoding: 'utf8' })
  await store.init()
  const call = (name: string, args: Record<string, unknown>) => workflow.call(name, args) as Promise<any>
  const propose = async (changes: unknown[]) => {
    const result = await call('propose_composition', { instance: 'access-fixture', baseRevision: 1, changes })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, kind: 'composition_change', status: 'proposed' })
    return result.proposalId as string
  }
  return { root, server, store, call, propose }
}
it.each(['./config', './config.ts'])('template access check passes after promotion beside unrelated config files (%s)', async configImport => {
  const { root, server, call, propose } = await fixture()
  try {
    await writeFile(join(root, 'runtime.ts'), (await readFile(join(root, 'runtime.ts'), 'utf8')).replace("'./config'", `'${configImport}'`))
    await writeFile(join(root, 'config.local.ts'), `throw new Error('unrelated config must not execute')`)
    await writeFile(join(root, 'config.indexes.json'), '[]')
    const proposalId = await propose([{ kind: 'set_interactive', interactive: false }])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    expect(await call('preview_migration', { proposalId })).toMatchObject({ ok: true })
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted' })
    const check = spawnSync('bun', ['run', 'check:access'], { cwd: root, encoding: 'utf8' })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.stdout).toContain('check:access: lock files match')
  } finally { await server.close() }
})
it.each([false, true])('preserves staged authored source locations through access promote (runtime edit: %s)', async runtimeEdit => {
  const { root, server, call, propose } = await fixture()
  try {
    // Match consumers that compose runtime plugins but audit authored config locations.
    await writeFile(join(root, 'scripts/check-access.ts'), `import { syncAccessLock } from '@workbasehq/core/access/lock'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { configSources } from '@workbasehq/core/schema/load'
import config from '../runtime'
const result = await syncAccessLock({ root: process.cwd(), kernel: new KernelRegistry(config), sources: configSources('config.ts'), write: process.argv.includes('--write') })
console.log(result.message)
process.exitCode = result.ok ? 0 : 1
`)
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    manifest.scripts['check:access'] = 'bun scripts/check-access.ts'
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    const accessPath = join(root, 'access.ts'), entityPath = join(root, 'schema/worker.ts')
    await writeFile(accessPath, '// authored access header\n' + (await readFile(accessPath, 'utf8'))
      .replace("  accountLinks: { worker: { invitationRole: 'staff' } },\n", ''))
    await writeFile(entityPath, '// authored entity header\n' + await readFile(entityPath, 'utf8'))
    execFileSync('bun', ['scripts/check-access.ts', '--write'], { cwd: root, encoding: 'utf8' })
    expect(execFileSync('bun', ['run', 'check:access'], { cwd: root, encoding: 'utf8' })).toContain('check:access: lock files match')
    const immutable = ['config.ts', 'schema.lock.json', 'migrations/0001_r1.sql', ...(!runtimeEdit ? ['runtime.ts'] : [])]
    const before = await Promise.all(immutable.map(path => readFile(join(root, path))))
    const proposalId = await propose([
      { kind: 'set_entity_access', entity: 'worker', role: 'staff', access: {
        read: { where: { user: { eq: '$actor.id' } } }, create: 'deny', update: 'deny', delete: 'deny',
      } },
      { kind: 'set_account_link', entity: 'worker', invitationRole: 'staff' },
      { kind: 'set_system_access', role: 'admin', grants: { ...grants,
        'members.read': 'allow', 'members.update': 'allow', 'invitations.create': 'allow', 'invitations.read': 'allow', 'invitations.revoke': 'allow',
      } },
      { kind: 'set_entity_access', entity: 'memberships', role: 'admin', access: { read: 'allow', create: 'deny', update: 'allow', delete: 'deny' } },
      { kind: 'set_entity_access', entity: 'invitations', role: 'admin', access: { read: 'allow', create: 'allow', update: 'deny', delete: 'allow' } },
      ...(runtimeEdit ? [{ kind: 'set_interactive', interactive: false }] : []),
    ])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    const preview = await call('preview_migration', { proposalId })
    expect(await call('apply_to_disposable', { proposalId, keep: false })).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    const check = spawnSync('bun', ['run', 'check:access'], { cwd: root, encoding: 'utf8' })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.stdout).toContain('check:access: lock files match')
    expect(await Promise.all(immutable.map(path => readFile(join(root, path))))).toEqual(before)
    for (const path of ['access.lock.json', 'access.lock.md']) {
      expect(await readFile(join(root, path), 'utf8')).toBe(preview.files.find((file: any) => file.path === path).data)
    }
    const lock = JSON.parse(await readFile(join(root, 'access.lock.json'), 'utf8'))
    const line = (source: string, text: string) => source.slice(0, source.indexOf(text)).split('\n').length
    const accessSource = await readFile(accessPath, 'utf8'), entitySource = await readFile(entityPath, 'utf8')
    expect(lock.sources['access.roles.admin.system.members.read']).toEqual({ file: 'access.ts', line: line(accessSource, '"members.read"') })
    expect(lock.sources['entities.worker.access.staff.read']).toEqual({ file: 'schema/worker.ts', line: line(entitySource, '"read": {') })
    expect(lock.sources['access.accountLinks.worker.invitationRole']).toEqual({ file: 'access.ts', line: line(accessSource, '"invitationRole"') })
    expect(lock.sources['guards.worker/access_invite'].file).toBe('config.ts')
    expect(Object.values(lock.sources).every((source: any) => ['access.ts', 'schema/worker.ts', 'config.ts'].includes(source.file))).toBe(true)
  } finally { await server.close() }
})
it('promotes SDK users access in access.ts while preserving every other users role', async () => {
  const { root, server, call, propose } = await fixture()
  try {
    const before = await loadConfig(join(root, 'config.ts'))
    expect(Object.hasOwn(before.config.entities, 'users')).toBe(true)
    expect(Object.hasOwn(before.authoredAccess.entities, 'users')).toBe(false)
    const access = { read: 'allow', create: 'deny', update: 'deny', delete: 'deny' }
    const proposalId = await propose([{ kind: 'set_entity_access', entity: 'users', role: 'staff', access }])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    const preview = await call('preview_migration', { proposalId })
    expect(preview.files.map((file: any) => file.path)).toEqual(['access.ts', 'access.lock.json', 'access.lock.md'])
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted' })
    const after = await loadConfig(join(root, 'config.ts'))
    expect(after.authoredAccess.shared!.entities.users).toEqual({ ...before.authoredAccess.shared!.entities.users, staff: access })
    const otherRoles = (loaded: typeof before) => loaded.config.effectiveAccess!.entities.filter(rule => rule.entity === 'users' && rule.role !== 'staff')
    expect(otherRoles(after)).toEqual(otherRoles(before))
    expect(after.config.effectiveAccess!.entities).toContainEqual(expect.objectContaining({ entity: 'users', role: 'staff', operation: 'read', decision: 'allow' }))
    expect(execFileSync('bun', ['run', 'check:access'], { cwd: root, encoding: 'utf8' })).toContain('check:access:')
  } finally { await server.close() }
})
it.each(['_migrations', '_ops_relay_run', '_plugin_migrations', 'rateLimit'])('accepts and compiles SDK system entity access: %s', async entity => {
  const { root, server, call, propose } = await fixture()
  try {
    const proposalId = await propose([{ kind: 'set_entity_access', entity, role: 'staff', access: { read: 'allow', create: 'deny', update: 'deny', delete: 'deny' } }])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    const preview = await call('preview_migration', { proposalId })
    expect(preview.files.map((file: any) => file.path)).toEqual(['access.ts', 'access.lock.json', 'access.lock.md'])
    const lock = JSON.parse(preview.files.find((file: any) => file.path === 'access.lock.json').data)
    expect(lock.effectiveAccess.entities).toContainEqual(expect.objectContaining({ entity, role: 'staff', operation: 'read', decision: 'allow' }))
    expect(await readFile(join(root, 'access.ts'), 'utf8')).not.toBe(preview.files[0].data)
    expect(await call('propose_composition', { instance: 'access-fixture', baseRevision: 1,
      changes: [{ kind: 'set_entity_access', entity: '_unknown_system_entity', role: 'staff', access: 'deny' }],
    })).toMatchObject({ ok: false, error: { code: 'invalid_input', status: 400, message: 'Input does not match the tool schema' } })
  } finally { await server.close() }
})
it('accepts the closed SDK entity list only for entity access and retains domain target restrictions', async () => {
  const parse = (change: unknown) => schemas.propose_change.safeParse({ instance: 'access-fixture', baseRevision: 1, changes: [change] }).success
  for (const entity of accessEntities) expect(parse({ kind: 'set_entity_access', entity, role: 'staff', access: 'deny' }), entity).toBe(true)
  // Membership is checked by composition; the init-safe schema only checks shape.
  const { server, call } = await fixture()
  try {
    for (const entity of ['_unknown_system_entity', '../users', 'schema/users', 'Worker', '__proto__', 'constructor', 'prototype', 'a'.repeat(64)]) {
      for (const tool of ['propose_change', 'propose_composition']) {
        expect(await call(tool, { instance: 'access-fixture', baseRevision: 1,
          changes: [{ kind: 'set_entity_access', entity, role: 'staff', access: 'deny' }],
        }), `${tool}: ${entity}`).toMatchObject({ ok: false, error: { code: 'invalid_input', status: 400, message: 'Input does not match the tool schema' } })
      }
    }
  } finally { await server.close() }
  for (const entity of ['_migrations', '_ops_relay_run', '_plugin_migrations', 'rateLimit']) {
    expect(parse({ kind: 'set_account_link', entity, invitationRole: 'staff' }), entity).toBe(false)
    expect(parse({ kind: 'add_entity', entity, fields: {} }), entity).toBe(false)
    expect(parse({ kind: 'set_entity_access', entity: 'worker', role: entity, access: 'deny' }), entity).toBe(false)
  }
})
it('shows a system-grant change in the access-lock diff without creating absent OpenAPI', async () => {
  const { root, server, call, propose } = await fixture()
  try {
    const before = JSON.parse(await readFile(join(root, 'access.lock.json'), 'utf8'))
    const proposalId = await propose([systemChange])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    const preview = await call('preview_migration', { proposalId })
    const after = JSON.parse(preview.files.find((file: any) => file.path === 'access.lock.json').data)
    const grant = (lock: any) => lock.effectiveAccess.system.find((entry: any) => entry.role === 'staff' && entry.action === 'audit.read').decision
    expect(grant(before)).toBe('deny'); expect(grant(after)).toBe('allow')
    expect(preview.files.some((file: any) => file.path === 'openapi.json')).toBe(false)
    expect(await readFile(join(root, 'openapi.json')).catch(() => undefined)).toBeUndefined()
  } finally { await server.close() }
})
it.each([
  [{ ...systemChange, role: 'ghost' }, /access.ts:\d+:\d+:.*Unknown access role: ghost/],
  [{ ...systemChange, grants: { 'audit.read': 'allow' } }, /access.ts:\d+:\d+:.*Missing explicit system action/],
  [{ kind: 'set_entity_access', entity: 'worker', role: 'ghost', access: 'deny' }, /worker.ts:\d+:\d+:.*Unknown access role: ghost/],
])('returns the compiler location for an invalid access edit %#', async (change, message) => {
  const { server, call } = await fixture()
  try {
    const result = await call('propose_composition', { instance: 'access-fixture', baseRevision: 1, changes: [change] })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_access', message: expect.stringMatching(message as RegExp) } })
  } finally { await server.close() }
})
it.each([false, true])('round-trips account links and both entity access targets through promote, preserving domain bytes (OpenAPI present: %s)', async openapi => {
  const { root, server, store, call, propose } = await fixture(openapi)
  try {
    const accessPath = join(root, 'access.ts'), entityPath = join(root, 'schema/worker.ts')
    // Deliberately remove the optional account-link declaration before proposing it.
    const original = (await readFile(accessPath, 'utf8')).replace("  accountLinks: { worker: { invitationRole: 'staff' } },\n", '')
    await writeFile(accessPath, '// header: žluťoučký\r\n' + original + '\n// footer: keep bytes\n')
    await writeFile(entityPath, '// entity header\n' + await readFile(entityPath, 'utf8') + '\n// entity footer\n')
    const immutable = ['config.ts', 'runtime.ts', 'schema.lock.json', 'migrations/0001_r1.sql']
    const before = await Promise.all(immutable.map(path => readFile(join(root, path))))
    const oldSpec = await readFile(join(root, 'openapi.json'), 'utf8').catch(() => undefined)
    const proposalId = await propose([systemChange,
      { kind: 'set_entity_access', entity: 'worker', role: 'staff', access: { read: 'allow', create: 'deny', update: 'deny', delete: 'deny' } },
      { kind: 'set_entity_access', entity: 'sessions', role: 'staff', access: 'deny' },
      { kind: 'set_account_link', entity: 'worker', invitationRole: 'staff' },
    ])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    const preview = await call('preview_migration', { proposalId })
    const spec = preview.files.find((file: any) => file.path === 'openapi.json')?.data
    if (openapi) expect(spec).not.toBe(oldSpec)
    else expect(spec).toBeUndefined()
    expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true, diffs: [] })
    // The expanded publication allowlist must retain journal rollback for every
    // access artifact, including entity sources and a pre-existing OpenAPI file.
    const paths = [...preview.files.map((file: any) => file.path), `proposals/${proposalId}.json`] as string[]
    const rollbackBefore = await Promise.all(paths.map(path => readFile(join(root, path))))
    const bundle = await store.load('access-fixture', { canonicalRuntime: true })
    await expect(store.commit('access-fixture', paths.map(path => ({ path, data: 'injected publication\n' })), bundle.guards,
      async () => { throw new Error('access publication fault') })).rejects.toThrow('access publication fault')
    await store.recover(root)
    expect(await Promise.all(paths.map(path => readFile(join(root, path))))).toEqual(rollbackBefore)
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    expect(await Promise.all(immutable.map(path => readFile(join(root, path))))).toEqual(before)
    const loaded = await loadConfig(join(root, 'config.ts'))
    expect(loaded.config.effectiveAccess?.accountLinks).toEqual({ worker: { invitationRole: 'staff' } })
    if (openapi) expect(JSON.parse(spec)['x-workbase-config-hash']).toBe(loaded.configHash)
    expect(await readFile(join(root, 'openapi.json'), 'utf8').catch(() => undefined)).toBe(spec)
    for (const script of ['check:access', 'check:schema', ...(openapi ? ['check:openapi'] : [])]) {
      expect(execFileSync('bun', ['run', script], { cwd: root, encoding: 'utf8' })).toContain(script + ':')
    }
    expect(await call('submit_change', { instance: 'access-fixture', proposalId, expectedBaseSha: 'a'.repeat(40) }))
      .toMatchObject({ ok: false, error: { code: 'github_not_configured' } })
    const restarted = await createServer({ root })
    try { expect(await restarted.workflow.call('validate', { instance: 'access-fixture' })).toMatchObject({ ok: true }) }
    finally { await restarted.server.close() }
  } finally { await server.close() }
})
it('routes access kinds from propose_change and rejects a mixed legacy proposal', async () => {
  const { server, call } = await fixture()
  try {
    expect(await call('propose_change', { instance: 'access-fixture', baseRevision: 1, changes: [systemChange] }))
      .toMatchObject({ ok: true, kind: 'composition_change' })
    expect(await call('propose_change', { instance: 'access-fixture', baseRevision: 1, changes: [systemChange, { kind: 'add_role', role: 'viewer' }] }))
      .toMatchObject({ ok: false, error: { code: 'mixed_change_kinds' } })
  } finally { await server.close() }
})
it.each(['edit', 'remove', 'add'])('rejects promotion after the OpenAPI artifact changes: %s', async action => {
  const { root, server, call, propose } = await fixture(action !== 'add')
  try {
    const proposalId = await propose([systemChange])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    if (action !== 'remove') await writeFile(join(root, 'openapi.json'), '{}\n')
    else await rm(join(root, 'openapi.json'))
    expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
  } finally { await server.close() }
})
it('validates access and runtime changes together in one composition proof', async () => {
  const { server, call, propose } = await fixture()
  try {
    const proposalId = await propose([systemChange, { kind: 'set_interactive', interactive: false }])
    expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
    const preview = await call('preview_migration', { proposalId })
    expect(preview.files.map((file: any) => file.path)).toEqual(['runtime.ts', 'access.ts', 'access.lock.json', 'access.lock.md'])
  } finally { await server.close() }
})
it('returns a located compiler error for an already missing entity matrix entry', async () => {
  const { root, server, call } = await fixture()
  try {
    const path = join(root, 'schema/worker.ts')
    await writeFile(path, (await readFile(path, 'utf8')).replace(/    staff: .*\n/, ''))
    expect(await call('propose_composition', { instance: 'access-fixture', baseRevision: 1, changes: [systemChange] }))
      .toMatchObject({ ok: false, error: { code: 'invalid_access', message: expect.stringMatching(/worker.ts:\d+:\d+:.*Missing access entry.*staff/) } })
  } finally { await server.close() }
})
