import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadConfig } from '@workbasehq/core/schema/load'
import { bindSchemaLock } from '@workbasehq/core/schema'
import { plan } from '@workbasehq/core/migrations/schema-plan'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { accessPlan } from './composition/plan.ts'
import { parseRuntimeSource, rewritePermissionsSource } from './composition/runtime-source.ts'
import { hydrateRuntimePlugins } from './composition/registry.ts'
import { noLink } from './paths.ts'
import { stateRoot } from './disposable.ts'
import { fail, type InitialComposition } from './schemas.ts'

/** Private staging only. No existing consumer root or target is read or changed.
 * Keep the ordinary init CLI core-free by loading this module only on opt-in. */
export async function renderInitialComposition(files: Map<string, string>, initial: InitialComposition) {
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const staging = await realpath(await mkdtemp(join(stateRoot, 'bootstrap-')))
  try {
    for (const [path, data] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true })
      await writeFile(join(staging, path), data)
    }
    const original = await loadConfig(join(staging, 'config.ts'))
    const baseline = await plan({ config: original.config, sources: original.sources, baseMigrations: {} })
    // The shared set_roles planner checks the final graph against this private
    // physical baseline. This lock is never published by bootstrap.
    await writeFile(join(staging, 'schema.lock.json'), baseline.lock)
    const target = await accessPlan(staging, [
      { kind: 'set_roles', roles: initial.roles, organizationOwnerRole: initial.organizationOwnerRole },
      ...initial.access,
    ])
    for (const { path, data } of target.files) {
      files.set(path, data)
      await writeFile(join(staging, path), data)
    }
    const source = rewritePermissionsSource(files.get('runtime.ts')!, target.config)
    files.set('runtime.ts', source)
    await writeFile(join(staging, 'runtime.ts'), source)
    const final = await loadConfig(join(staging, 'config.ts'), { bindExistingLock: false })
    const physical = await plan({ config: final.config, sources: final.sources, baseMigrations: {} })
    if (physical.lock !== baseline.lock || physical.bundle?.sql !== baseline.bundle?.sql) {
      fail('schema_lock_mismatch', 'Initial composition must preserve default physical schema, domain migration bytes and revision', 422)
    }
    bindSchemaLock(final.config, JSON.parse(physical.lock))
    const runtime = parseRuntimeSource(source)
    new KernelRegistry({ ...final.config, interactive: runtime.interactive, plugins: hydrateRuntimePlugins(runtime, final.config) })
    return files
  } finally { await rm(staging, { recursive: true, force: true }) }
}
