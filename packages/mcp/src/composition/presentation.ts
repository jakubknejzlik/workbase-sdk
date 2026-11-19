import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { stateRoot } from '../disposable.ts'
import { noLink, json, type Bundle } from '../storage.ts'
import { fail, WorkflowError, type CatalogChange, type LabelChange } from '../schemas.ts'
import type { InstanceConfig } from '@workbasehq/core/config'
import { byteHash } from '../byte-digest.ts'
import { replaySources } from '../replay-sources.ts'

/** Typed captions become ordinary catalog edits in the existing presentation batch. */
export function labelCatalog(config: InstanceConfig, change: LabelChange): CatalogChange {
  if (change.entity === 'users' || !Object.hasOwn(config.entities, change.entity)) fail('unknown_entity', `Unknown authored entity: ${change.entity}`)
  const entries: Record<string, string> = {}
  if (change.field !== undefined) {
    if (!Object.hasOwn(config.entities[change.entity].fields, change.field)) fail('unknown_field', `Unknown field: ${change.entity}.${change.field}`)
    entries[`field.${change.entity}.${change.field}`] = change.label!
  } else {
    const categories = new Intl.PluralRules(change.language).resolvedOptions().pluralCategories
    const missing = categories.filter(category => change.pluralForms?.[category] === undefined)
    const extra = Object.keys(change.pluralForms ?? {}).filter(category => !categories.includes(category as Intl.LDMLPluralRule))
    if (change.plural !== undefined || missing.length || extra.length) {
      fail('invalid_plural_forms', `V3 entity ${change.entity} (${change.language}) requires explicit pluralForms for ${categories.join(', ')}; missing: ${missing.join(', ') || 'none'}; unsupported: ${extra.join(', ') || 'none'}. Replace legacy plural with pluralForms; use inspect_schema dictionaries.pluralCategories.`, 422)
    }
    for (const category of categories) entries[`entity.${change.entity}_${category}`] = change.pluralForms![category]!
    if (change.singular !== undefined) entries[`entity.${change.entity}.singular`] = change.singular
    if (change.object !== undefined) entries[`entity.${change.entity}.object`] = change.object
  }
  return { kind: 'set_catalog_entries', language: change.language, namespace: 'domain', entries }
}

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
      const actual = inputs[path] === undefined ? null : byteHash(inputs[path])
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
