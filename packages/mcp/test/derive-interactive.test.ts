import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as runtimeSource from '../src/composition/runtime-source.ts'
import * as registry from '../src/composition/registry.ts'
import type { CompositionConfig } from '../src/composition/registry.ts'
import type { RuntimeModel } from '../src/composition/runtime-source.ts'
import { createServer } from '../src/server.ts'

// Optional only for loading this same test on the pinned base. Absence is a
// deliberate feature assertion, never a module-resolution error or a skip.
interface InteractiveAPI {
  deriveInteractiveSource?: (source: string, change: unknown, config: CompositionConfig) => {
    model: RuntimeModel; files: { path: string; data: string }[]
  }
}
const api: InteractiveAPI = runtimeSource
function derive() {
  expect(api.deriveInteractiveSource, 'missing feature: deriveInteractiveSource export (including workflow use)').toBeTypeOf('function')
  return api.deriveInteractiveSource!
}
const config = { roles: ['admin', 'staff'], organizationOwnerRole: 'admin' }
const fixtures = [
  {
    name: 'absent interactive with factory', interactive: true,
    source: `import { createIdentity } from '@workbasehq/plugins/identity'
import config from './config'
export default { ...config, plugins: [createIdentity()] }
`,
    golden: `import { createIdentity } from '@workbasehq/plugins/identity'
import config from './config'
export default { ...config, interactive: true, plugins: [
  createIdentity(),
] }
`,
  },
  {
    name: 'existing interactive with factory', interactive: false,
    source: `import { createIdentity } from '@workbasehq/plugins/identity'
import config from './config'
export default { ...config, plugins: [createIdentity()], interactive: true }
`,
    golden: `import { createIdentity } from '@workbasehq/plugins/identity'
import config from './config'
export default { ...config, interactive: false, plugins: [
  createIdentity(),
] }
`,
  },
  {
    name: 'compatibility alias, comments and config-derived permission options', interactive: true,
    source: `// retained header
import { identity /* before-as */ as /* after-as */ id } from '@workbasehq/plugins/identity'
import { permissions as permit } from '@workbasehq/plugins/permissions'
import appConfig from './config.ts'
// authored composition
export default { ...appConfig, plugins: [permit({ roles: ['old'], ownerRole: 'old' }), id] }
// retained footer
`,
    golden: `// retained header
import { createIdentity /* before-as */ as /* after-as */ id } from '@workbasehq/plugins/identity'
import { permissions as permit } from '@workbasehq/plugins/permissions'
import appConfig from './config.ts'
// authored composition
export default { ...appConfig, interactive: true, plugins: [
  id(), permit({ roles: ['admin', 'staff'], ownerRole: 'admin' }),
] }
// retained footer
`,
  },
]
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function scratch(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root)
  return root
}
it.each(fixtures)('derives full byte golden: $name', ({ source, interactive, golden }) => {
  const run = derive()
  const input = deepFreeze({ source, change: { kind: 'set_interactive', interactive }, config: structuredClone(config) })
  const before = structuredClone(input)
  const result = run(input.source, input.change, input.config)
  expect(result.files).toEqual([{ path: 'runtime.ts', data: golden }])
  expect(result.model).toEqual({ interactive, plugins: [
    { plugin: 'identity' },
    ...(source.includes('permit(') ? [{ plugin: 'permissions', options: { roles: ['admin', 'staff'], ownerRole: 'admin' } }] : []),
  ] })
  expect(run(input.source, input.change, input.config)).toEqual(result)
  expect(run(result.files[0].data, input.change, input.config)).toEqual(result)
  expect(input).toEqual(before)
  expect(Object.isFrozen(input.config.roles)).toBe(true)
})
it('uses ordered config values and does not hydrate plugins', () => {
  const run = derive()
  const hydrate = vi.spyOn(registry, 'hydrateRuntimePlugins')
  const factories = Object.values(registry.pluginRegistry).map(entry => vi.spyOn(entry, 'hydrate'))
  const fixture = fixtures[2]
  const result = run(fixture.source, { kind: 'set_interactive', interactive: true },
    { roles: ['staff', 'admin'], organizationOwnerRole: 'staff' })
  expect(result.files).toEqual([{ path: 'runtime.ts', data: fixture.golden.replace("roles: ['admin', 'staff'], ownerRole: 'admin'", "roles: ['staff', 'admin'], ownerRole: 'staff'") }])
  expect(hydrate).not.toHaveBeenCalled()
  for (const factory of factories) expect(factory).not.toHaveBeenCalled()
})
it('emits identical bytes in fresh Node processes with different working directories', async () => {
  derive()
  const fixture = fixtures[2]
  const script = `
    import * as api from ${JSON.stringify(new URL('../src/composition/runtime-source.ts', import.meta.url).href)};
    if (typeof api.deriveInteractiveSource !== 'function') throw new Error('missing feature: deriveInteractiveSource');
    process.stdout.write(JSON.stringify(api.deriveInteractiveSource(${JSON.stringify(fixture.source)},
      {kind: 'set_interactive', interactive: true}, ${JSON.stringify(config)})));
  `
  const results = []
  for (const cwd of [await scratch('derive-cwd-a-'), await scratch('derive-cwd-b-')]) {
    results.push(execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd, encoding: 'utf8' }))
  }
  expect(results[0]).toBe(results[1])
  expect(JSON.parse(results[0]).files).toEqual([{ path: 'runtime.ts', data: fixture.golden }])
})
it.each([
  [], [{ kind: 'set_interactive', interactive: true }], null,
  { kind: 'set_interactive', interactive: true, extra: true },
  { kind: 'set_interactive', interactive: true, path: 'other.ts' },
  { kind: 'set_interactive', interactive: 'true' },
  { kind: 'set_interactive', interactive: 1 }, { kind: 'set_interactive' },
  { kind: 'set_plugin', plugin: 'identity' }, { kind: 'unsupported', interactive: true },
])('rejects operation outside the strict single-operation boundary: %#', change => {
  const run = derive()
  expect(() => run(fixtures[0].source, change, config)).toThrow(expect.objectContaining({ name: 'ZodError' }))
})
it.each([
  (source: string) => source + '\nglobalThis.__deriveExecuted = true\n',
  (source: string) => "import 'node:fs'\n" + source,
  (source: string) => source.replace('@workbasehq/plugins/identity', './execute-consumer.ts'),
  (source: string) => source.replace('createIdentity()]', '(globalThis.__deriveExecuted = true)]'),
  (source: string) => source.replace('createIdentity()]', 'createIdentity(globalThis.__deriveExecuted = true)]'),
  (source: string) => source.replace('plugins:', "['plugins']:"),
  (source: string) => source.replace('plugins:', 'interactive: config.interactive, plugins:'),
])('refuses noncanonical consumer source without executing it: %#', mutate => {
  const run = derive()
  const globals = globalThis as typeof globalThis & { __deriveExecuted?: boolean }
  expect(globals.__deriveExecuted).toBeUndefined()
  expect(() => run(mutate(fixtures[0].source), { kind: 'set_interactive', interactive: true }, config)).toThrow(expect.objectContaining({
    code: 'runtime_not_canonical', message: expect.stringMatching(/runtime\.ts:\d+:\d+:/),
    details: expect.objectContaining({ file: 'runtime.ts', line: expect.any(Number), column: expect.any(Number) }),
  }))
  expect(globals.__deriveExecuted).toBeUndefined()
})

// Valid installed built-in graph: login has identity, permissions, members and
// mail providers. All generated state belongs to the caller's scratch root.
const workflowSource = `// workflow header
import { createIdentity } from '@workbasehq/plugins/identity'
import { permissions } from '@workbasehq/plugins/permissions'
import { createMembers } from '@workbasehq/plugins/members'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import config from './config'
export default { ...config, plugins: [createIdentity(), permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }), createMembers(), createLocalAuth({ methods: ['magic-link'] }), machineCredentials(), mailOutbox()] }
// workflow footer
`
const workflowGolden = `// workflow header
import { createIdentity } from '@workbasehq/plugins/identity'
import { permissions } from '@workbasehq/plugins/permissions'
import { createMembers } from '@workbasehq/plugins/members'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import config from './config'
export default { ...config, interactive: true, plugins: [
  createIdentity(), permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }),
  createMembers(), createLocalAuth({ methods: ['magic-link'] }),
  machineCredentials(), mailOutbox(),
] }
// workflow footer
`
async function workflowFixture() {
  const root = await scratch('derive-workflow-')
  const { server, store, workflow } = await createServer({ root })
  try {
    expect(await workflow.call('bootstrap_instance', { id: 'derive_fixture', target: 'cloudflare-github' })).toMatchObject({ ok: true })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
    execFileSync('bun', [resolve('packages/core/src/openapi/cli.ts'), '--root', root, '--write'], { encoding: 'utf8' })
    await writeFile(join(root, 'runtime.ts'), workflowSource)
    execFileSync('bun', ['run', 'access:lock'], { cwd: root, encoding: 'utf8' })
    await store.init()
    const call = (name: string, args: Record<string, unknown>) => workflow.call(name, args) as Promise<any>
    return { root, server, call }
  } catch (error) { await server.close(); throw error }
}
it('routes a single set_interactive through derivation and preserves preview bytes and revision', async () => {
  derive()
  const spy = vi.spyOn(api, 'deriveInteractiveSource')
  const { root, server, call } = await workflowFixture()
  try {
    const change = { kind: 'set_interactive', interactive: true }
    const proposal = await call('propose_composition', { instance: 'derive-fixture', baseRevision: 1, changes: [change] })
    expect(proposal).toMatchObject({ ok: true, status: 'proposed' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenLastCalledWith(workflowSource, change, expect.objectContaining(config))
    expect(await call('validate', { proposalId: proposal.proposalId })).toMatchObject({ ok: true, revision: 1 })
    const preview = await call('preview_migration', { proposalId: proposal.proposalId })
    expect(preview).toMatchObject({ ok: true, revision: 1, sql: '' })
    expect(preview.files.filter((file: { path: string }) => file.path === 'runtime.ts')).toEqual([{ path: 'runtime.ts', data: workflowGolden }])
    expect(spy).toHaveBeenCalledTimes(3)
    expect(await call('preview_migration', { proposalId: proposal.proposalId })).toEqual(preview)
    expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(workflowSource)
  } finally { await server.close() }
})
it.each(['multiple-runtime', 'role-only'] as const)('retains the existing %s path and expected bytes', async mode => {
  derive()
  const spy = vi.spyOn(api, 'deriveInteractiveSource')
  const { root, server, call } = await workflowFixture()
  try {
    const changes = mode === 'multiple-runtime'
      ? [{ kind: 'set_interactive', interactive: true }, { kind: 'set_plugin', plugin: 'identity' }]
      : [{ kind: 'set_roles', roles: ['staff', 'admin'], organizationOwnerRole: 'admin' }]
    const proposal = await call('propose_composition', { instance: 'derive-fixture', baseRevision: 1, changes })
    expect(proposal).toMatchObject({ ok: true, status: 'proposed' })
    expect(await call('validate', { proposalId: proposal.proposalId })).toMatchObject({ ok: true, revision: 1 })
    const preview = await call('preview_migration', { proposalId: proposal.proposalId })
    expect(preview).toMatchObject({ ok: true, revision: 1, sql: '' })
    const expected = mode === 'multiple-runtime' ? workflowGolden : workflowSource.replace("roles: ['admin', 'staff']", "roles: ['staff', 'admin']")
    expect(preview.files.filter((file: { path: string }) => file.path === 'runtime.ts')).toEqual([{ path: 'runtime.ts', data: expected }])
    expect(await call('preview_migration', { proposalId: proposal.proposalId })).toEqual(preview)
    expect(spy).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(workflowSource)
  } finally { await server.close() }
})
it('still refuses enabling interactive login without its provider downstream', async () => {
  derive()
  const spy = vi.spyOn(api, 'deriveInteractiveSource')
  const { root, server, call } = await workflowFixture()
  try {
    await writeFile(join(root, 'runtime.ts'), workflowSource.replace("createLocalAuth({ methods: ['magic-link'] }), ", ''))
    expect(await call('propose_composition', { instance: 'derive-fixture', baseRevision: 1,
      changes: [{ kind: 'set_interactive', interactive: true }] })).toMatchObject({ ok: false, error: { code: 'invalid_composition' } })
    expect(spy).toHaveBeenCalledTimes(1)
  } finally { await server.close() }
})
