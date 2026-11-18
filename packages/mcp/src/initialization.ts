import { constants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeSource, isLiteralConfig } from '@workbasehq/core/schema/load'
import type { Store } from './storage.ts'
import { WorkflowError, fail } from './schemas.ts'
import { noLink } from './paths.ts'
import { hash } from './planning.ts'
import { parseRuntimeSource } from './composition/runtime-source.ts'
import { initializationPaths, initializationDependencies, planInitialization } from './initialization-plan.ts'
export { initializationPaths } from './initialization-plan.ts'
const nextStep = (instance: string) => ({ tool: 'initialize_instance', arguments: { instance, mode: 'preview' } })
async function bytes(root: string, path: string) {
  await noLink(join(root, path), true)
  try { return await readFile(join(root, path), { flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** Incomplete declarations remain discoverable, but normal config operations never import them. */
export async function assertInitialized(root: string, instance: string) {
  if (!isLiteralConfig(join(root, 'config.ts'))) return
  const required = ['schema.lock.json', 'openapi.json']
  // An unbound V3 config may intentionally omit OpenAPI. Preserve that opt-in.
  const source = await readFile(join(root, 'config.ts'), 'utf8')
  const missing = []
  for (const path of required) {
    if (path === 'openapi.json' && !source.includes('./openapi.json')) continue
    if (await bytes(root, path) === null) missing.push(path)
  }
  if (missing.length) throw new WorkflowError('initialization_required', 'Initialize this fresh V3 instance before configuration operations', 409,
    { missing, nextStep: nextStep(instance) })
}

export async function initializeInstance(store: Store, instance: string, input: { mode: 'preview' | 'apply'; planHash?: string }) {
  const root = await store.directory(instance, true)
  const run = async () => {
    const { before, model, dependencyGuards, files, conflicts, planHash } = await planInitialization(root, instance)
    const existing = files.filter(file => file.status !== 'create')
    const report = { ok: true, instance, planHash, files, conflicts, nextStep: { tool: 'inspect_schema', arguments: { instance } } }
    if (input.mode === 'preview') return { ...report, mode: 'preview', nextStep: { tool: 'initialize_instance', arguments: { instance, mode: 'apply', planHash } } }
    if (input.planHash !== planHash) throw new WorkflowError('stale_plan', 'Initialization inputs changed; preview initialize_instance again', 409, { planHash, nextStep: nextStep(instance) })
    if (conflicts.length) throw new WorkflowError('initialization_conflict', 'Partial or differing artifacts already exist; preserve and review them before retrying fresh initialization', 409, { conflicts })
    // Also fence installed dependencies throughout the guarded publication.
    const verify = async () => {
      if (hash(await initializationDependencies(root, model)) !== hash(dependencyGuards)) fail('stale_plan', 'SDK dependencies changed during initialization; preview again', 409)
    }
    await verify()
    if (existing.length === files.length) return { ...report, mode: 'apply', status: 'unchanged' }
    await store.commit(instance, files.map(({ path, data }) => ({ path, data, create: true })), before.guards, verify)
    return { ...report, mode: 'apply', status: 'initialized' }
  }
  if (input.mode === 'preview') return run()
  // Fail before creating even lock metadata when the consumer graph is broken.
  await initializationDependencies(root, parseRuntimeSource(decodeSource(await bytes(root, 'runtime.ts') ?? Buffer.alloc(0), join(root, 'runtime.ts'))))
  return store.locked(instance, run)
}
