import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/storage'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) cleanupTempDir(root) })
async function fixture() {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-storage-paths-')))
  roots.push(root)
  return await realpath(root)
}
async function configuration(directory: string) {
  await mkdir(join(directory, 'migrations'), { recursive: true })
  await writeFile(join(directory, 'config.ts'), 'export default {}\n')
}
it.each(['examples', 'instances'])('resolves an allowlisted configuration under %s when the other root is absent', async parent => {
  const root = await fixture()
  const directory = join(root, parent, 'demo')
  await configuration(directory)
  const store = new Store(root, new Set(['demo']))
  await store.init()
  expect(await store.directory('demo')).toBe(directory)
  await expect(store.directory('other')).rejects.toMatchObject({ code: 'instance_not_allowed' })
})
it('resolves examples and real instances together without guessing from their names', async () => {
  const root = await fixture()
  await configuration(join(root, 'examples/sample'))
  await configuration(join(root, 'instances/client'))
  const store = new Store(root, new Set(['sample', 'client']))
  await store.init()
  expect(await store.directory('sample')).toBe(join(root, 'examples/sample'))
  expect(await store.directory('client')).toBe(join(root, 'instances/client'))
})
it.each(['.wrangler/state', '.seed-credentials.local', 'proposals'])('ignores an instance directory containing only leftover %s beside a real example', async artifact => {
  const root = await fixture()
  const directory = join(root, 'examples/demo')
  await configuration(directory)
  const leftover = join(root, 'instances/demo', artifact)
  if (artifact === '.seed-credentials.local') {
    await mkdir(join(root, 'instances/demo'), { recursive: true })
    await writeFile(leftover, 'local credentials\n')
  } else await mkdir(leftover, { recursive: true })
  const store = new Store(root, new Set(['demo']))
  await store.init()
  expect(await store.directory('demo')).toBe(directory)
})
it('refuses two real configurations with the same name in both roots', async () => {
  const root = await fixture()
  for (const parent of ['examples', 'instances']) await configuration(join(root, parent, 'demo'))
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'invalid_instance_directory' })
})
it.each(['examples', 'instances'])('rejects a symlinked %s root', async parent => {
  const root = await fixture()
  await mkdir(join(root, 'outside/demo/migrations'), { recursive: true })
  await symlink(join(root, 'outside'), join(root, parent))
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'unsafe_path' })
})
it.each(['examples', 'instances'])('rejects a symlinked %s candidate directory', async parent => {
  const root = await fixture()
  const outside = await fixture()
  await configuration(join(outside, 'demo'))
  await mkdir(join(root, parent))
  await symlink(join(outside, 'demo'), join(root, parent, 'demo'))
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'unsafe_path' })
})
it.each(['examples', 'instances'])('rejects a symlinked %s candidate even with a real counterpart', async parent => {
  const root = await fixture()
  const outside = await fixture()
  await configuration(join(outside, 'demo'))
  await mkdir(join(root, parent))
  await symlink(join(outside, 'demo'), join(root, parent, 'demo'))
  await configuration(join(root, parent === 'examples' ? 'instances' : 'examples', 'demo'))
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'unsafe_path' })
})
it.each(['examples', 'instances'])('rejects a symlinked config.ts in a real %s directory', async parent => {
  const root = await fixture()
  const outside = await fixture()
  await configuration(join(outside, 'demo'))
  const directory = join(root, parent, 'demo')
  await mkdir(join(directory, 'migrations'), { recursive: true })
  await symlink(join(outside, 'demo/config.ts'), join(directory, 'config.ts'))
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'unsafe_path' })
})
it.each(['examples', 'instances'])('ignores a %s directory whose config.ts is a directory', async parent => {
  const root = await fixture()
  const directory = join(root, parent, 'demo')
  await mkdir(join(directory, 'migrations'), { recursive: true })
  await mkdir(join(directory, 'config.ts'))
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'invalid_instance_directory' })
})
it.each(['examples', 'instances'])('selects a real counterpart when %s contains a directory named config.ts', async parent => {
  const root = await fixture()
  await mkdir(join(root, parent, 'demo/config.ts'), { recursive: true })
  const directory = join(root, parent === 'examples' ? 'instances' : 'examples', 'demo')
  await configuration(directory)
  const store = new Store(root, new Set(['demo']))
  await store.init()
  expect(await store.directory('demo')).toBe(directory)
})

async function missingConfigJournal(directory: string) {
  await mkdir(join(directory, 'proposals'), { recursive: true })
  await writeFile(join(directory, 'proposals/.promotion.json'), JSON.stringify({ version: 2, files: [
    { path: 'config.ts', before: Buffer.from('export default {}\n').toString('base64'), afterHash: '0'.repeat(64) },
  ] }))
  await rm(join(directory, 'config.ts'))
}
it.each(['examples', 'instances'])('recovers an allowlisted %s configuration temporarily absent during publication', async parent => {
  const root = await fixture(), directory = join(root, parent, 'demo')
  await configuration(directory); await missingConfigJournal(directory)
  const store = new Store(root, new Set(['demo']))
  await store.init()
  expect(await store.directory('demo')).toBe(directory)
})
it('refuses an absent config with a journal beside another configuration of the same name', async () => {
  const root = await fixture()
  await configuration(join(root, 'examples/demo')); await configuration(join(root, 'instances/demo'))
  await missingConfigJournal(join(root, 'instances/demo'))
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'invalid_instance_directory' })
})
it.each(['proposals', 'journal'])('rejects symlinked recovery %s when config is absent', async kind => {
  const root = await fixture(), directory = join(root, 'examples/demo'), outside = await fixture()
  await configuration(directory); await missingConfigJournal(directory)
  if (kind === 'proposals') {
    await rm(join(directory, 'proposals'), { recursive: true })
    await symlink(outside, join(directory, 'proposals'))
  } else {
    await rm(join(directory, 'proposals/.promotion.json'))
    await writeFile(join(outside, 'journal'), '{}')
    await symlink(join(outside, 'journal'), join(directory, 'proposals/.promotion.json'))
  }
  await expect(new Store(root, new Set(['demo'])).init()).rejects.toMatchObject({ code: 'unsafe_path' })
})
