import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { SourceError } from '@workbasehq/core/schema/load'
import { WorkflowError, initialCompositionSchema } from '../schemas.ts'
import { initializationPaths, initializationSnapshot, loadInitializationInputs, planInitialization } from '../initialization-plan.ts'
import { hash } from '../planning.ts'
import { hydrateRuntimePlugins } from './registry.ts'
import { parseRuntimeSource, printRuntimeSource, rewritePermissionsSource } from './runtime-source.ts'
import { assertCompositionRequirements, compositionRequirements, type CompositionRequirement } from './requirements.ts'

// Options records have no authored ordering. Canonicalize recursively before rendering.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => [key, canonical(child)]))
  return value
}

function freshStateConflict(conflicts: string[]): never {
  throw new WorkflowError('fresh_state_conflict', 'Initial composition planning requires an uninitialized literal V3 scaffold with untouched bootstrap runtime', 409, {
    conflicts: [...new Set(conflicts)].sort(),
    remedy: 'Use a fresh bootstrap_instance scaffold with literal V3 declarations and no caller-supplied revision. Preserve existing artifacts, history and authored runtime; use existing-instance proposals after initialization.',
  })
}

/** Stage an exact fresh composition in memory; no Store, locks, metadata or publication. */
export async function planInitialComposition(root: string, instance: string, input: unknown) {
  const parsed = initialCompositionSchema.safeParse(input)
  if (!parsed.success) throw new WorkflowError('invalid_initial_composition', 'Select unique built-in plugins with supported options and an explicit interactive boolean', 422, {
    // Never return Zod's raw messages/keys: unknown caller data may contain secrets.
    diagnostics: parsed.error.issues.map(issue => ({ path: issue.path.filter(part => typeof part === 'number' || ['plugins', 'interactive', 'plugin', 'options', 'methods', 'allowCreate', 'trustedIssuers'].includes(String(part))),
      code: issue.code, message: 'Use a unique built-in descriptor; only identity, organizations and local-auth accept their documented options. Permissions options come from config.' })),
  })
  const before = await initializationSnapshot(root)
  const template = await readFile(new URL('../../templates/standalone/runtime.ts', import.meta.url))
  const conflicts = [
    ...initializationPaths.filter(path => before.inputs[path] !== undefined),
    ...before.migrations.map(name => `migrations/${name}`),
  ]
  if (conflicts.length) freshStateConflict(conflicts)
  const captured = await loadInitializationInputs(root, instance, before).catch(error => {
    if (error instanceof SourceError || (error instanceof WorkflowError && error.code === 'initialization_unsupported')
      || (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') freshStateConflict(['config.ts'])
    throw error
  })
  // Bootstrap may derive only permissions options from its initial role graph.
  const bootstrapRuntime = Buffer.from(rewritePermissionsSource(template.toString(), captured.loaded.config))
  if (!before.inputs['runtime.ts']?.equals(template) && !before.inputs['runtime.ts']?.equals(bootstrapRuntime)) freshStateConflict(['runtime.ts'])
  const source = printRuntimeSource(canonical(parsed.data) as typeof parsed.data, captured.loaded.config)
  const model = parseRuntimeSource(source)
  const plugins = hydrateRuntimePlugins(model, captured.loaded.config)
  // Read contracts from the real closed descriptors, never inject missing providers.
  const requirements: CompositionRequirement[] = plugins.flatMap((plugin, index) => Object.entries(plugin.requires ?? {}).map(([contract, range]) => ({
    plugin: model.plugins[index].plugin, requirement: contract,
    satisfied: plugins.some(provider => provider.provides?.[contract] === `${range.slice(1)}.x`), severity: 'error' as const,
    message: `Select a built-in provider for ${contract}@${range}, required by ${model.plugins[index].plugin}.`,
  })))
  if (model.interactive) requirements.push({ plugin: 'runtime', requirement: 'login',
    satisfied: plugins.some(plugin => plugin.provides?.login === '1.x'), severity: 'error',
    message: 'Interactive mode requires a login provider. Select local-auth or set interactive to false.',
  })
  const infrastructure = await compositionRequirements(root, model)
  requirements.push(...infrastructure.requirements)
  assertCompositionRequirements(requirements)
  const planned = await planInitialization(root, instance, { model, source }, captured)
  const files = [{ path: 'runtime.ts', data: source, hash: hash(source), status: 'replace' as const }, ...planned.files]
  const guards = { ...before.guards, ...infrastructure.guards }
  const planHash = hash({ version: 1, kind: 'initial_composition', instance, model, sources: guards,
    dependencies: planned.dependencyGuards, requirements, files: files.map(({ path, hash }) => ({ path, hash })) })
  return { instance, planHash, model, files, guards, dependencies: planned.dependencyGuards, requirements }
}
