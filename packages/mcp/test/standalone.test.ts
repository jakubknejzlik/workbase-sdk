import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createServer } from '../src/server'
import { Store } from '../src/storage'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) cleanupTempDir(root) })
async function fixture(id = 'asset_evidence') {
  const directory = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-standalone-')))
  roots.push(directory)
  const root = await realpath(directory)
  await mkdir(join(root, 'migrations'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'hono/jsx' } }))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'config.ts'), `import { defineInstance } from '@workbasehq/core/config'
export default defineInstance({ id: '${id}', displayName: 'Assets', revision: 1,
  entities: { assets: { fields: { name: { type: 'string', required: true } } } },
  roles: ['owner'], permissions: { owner: { assets: ['read'] } } })`)
  return root
}
it('derives the standalone allowlist from config id and uses only the selected root', async () => {
  const root = await fixture()
  const { store, server } = await createServer({ root })
  try {
    expect([...store.allowed]).toEqual(['asset-evidence'])
    expect(await store.directory('asset-evidence')).toBe(root)
    expect((await store.load('asset-evidence')).config.id).toBe('asset_evidence')
    expect((await stat(join(root, 'proposals'))).mode & 0o777).toBe(0o700)
    await expect(store.directory('sample')).rejects.toMatchObject({ code: 'instance_not_allowed' })
  } finally { await server.close() }
})
it('keeps alphanumeric config ids as the instance selector', async () => {
  const { store, server } = await createServer({ root: await fixture('assets') })
  try { expect([...store.allowed]).toEqual(['assets']) } finally { await server.close() }
})
it('does not let an explicit allowlist select another standalone instance', async () => {
  await expect(createServer({ root: await fixture(), allowed: ['sample'] })).rejects.toMatchObject({ code: 'invalid_allowlist' })
})
it('reports missing standalone config as a typed error', async () => {
  const root = await fixture()
  await rm(join(root, 'config.ts'))
  await expect(createServer({ root })).rejects.toMatchObject({ code: 'invalid_instance_directory', status: 400 })
})
it('rejects a symlinked selected root before realpath', async () => {
  const root = await fixture()
  const link = join(root, 'linked-root')
  await symlink(root, link)
  await expect(createServer({ root: link })).rejects.toMatchObject({ code: 'unsafe_path', status: 403 })
})
it.each(['config.ts', 'migrations', 'proposals'])('rejects a standalone symlink at %s', async name => {
  const root = await fixture()
  const outside = await fixture()
  await rm(join(root, name), { recursive: true, force: true })
  await symlink(join(outside, name === 'proposals' ? 'migrations' : name), join(root, name))
  await expect(createServer({ root })).rejects.toMatchObject({ code: 'unsafe_path' })
})
it.each([
  ['migrations', 'node'], ['proposals', 'node'],
  ['migrations', 'bun'], ['proposals', 'bun'],
])('rejects symlinked %s before config imports outside code under %s', async (name, runtime) => {
  const root = await fixture()
  const outside = await fixture()
  const marker = join(outside, 'executed')
  await writeFile(join(outside, 'injected.ts'), `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'executed')
throw new Error('OUTSIDE_CODE_EXECUTED')`)
  await rm(join(root, name), { recursive: true, force: true })
  await symlink(outside, join(root, name))
  await writeFile(join(root, 'config.ts'), `import './${name}/injected.ts'\nexport default {}\n`)
  if (runtime === 'node') {
    await expect(createServer({ root })).rejects.toMatchObject({ code: 'unsafe_path', status: 403 })
  } else {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const script = `
      import { createServer } from ${JSON.stringify(resolve('packages/mcp/src/server.ts'))}
      try { await createServer({ root: ${JSON.stringify(root)} }); process.exitCode = 2 }
      catch (error) { console.log(JSON.stringify({ code: error.code, status: error.status })) }
    `
    const { stdout } = await promisify(execFile)('bun', ['--no-install', '--eval', script], { cwd: root })
    expect(JSON.parse(stdout)).toMatchObject({ code: 'unsafe_path', status: 403 })
  }
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('keeps explicit nested-layout stores working', async () => {
  const root = await fixture()
  await rm(join(root, 'config.ts'))
  await mkdir(join(root, 'instances/demo/migrations'), { recursive: true })
  await writeFile(join(root, 'instances/demo/config.ts'), 'export default {}')
  const store = new Store(root, new Set(['demo']))
  await store.init()
  expect(await store.directory('demo')).toBe(join(root, 'instances/demo'))
})

it('resolves --root relative to cwd and defaults to cwd without walking', async () => {
  const { parseArgs } = await import('../src/cli')
  expect(parseArgs([], '/chosen')).toEqual({ root: '/chosen', agentTest: false })
  expect(parseArgs(['--root', '../instance', '--agent-test'], '/chosen/repo')).toEqual({ root: '/chosen/instance', agentTest: true })
  expect(() => parseArgs(['--root'])).toThrowError(expect.objectContaining({ code: 'invalid_arguments' }))
  expect(() => parseArgs(['--root', '.', '--root', '/other'])).toThrowError(expect.objectContaining({ code: 'invalid_arguments' }))
})

it('Bun reloads atomically promoted config, transitive versions and history JSON in one process', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const root = await fixture()
  const source = `import { defineInstance } from '@workbasehq/core/config'
import history from './config.versions.json'
export default defineInstance({ id: 'asset_evidence', displayName: history.displayName, revision: 1, entities: {}, roles: ['owner'], permissions: { owner: {} } })`
  await writeFile(join(root, 'config.versions.json'), JSON.stringify({ displayName: 'Assets v1' }))
  await writeFile(join(root, 'config.v1.ts'), source)
  await writeFile(join(root, 'config.ts'), "export { default } from './config.v1'\n")
  const script = `
    import { createServer } from ${JSON.stringify(resolve('packages/mcp/src/server.ts'))}
    import { writeFile, rename } from 'node:fs/promises'
    const root = ${JSON.stringify(root)}
    const { store, server } = await createServer({ root })
    const report = async () => {
      const { config } = await store.load('asset-evidence')
      console.log(config.revision, config.displayName)
    }
    await report()
    await writeFile(root + '/config.v1.ts.tmp', ${JSON.stringify(source.replace('revision: 1', 'revision: 2'))})
    await rename(root + '/config.v1.ts.tmp', root + '/config.v1.ts')
    await report()
    await writeFile(root + '/config.ts.tmp', ${JSON.stringify(source.replace('revision: 1', 'revision: 3'))})
    await rename(root + '/config.ts.tmp', root + '/config.ts')
    await report()
    await writeFile(root + '/config.versions.json.tmp', JSON.stringify({ displayName: 'Assets v2' }))
    await rename(root + '/config.versions.json.tmp', root + '/config.versions.json')
    await report()
    await server.close()
  `
  const { stdout } = await promisify(execFile)('bun', ['--no-install', '--eval', script], { cwd: root })
  expect(stdout.trim()).toBe('1 Assets v1\n2 Assets v1\n3 Assets v1\n3 Assets v2')
})
