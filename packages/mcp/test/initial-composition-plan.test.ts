import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { bootstrapInstance } from '../src/bootstrap.ts'
import { planInitialComposition } from '../src/composition/initial-plan.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'
import { byteHash } from '../src/byte-digest.ts'

const selection = { interactive: false, plugins: [
  { plugin: 'identity' }, { plugin: 'permissions' }, { plugin: 'members' },
  { plugin: 'organizations', options: { allowCreate: true } },
  { plugin: 'local-auth', options: { methods: ['magic-link'] } },
  { plugin: 'machine-credentials' }, { plugin: 'mail-outbox' },
] }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(provision = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'initial-composition-'))); roots.push(root)
  await bootstrapInstance(root, { id: 'fresh_instance', target: 'cloudflare-github' })
  if (provision) await symlink(resolve('node_modules'), join(root, 'node_modules'))
  return { root, plan: (input: unknown = selection) => planInitialComposition(root, 'fresh-instance', input) }
}
async function tree(root: string): Promise<unknown> {
  const result: unknown[] = []
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), stat = await lstat(path, { bigint: true })
    result.push([name, stat.mode.toString(), stat.ino.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(),
      stat.isSymbolicLink() ? await readlink(path) : stat.isDirectory() ? await tree(path) : (await readFile(path)).toString('base64')])
  }
  return result
}
it('plans only the exact selected seven plugins, returning deterministic six-file bytes and hashes without writes', async () => {
  const a = await fixture(), b = await fixture()
  const before = await tree(a.root), other = await tree(b.root)
  const first = await a.plan(), repeat = await a.plan(), reordered = await b.plan({ ...selection, plugins: [...selection.plugins].reverse() })
  expect(repeat).toEqual(first)
  expect(reordered).toEqual(first)
  expect(first.files.map(file => file.path)).toEqual(['runtime.ts', 'schema.lock.json', 'migrations/0001_r1.sql', 'openapi.json', 'access.lock.json', 'access.lock.md'])
  for (const file of first.files) expect(file.hash).toBe(createHash('sha256').update(file.data).digest('hex'))
  const runtime = first.files[0].data
  expect(parseRuntimeSource(runtime)).toEqual(first.model)
  expect(first.model).toEqual({ interactive: false, plugins: selection.plugins.map(plugin => plugin.plugin === 'permissions'
    ? { plugin: 'permissions', options: { roles: ['admin', 'staff'], ownerRole: 'admin' } } : plugin) })
  expect(runtime).not.toMatch(/audit|console/)
  expect(first.guards['runtime.ts']).toBe(byteHash(await readFile(join(a.root, 'runtime.ts'))))
  expect(JSON.parse(first.files[1].data).revision).toBe(1)
  expect(first.requirements).toEqual(expect.arrayContaining([
    expect.objectContaining({ plugin: 'mail-outbox', requirement: 'EMAIL', severity: 'warning' }),
    expect.objectContaining({ plugin: 'local-auth', requirement: 'better-auth-als-preseed', severity: 'warning' }),
  ]))
  expect(await tree(a.root)).toEqual(before); expect(await tree(b.root)).toEqual(other)
})
it.each([
  ['unknown plugin', { interactive: false, plugins: [{ plugin: 'private-canary' }] }],
  ['unknown options', { interactive: false, plugins: [{ plugin: 'identity', options: { privateCanary: true } }] }],
  ['duplicate', { interactive: false, plugins: [{ plugin: 'identity' }, { plugin: 'identity' }] }],
  ['permissions options', { interactive: false, plugins: [{ plugin: 'permissions', options: { roles: ['admin'] } }] }],
  ['missing interactive', { plugins: [] }],
])('returns sanitized structured selection diagnostics for %s without writes', async (_name, input) => {
  const { root, plan } = await fixture(), before = await tree(root)
  await expect(plan(input)).rejects.toMatchObject({ code: 'invalid_initial_composition', status: 422,
    details: { diagnostics: expect.arrayContaining([expect.objectContaining({ path: expect.any(Array), message: expect.any(String) })]) } })
  try { await plan(input) } catch (error) { expect(JSON.stringify(error)).not.toMatch(/private-canary|privateCanary/) }
  expect(await tree(root)).toEqual(before)
})
it.each([
  ['provider', { interactive: false, plugins: [{ plugin: 'members' }] }, 'permissions'],
  ['login', { interactive: true, plugins: [{ plugin: 'identity' }] }, 'login'],
])('refuses missing %s without injecting any plugin', async (_name, input, requirement) => {
  const { root, plan } = await fixture(), before = await tree(root)
  await expect(plan(input)).rejects.toMatchObject({ code: 'composition_requirements_unsatisfied', status: 422,
    details: { requirements: expect.arrayContaining([expect.objectContaining({ requirement, satisfied: false, severity: 'error', message: expect.any(String) })]) } })
  expect(await tree(root)).toEqual(before)
})
it('preserves infrastructure requirement errors and warnings from the shared observer', async () => {
  const { root, plan } = await fixture()
  await writeFile(join(root, 'wrangler.jsonc'), '{}')
  const before = await tree(root)
  await expect(plan({ ...selection, plugins: [...selection.plugins, { plugin: 'audit' }, { plugin: 'console' }] })).rejects.toMatchObject({
    code: 'composition_requirements_unsatisfied', details: { requirements: expect.arrayContaining([
      expect.objectContaining({ requirement: 'AUDIT_KV', satisfied: false, severity: 'error' }),
      expect.objectContaining({ requirement: 'EVENTS_QUEUE', satisfied: false, severity: 'warning' }),
    ]) },
  })
  expect(await tree(root)).toEqual(before)
  const result = await plan()
  expect(result.requirements).toContainEqual(expect.objectContaining({ requirement: 'EMAIL', satisfied: false, severity: 'warning' }))
})
it.each(['schema.lock.json', 'openapi.json', 'access.lock.json', 'access.lock.md', 'migrations/0001_r1.sql', 'migrations/0002_r2.sql', 'runtime.ts', 'config.ts'])
('refuses existing artifacts, history or authored runtime at %s without writes', async path => {
  const { root, plan } = await fixture()
  const data = path === 'runtime.ts' ? await readFile(join(root, path), 'utf8') + '// authored\n'
    : path === 'config.ts' ? 'export default {}\n' : 'authored\n'
  await writeFile(join(root, path), data)
  const before = await tree(root)
  await expect(plan()).rejects.toMatchObject({ code: 'fresh_state_conflict', status: 409,
    details: { conflicts: expect.arrayContaining([path]), remedy: expect.any(String) } })
  expect(await tree(root)).toEqual(before)
})
it('refuses a complete matching initialized set as well as partial sets', async () => {
  const { root, plan } = await fixture(), first = await plan()
  for (const file of first.files.slice(1)) await writeFile(join(root, file.path), file.data)
  const before = await tree(root)
  await expect(plan()).rejects.toMatchObject({ code: 'fresh_state_conflict', status: 409 })
  expect(await tree(root)).toEqual(before)
})
it.each(['schema/worker.ts', 'config.ts', 'access.ts', 'package.json', 'bun.lock', 'wrangler.jsonc', 'src/index.ts'])
('binds exact %s bytes into plan identity and guards', async path => {
  const { root, plan } = await fixture(), first = await plan()
  const original = await readFile(join(root, path)).catch(() => Buffer.alloc(0))
  // Invalid UTF-8 in a JSON whitespace/comment slot still has to change its byte guard.
  const suffix = path === 'bun.lock' ? Buffer.from([0x80]) : Buffer.from(path.endsWith('.ts') ? '\n// byte guard\n' : '\n ')
  await writeFile(join(root, path), Buffer.concat([original, suffix]))
  const before = await tree(root), second = await plan()
  expect(second.planHash).not.toBe(first.planHash)
  expect(second.guards[path]).toBe(byteHash(await readFile(join(root, path))))
  expect(await tree(root)).toEqual(before)
})
it('changes identity for a different selection and canonicalizes option record order', async () => {
  const { plan } = await fixture(), first = await plan()
  expect((await plan({ ...selection, plugins: selection.plugins.filter(item => item.plugin !== 'mail-outbox') })).planHash).not.toBe(first.planHash)
  const issuers = { 'https://b.example.test': ['b'], 'https://a.example.test': ['a'] }
  const withIssuers = (trustedIssuers: typeof issuers) => ({ ...selection, plugins: selection.plugins.map(item => item.plugin === 'identity' ? { ...item, options: { trustedIssuers } } : item) })
  expect(await plan(withIssuers(issuers))).toEqual(await plan(withIssuers({ 'https://a.example.test': ['a'], 'https://b.example.test': ['b'] })))
})
it.each(['missing', 'incompatible'])('keeps structured initialization refusal for %s SDK dependencies', async kind => {
  const { root, plan } = await fixture(false)
  if (kind === 'incompatible') {
    const core = join(root, 'node_modules/@workbasehq/core'); await mkdir(core, { recursive: true })
    await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@workbasehq/core', version: '0.0.0', exports: { './schema': './schema.ts' } }))
    await writeFile(join(core, 'schema.ts'), "throw new Error('private-canary')")
  }
  const before = await tree(root)
  await expect(plan()).rejects.toMatchObject({ code: 'dependencies_missing', status: 422, details: { package: '@workbasehq/core', remedy: expect.any(String) } })
  expect(await tree(root)).toEqual(before)
})
it('binds installed SDK entrypoint bytes without depending on the root path', async () => {
  const { root, plan } = await fixture(false)
  await mkdir(join(root, 'node_modules/@workbasehq'), { recursive: true })
  for (const name of ['core', 'plugins']) await cp(resolve('packages', name), join(root, 'node_modules/@workbasehq', name), {
    recursive: true, filter: path => !['node_modules', 'test', 'ui'].includes(path.split('/').at(-1)!),
  })
  // Resolve each actual runtime dependency from its producer workspace, as the initializer harness does.
  for (const owner of ['core', 'plugins']) {
    const manifest = JSON.parse(await readFile(resolve('packages', owner, 'package.json'), 'utf8'))
    for (const name of Object.keys(manifest.dependencies)) {
      const destination = join(root, 'node_modules', name)
      try { await lstat(destination); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await mkdir(dirname(destination), { recursive: true })
      await symlink(await realpath(resolve('packages', owner, 'node_modules', name)), destination)
    }
  }
  const first = await plan(), path = join(root, 'node_modules/@workbasehq/plugins/members/src/index.ts')
  await writeFile(path, await readFile(path, 'utf8') + '\n// dependency byte guard\n')
  const before = await tree(root), second = await plan()
  expect(second.planHash).not.toBe(first.planHash)
  expect(second.dependencies['@workbasehq/plugins/members']).not.toBe(first.dependencies['@workbasehq/plugins/members'])
  expect(second.files).toEqual(first.files)
  expect(await tree(root)).toEqual(before)
})
it.each(['computed', 'syntax', 'caller revision'])('returns a fresh-state conflict for %s declarations without writes', async kind => {
  const { root, plan } = await fixture()
  const source = await readFile(join(root, 'config.ts'), 'utf8')
  const changed = kind === 'computed' ? source.replace('defineConfig({', "defineConfig({ ...(() => { throw new Error('private-canary') })(),")
    : kind === 'syntax' ? source + '\nexport default {\n' : source.replace("id: 'fresh_instance'", "revision: 2, id: 'fresh_instance'")
  await writeFile(join(root, 'config.ts'), changed)
  const before = await tree(root)
  await expect(plan()).rejects.toMatchObject({ code: 'fresh_state_conflict', status: 409,
    details: { conflicts: ['config.ts'], remedy: expect.any(String) } })
  expect(await tree(root)).toEqual(before)
})
