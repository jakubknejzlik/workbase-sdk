import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

async function linkDependency(root: string, name: string, source: string) {
  const destination = join(root, 'node_modules', name)
  try { await lstat(destination); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(dirname(destination), { recursive: true })
  await symlink(await realpath(source), destination)
}

/** Local SDK sources and internal package links; transitive provenance is outside this contract. */
export async function provisionLocalSdk(root: string) {
  await mkdir(join(root, 'node_modules/@workbasehq'), { recursive: true })
  for (const owner of ['core', 'plugins']) {
    const local = join(root, 'node_modules/.sdk', owner)
    await cp(resolve('packages', owner), local, {
      recursive: true, filter: path => !['node_modules', 'test'].includes(path.split('/').at(-1)!),
    })
    await symlink(local, join(root, 'node_modules/@workbasehq', owner))
    const manifest = JSON.parse(await readFile(resolve('packages', owner, 'package.json'), 'utf8'))
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (name.startsWith('@workbasehq/')) continue
      await linkDependency(root, name, resolve('packages', owner, 'node_modules', name))
    }
  }
  // The scaffold's compiler ambient types previously came from producer node_modules.
  for (const name of ['@types/node', '@cloudflare/workers-types']) await linkDependency(root, name, resolve('node_modules', name))
}

/** Executable import spy, using JavaScript so resolution failures cannot hide behind transitive imports. */
export async function provisionProbeSdk(root: string, marker: string) {
  const { version } = JSON.parse(await readFile(resolve('packages/core/package.json'), 'utf8'))
  for (const owner of ['core', 'plugins']) {
    const local = join(root, 'node_modules/@workbasehq', owner)
    await mkdir(local, { recursive: true })
    await Promise.all([
      writeFile(join(local, 'package.json'), JSON.stringify({ name: `@workbasehq/${owner}`, version, type: 'module', exports: { './*': './index.js' } })),
      writeFile(join(local, 'index.js'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(owner + '\n')});`),
    ])
  }
}
