import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { configSource } from '../src/storage'
import { historical, secondary, tertiary, quaternary, migrations } from './fixtures/model'

/** Synthetic versioned configs keep promotion tests independent of deployment sources. */
export async function copyHistoricalInstances(root: string) {
  await mkdir(root, { recursive: true })
  for (const config of [historical, secondary, tertiary, quaternary]) {
    const parent = config.id === 'quaternary' ? 'instances' : 'examples'
    const target = join(root, parent, config.id)
    await mkdir(join(target, 'migrations'), { recursive: true })
    await symlink(resolve('node_modules'), join(target, 'node_modules'))
    await writeFile(join(target, 'config.ts'), "export { default } from './config.v" + config.revision + "'\n")
    await writeFile(join(target, `config.v${config.revision}.ts`), configSource(config))
    await writeFile(join(target, 'config.versions.json'), '[]\n')
    for (const migration of migrations(config)) await writeFile(join(target, 'migrations', migration.name), migration.sql)
  }
}
