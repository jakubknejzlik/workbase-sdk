import { join } from 'node:path'
import { durableAtomic, json, type Bundle, type Store } from '../storage.ts'
import { fail, type CompositionChange } from '../schemas.ts'
import { hash } from '../planning.ts'
import { instanceMeta, replayEngine } from '../offline.ts'
import { applyDisposable } from '../disposable.ts'
import type { CompositionProposal } from '../proposals.ts'
import { applyRuntimeChanges, parseRuntimeSource, rewriteRuntimeSource } from './runtime-source.ts'
import { hydrateRuntimePlugins } from './registry.ts'
import { compositionPlan } from './plan.ts'
import { promotionHash, submitChange } from '../submit-change.ts'
import type { GitHubConfiguration } from '../github.ts'

async function save(store: Store, proposal: CompositionProposal) {
  await durableAtomic(join(await store.proposalDirectory(proposal.instance), 'proposals', `${proposal.proposalId}.json`), json(proposal))
}
function revision(bundle: Bundle, expected: number) {
  if (bundle.config.revision !== expected) fail('stale_revision', 'Revision changed; inspect and propose against the current revision', 409)
}
function prepare(bundle: Bundle, changes: CompositionChange[]) {
  if (bundle.config.baseline !== 'workbase-sdk') fail('composition_requires_v3', 'Composition authoring requires a V3 instance', 409)
  const model = applyRuntimeChanges(parseRuntimeSource(bundle.runtimeSource!), changes, bundle.config)
  const source = rewriteRuntimeSource(bundle.runtimeSource!, model, bundle.config)
  const runtime = { ...bundle.config, ...(model.interactive === undefined ? {} : { interactive: model.interactive }), plugins: hydrateRuntimePlugins(model, bundle.config) }
  const target = { ...bundle, runtime }
  try { replayEngine(target.config, runtime) }
  catch { fail('invalid_composition', 'The target plugin composition is invalid; check required providers and interactive login', 400) }
  return { target, files: [{ path: 'runtime.ts', data: source }], model }
}
function proof(bundle: Bundle, prepared: ReturnType<typeof prepare> & Awaited<ReturnType<typeof compositionPlan>>, changes: CompositionChange[]) {
  return { fingerprint: bundle.fingerprint, planHash: hash({ files: prepared.files, ledger: prepared.ledger, statements: prepared.statements, model: prepared.model, changes }),
    ...(bundle.dependencyDigest === undefined ? {} : { dependencyDigest: bundle.dependencyDigest }) }
}
export async function proposeComposition(store: Store, instance: string, baseRevision: number, changes: CompositionChange[], proposalId: string) {
  const bundle = await store.load(instance, { canonicalRuntime: true })
  revision(bundle, baseRevision)
  prepare(bundle, changes)
  const proposal: CompositionProposal = { kind: 'composition_change', proposalId, instance, baseRevision, changes,
    createdAt: new Date().toISOString(), status: 'proposed' }
  await save(store, proposal)
  return { ok: true, kind: proposal.kind, proposalId, baseRevision, status: proposal.status }
}
/** Called under the same instance lock as config and SDK publication, before recovery. */
export async function executeComposition(store: Store, proposal: CompositionProposal, name: string,
  input: { expectedRevision?: number; expectedBaseSha?: string; keep?: boolean }, recover: () => Promise<void>, signal?: AbortSignal, github?: GitHubConfiguration) {
  if (name === 'submit_change') {
    await recover()
    return submitChange(await store.directory(proposal.instance), proposal, input.expectedBaseSha!, github, () => store.dependencyDigest(proposal.instance))
  }
  if (proposal.status === 'promoted' || proposal.status === 'discarded' && name !== 'discard') fail('proposal_closed', `Proposal is ${proposal.status}`, 409)
  // Persist revocation before reading runtime, config, dependencies or migrations.
  // Failed revalidation must never leave an earlier verification consumable.
  if (name === 'validate' || name === 'apply_to_disposable') {
    delete proposal.verification
    if (name === 'validate') delete proposal.validation
    proposal.status = proposal.validation ? 'validated' : 'proposed'
    await save(store, proposal)
  }
  await recover()
  if (name === 'discard') {
    proposal.status = 'discarded'; delete proposal.validation; delete proposal.verification
    await save(store, proposal)
    return { ok: true, status: proposal.status }
  }
  const bundle = await store.load(proposal.instance, { canonicalRuntime: true })
  if (name === 'promote') revision(bundle, input.expectedRevision!)
  revision(bundle, proposal.baseRevision)
  if (name === 'promote' && proposal.validation && proposal.validation.fingerprint !== bundle.fingerprint) fail('stale_revision', 'Instance files changed since validation', 409)
  const target = prepare(bundle, proposal.changes)
  const prepared = { ...target, ...await compositionPlan(bundle, target.target, target.files[0].data, await store.directory(proposal.instance)) }
  const currentProof = proof(bundle, prepared, proposal.changes)
  if (name !== 'validate' && (!proposal.validation || hash(proposal.validation) !== hash(currentProof))) {
    fail('validation_required', 'Validate this exact composition against the current files first', 409)
  }
  await instanceMeta(prepared.target)
  const expected = prepared.expected
  if (name === 'validate') {
    proposal.validation = currentProof; proposal.status = 'validated'
    await save(store, proposal)
    return { ok: true, kind: proposal.kind, revision: bundle.config.revision, errors: [] }
  }
  if (name === 'preview_migration') return { ok: true, kind: proposal.kind, revision: bundle.config.revision,
    sql: '', files: prepared.files, composition: prepared.model, pluginMigrations: prepared.pluginMigrations, pluginSql: prepared.pluginSql }
  if (name === 'apply_to_disposable') {
    const verification = await applyDisposable(prepared.target,
      { target: bundle.config, indexes: bundle.indexes, sql: '', composition: { statements: prepared.statements, ledger: prepared.ledger } }, expected, input.keep ?? false, signal)
    if (verification.verified) { proposal.verification = currentProof; proposal.status = 'verified' }
    await save(store, proposal)
    return { ok: verification.verified, ...verification }
  }
  if (name === 'promote') {
    if (!proposal.verification || hash(proposal.verification) !== hash(currentProof)) fail('verification_required', 'Apply and verify this exact composition on a disposable D1 first', 409)
    const latest = await store.load(proposal.instance, { canonicalRuntime: true })
    revision(latest, input.expectedRevision!)
    if (latest.fingerprint !== bundle.fingerprint) fail('stale_revision', 'Instance files changed since verification', 409)
    if (latest.dependencyDigest !== bundle.dependencyDigest) fail('dependencies_changed', 'Dependencies changed since verification; validate and verify again', 409)
    proposal.status = 'promoted'; proposal.promotedFiles = prepared.files
    proposal.promotedRevision = bundle.config.revision
    proposal.migrationPreview = { sql: prepared.pluginSql, configDiff: { composition: prepared.model, pluginMigrations: prepared.pluginMigrations }, revision: bundle.config.revision }
    if (bundle.dependencyDigest !== undefined) proposal.dependencyDigest = bundle.dependencyDigest
    proposal.promotionHash = promotionHash(proposal)
    await store.commit(proposal.instance, [...prepared.files,
      { path: `proposals/${proposal.proposalId}.json`, data: json(proposal) }], latest.guards)
    return { ok: true, kind: proposal.kind, status: proposal.status, revision: bundle.config.revision, files: prepared.files.map(file => file.path), appliesToDatabase: false }
  }
  return fail('unknown_tool', 'Unknown tool', 404)
}
