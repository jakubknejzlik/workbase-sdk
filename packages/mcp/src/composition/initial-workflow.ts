import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bindSchemaLock } from '@workbasehq/core/schema'
import { expectedPluginMigrations } from '@workbasehq/core/kernel/migrations'
import { durableAtomic, json, type Bundle, type Store } from '../storage.ts'
import { fail, WorkflowError, type InitialComposition } from '../schemas.ts'
import { initialPlanSchema, type InitialCompositionProposal } from '../proposals.ts'
import { hash } from '../planning.ts'
import { byteHash } from '../byte-digest.ts'
import { initializationDependencies, initializationSnapshot, loadInitializationInputs } from '../initialization-plan.ts'
import { replayEngine, snapshot } from '../offline.ts'
import { replayInstance, readInstanceMeta } from '../migration-replay.ts'
import { applyDisposable } from '../disposable.ts'
import { hydrateRuntimePlugins } from './registry.ts'
import { pluginLedger } from './plan.ts'
import { compositionRequirements } from './requirements.ts'
import { planInitialComposition } from './initial-plan.ts'

async function save(store: Store, proposal: InitialCompositionProposal) {
  await durableAtomic(join(await store.proposalDirectory(proposal.instance), 'proposals', `${proposal.proposalId}.json`), json(proposal))
}
const proof = (p: InitialCompositionProposal) => ({ fingerprint: hash(p.plan.guards), planHash: p.plan.planHash, dependencyDigest: hash(p.plan.dependencies) })

/** Called under the same instance lock as initialize_instance and publication. */
export async function proposeInitialComposition(store: Store, instance: string, composition: InitialComposition, proposalId: string) {
  const plan = initialPlanSchema.parse(await planInitialComposition(await store.directory(instance), instance, composition))
  const proposal: InitialCompositionProposal = { kind: 'initial_composition', proposalId, instance, baseRevision: 1,
    createdAt: new Date().toISOString(), status: 'proposed', composition, plan }
  await save(store, proposal)
  return { ok: true, kind: proposal.kind, proposalId, status: proposal.status, revision: 1, planHash: plan.planHash }
}

async function currentPlan(root: string, p: InitialCompositionProposal) {
  try {
    const current = await planInitialComposition(root, p.instance, p.composition)
    if (hash(current) !== hash(p.plan)) fail('stale_plan', 'Fresh composition inputs or selection changed; propose and verify again', 409)
  } catch (error) {
    if (error instanceof WorkflowError && error.code === 'dependencies_missing') throw error
    fail('stale_plan', 'Fresh composition inputs or selection changed; preserve existing files and propose again', 409)
  }
}

/** Empty database only: SDK baseline + selected plugins + first domain receipt. */
async function replay(root: string, p: InitialCompositionProposal) {
  const { loaded } = await loadInitializationInputs(root, p.instance)
  bindSchemaLock(loaded.config, JSON.parse(p.plan.files.find(file => file.path === 'schema.lock.json')!.data))
  const config = loaded.config
  const runtime = { ...config, interactive: p.plan.model.interactive, plugins: hydrateRuntimePlugins(p.plan.model, config) }
  const sql = p.plan.files.find(file => file.path === 'migrations/0001_r1.sql')!.data
  const bundle: Bundle = { config, runtime, migrations: [{ name: '0001_r1.sql', sql }], indexes: [],
    fingerprint: p.plan.planHash, guards: p.plan.guards }
  const engine = replayEngine(config, runtime), db = new DatabaseSync(':memory:')
  const statements: { sql: string; name: string }[] = []
  try {
    await replayInstance(db, bundle.migrations, engine, { record: (sql, context) => {
      statements.push({ sql, name: (context?.migration ?? 'ledger').replace(/[^a-z0-9_]/gi, '_') })
    } })
    const ledger = pluginLedger(db)
    const selected = await expectedPluginMigrations(engine.kernel.plugins, engine.kernel.config)
    if (hash(ledger) !== hash(selected) || readInstanceMeta(db)?.revision !== 1) fail('composition_migration_divergence', 'Fresh replay does not match selected plugin migrations and revision 1', 422)
    return { bundle, expected: snapshot(db, true), composition: { statements, ledger }, sql }
  } finally { db.close() }
}

/** A completed retry verifies both the published bytes and original source/dependency guards. */
async function published(root: string, p: InitialCompositionProposal) {
  const current = await initializationSnapshot(root)
  const requirements = await compositionRequirements(root, p.plan.model)
  const expected = { ...p.plan.guards }
  for (const file of p.plan.files) expected[file.path] = byteHash(Buffer.from(file.data))
  const manifest = (guards: Record<string, string | null>) => Object.entries(guards).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (hash(manifest({ ...current.guards, ...requirements.guards })) !== hash(manifest(expected))
    || hash(await initializationDependencies(root, p.plan.model)) !== hash(p.plan.dependencies)) {
    fail('stale_plan', 'Published composition or its inputs changed since promotion', 409)
  }
  // Read exact destination bytes as well as snapshots before returning the stored receipt.
  for (const file of p.plan.files) if (!(await readFile(join(root, file.path))).equals(Buffer.from(file.data))) fail('stale_plan', 'Published composition changed', 409)
}

export async function executeInitialComposition(store: Store, p: InitialCompositionProposal, name: string,
  input: Record<string, any>, signal?: AbortSignal) {
  const root = await store.directory(p.instance)
  if (name === 'promote' && input.expectedRevision !== 1) fail('stale_revision', 'Fresh composition publishes revision 1', 409)
  if (p.status === 'promoted') {
    if (name !== 'promote') fail('proposal_closed', 'Proposal is promoted', 409)
    await published(root, p)
    return p.receipt!
  }
  if (p.status === 'discarded') fail('proposal_closed', 'Proposal is discarded', 409)
  if (name === 'discard') {
    p.status = 'discarded'; delete p.validation; delete p.verification
    await save(store, p)
    return { ok: true, status: p.status }
  }
  if (!['validate', 'preview_migration', 'apply_to_disposable', 'promote'].includes(name)) fail('initial_composition_not_supported', 'Fresh proposals support validate, preview, disposable, promote and discard', 409)
  // A failed new validation/verification must never leave accepted older evidence.
  if (name === 'validate') {
    delete p.validation; delete p.verification; p.status = 'proposed'; await save(store, p)
  } else if (name === 'apply_to_disposable') {
    delete p.verification; p.status = p.validation ? 'validated' : 'proposed'; await save(store, p)
  }
  await currentPlan(root, p)
  const bound = proof(p)
  if (name !== 'validate' && name !== 'preview_migration' && (!p.validation || hash(p.validation) !== hash(bound))) fail('validation_required', 'Validate this exact fresh proposal first', 409)
  if (name === 'promote') {
    if (!p.verification || hash(p.verification) !== hash(bound)) fail('verification_required', 'Verify this exact fresh proposal on disposable D1 first', 409)
    const receipt = { ok: true as const, proposalId: p.proposalId, status: 'promoted' as const, revision: 1 as const,
      planHash: p.plan.planHash, appliesToDatabase: false as const }
    const promoted: InitialCompositionProposal = { ...p, status: 'promoted', receipt }
    const verify = async () => {
      if (hash(await initializationDependencies(root, p.plan.model)) !== hash(p.plan.dependencies)) fail('stale_plan', 'Installed SDK changed during publication', 409)
    }
    await verify()
    await store.commit(p.instance, [
      ...p.plan.files.map(({ path, data }) => ({ path, data, create: path !== 'runtime.ts' })),
      { path: `proposals/${p.proposalId}.json`, data: json(promoted) },
    ], p.plan.guards, verify)
    return receipt
  }
  const prepared = await replay(root, p)
  await currentPlan(root, p)
  if (name === 'validate') {
    p.validation = bound; p.status = 'validated'; await save(store, p)
    return { ok: true, errors: [], revision: 1, planHash: p.plan.planHash, requirements: p.plan.requirements, pluginMigrations: prepared.composition.ledger }
  }
  if (name === 'preview_migration') return { ok: true, revision: 1, planHash: p.plan.planHash, files: p.plan.files,
    resolvedOptions: p.plan.model, requirements: p.plan.requirements, pluginMigrations: prepared.composition.ledger,
    pluginSql: prepared.composition.statements.filter(statement => statement.name !== '0001_r1_sql').map(statement => statement.sql).join('\n'), sql: prepared.sql }
  const verification = await applyDisposable(prepared.bundle, { target: prepared.bundle.config, indexes: [], sql: prepared.sql,
    composition: prepared.composition }, prepared.expected, input.keep ?? false, signal)
  // Inputs must still match after the external process and before accepting evidence.
  await currentPlan(root, p)
  if (verification.verified) { p.verification = bound; p.status = 'verified' }
  await save(store, p)
  return { ok: verification.verified, ...verification }
}
