import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { stateRoot } from '../disposable.ts'
import { noLink, json, type Bundle } from '../storage.ts'
import { fail, WorkflowError, type CatalogChange } from '../schemas.ts'
import { hash } from '../planning.ts'
import { replaySources } from '../replay-sources.ts'

export async function catalogPlan(root: string, changes: CatalogChange[]) {
  const files = new Map<string, string>()
  for (const change of changes) {
    const path = `locales/${change.language}/${change.namespace}.json`
    await noLink(join(root, path), true)
    let catalog: Record<string, string> = {}
    try {
      const value = JSON.parse(files.get(path) ?? await readFile(join(root, path), 'utf8'))
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(value => typeof value !== 'string' || !value.trim())) throw new Error('Expected nonempty flat string catalog')
      catalog = value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new WorkflowError('invalid_catalog', `Repair malformed catalog ${path}: ${String(error)}`, 422)
    }
    files.set(path, json({ ...catalog, ...change.entries }))
  }
  return [...files].map(([path, data]) => ({ path, data }))
}

/** Validate exactly the captured graph with every proposed edit overlaid. */
export async function validatePresentation(root: string, files: { path: string; data: string }[], guards: Bundle['guards']) {
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const stage = await realpath(await mkdtemp(join(stateRoot, 'presentation-')))
  try {
    const inputs: Record<string, Buffer> = { ...await replaySources(root, { accessLock: true, presentation: true }), 'config.ts': await readFile(join(root, 'config.ts')) }
    // Bind the graph actually checked below to the snapshot used by the proof,
    // including deletions and files that appeared between load and staging.
    const stagedInput = /^(?:config\.ts$|runtime\.ts$|access\.ts$|schema\/|schema\.lock\.json$|access\.lock\.(?:json|md)$|openapi\.json$|ui\/|locales\/|proposals\/)/
    for (const path of new Set([...Object.keys(inputs), ...Object.keys(guards).filter(path => stagedInput.test(path))])) {
      const actual = inputs[path] === undefined ? null : hash(inputs[path].toString('utf8'))
      if (actual !== (guards[path] ?? null)) fail('stale_revision', `Presentation input changed while staging: ${path}; inspect and recreate the proposal`, 409)
    }
    const edits = new Map(files.map(file => [file.path, file.data]))
    for (const path of new Set([...Object.keys(inputs), ...edits.keys()])) {
      await mkdir(dirname(join(stage, path)), { recursive: true })
      await writeFile(join(stage, path), edits.get(path) ?? inputs[path])
    }
    // Consumer dependencies can live at an ancestor (workspace/nested consumer).
    let parent = root
    while (!(await stat(join(parent, 'node_modules')).catch(() => null))?.isDirectory()) {
      if (dirname(parent) === parent) fail('dependencies_missing', 'Install consumer UI dependencies before validating presentation', 409)
      parent = dirname(parent)
    }
    await symlink(join(parent, 'node_modules'), join(stage, 'node_modules'))
    const errors = (await (await import('@workbasehq/plugins/console/ui/check')).validateInstance(stage, { sdkResolutionRoot: root })).map(error => ({ ...error,
      file: error.file.startsWith(stage + '/') ? join(root, relative(stage, error.file)) : error.file,
      message: error.message?.replaceAll(stage, root),
    }))
    if (errors.length) throw new WorkflowError('invalid_presentation', 'Complete the dictionaries for every enabled language; use inspect_schema dictionaries.requiredKeys and pluralCategories, then recreate the proposal with explicit translations', 422, errors)
  } finally { await rm(stage, { recursive: true, force: true }) }
}
