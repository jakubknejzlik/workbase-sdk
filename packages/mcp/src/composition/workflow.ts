import { join } from 'node:path'
import { durableAtomic, json, type Bundle, type Store } from '../storage.ts'
import { fail, identifier, type AccessChange, type CompositionChange, type RolesChange, type RuntimeChange } from '../schemas.ts'
import { z } from 'zod'
import { accessEntities } from '@workbasehq/core/schema'
import { loadConfig } from '@workbasehq/core/schema/load'
import { hash } from '../planning.ts'
import { instanceMeta, replayEngine } from '../offline.ts'
import { applyDisposable } from '../disposable.ts'
import type { CompositionProposal } from '../proposals.ts'
import { applyRuntimeChanges, parseRuntimeSource, rewritePermissionsSource, rewriteRuntimeSource } from './runtime-source.ts'
import { hydrateRuntimePlugins } from './registry.ts'
import { accessPlan, compositionPlan, localePlan } from './plan.ts'
import { compositionRequirements, assertCompositionRequirements } from './requirements.ts'
import { promotionHash, submitChange } from '../submit-change.ts'
import { replaySources } from '../replay-sources.ts'
import type { GitHubConfiguration } from '../github.ts'
import { assertRoleTargetSafe } from '../role-usage.ts'

async function save(store: Store, proposal: CompositionProposal) {
  await durableAtomic(join(await store.proposalDirectory(proposal.instance), 'proposals', `${proposal.proposalId}.json`), json(proposal))
}
function revision(bundle: Bundle, expected: number) {
  if (bundle.config.revision !== expected) fail('stale_revision', 'Revision changed; inspect and propose against the current revision', 409)
}
const isAccess = (change: CompositionChange): change is AccessChange | RolesChange => change.kind === 'set_roles' || change.kind === 'set_system_access' || change.kind === 'set_entity_access' || change.kind === 'set_account_link'
const accessEntityTarget = z.union([identifier, z.enum(accessEntities)])
async function load(store: Store, instance: string, changes: CompositionChange[]) {
  // Check the closed SDK entity list before loading or editing the instance.
  // Zod preserves the public invalid_input refusal for unsupported targets.
  for (const change of changes) if (change.kind === 'set_entity_access') accessEntityTarget.parse(change.entity)
  // Surface compiler diagnostics before the trusted config import can throw an
  // unlocated runtime declaration error for an incomplete source matrix.
  if (changes.some(change => isAccess(change) || change.kind === 'set_locale')) await loadConfig(join(await store.directory(instance), 'config.ts'))
  return store.load(instance, { canonicalRuntime: true })
}
async function prepare(bundle: Bundle, changes: CompositionChange[], root: string) {
  if (changes.some(change => change.kind === 'set_locale') && !changes.every(change => change.kind === 'set_locale')) {
    fail('mixed_change_kinds', 'Propose V3 language changes separately from runtime and access changes')
  }
  if (bundle.config.baseline !== 'workbase-sdk') fail('composition_requires_v3', 'Composition authoring requires a V3 instance', 409)
  const runtimeChanges = changes.filter((change): change is RuntimeChange => change.kind === 'set_plugin' || change.kind === 'set_interactive')
  const accessChanges = changes.filter(isAccess)
  const access = accessChanges.length ? await accessPlan(root, accessChanges) : { config: bundle.config, files: [] }
  const locales = await localePlan(root, changes.filter(change => change.kind === 'set_locale'))
  const config = locales?.config ?? access.config
  const model = applyRuntimeChanges(parseRuntimeSource(bundle.runtimeSource!), runtimeChanges, config)
  const source = runtimeChanges.length ? rewriteRuntimeSource(bundle.runtimeSource!, model, config)
    : changes.some(change => change.kind === 'set_roles') ? rewritePermissionsSource(bundle.runtimeSource!, config) : bundle.runtimeSource!
  const runtime = { ...config, ...(model.interactive === undefined ? {} : { interactive: model.interactive }), plugins: hydrateRuntimePlugins(model, config) }
  const target = { ...bundle, config, runtime }
  try { replayEngine(target.config, runtime) }
  catch { fail('invalid_composition', 'The target plugin composition is invalid; check required providers and interactive login', 400) }
  return { target, source, files: [...(source !== bundle.runtimeSource ? [{ path: 'runtime.ts', data: source }] : []), ...access.files, ...(locales?.files ?? [])], model,
    roleDiff: 'roleDiff' in access ? access.roleDiff : undefined }
}
function proof(bundle: Bundle, prepared: Awaited<ReturnType<typeof prepare>> & Awaited<ReturnType<typeof compositionPlan>>, changes: CompositionChange[], requirementGuards: Bundle['guards']) {
  return { fingerprint: bundle.fingerprint, planHash: hash({ files: prepared.files, ledger: prepared.ledger, statements: prepared.statements, model: prepared.model, changes, requirementGuards }),
    ...(bundle.dependencyDigest === undefined ? {} : { dependencyDigest: bundle.dependencyDigest }), openapiHash: bundle.guards['openapi.json'] ?? null }
}
export async function proposeComposition(store: Store, instance: string, baseRevision: number, changes: CompositionChange[], proposalId: string) {
  const bundle = await load(store, instance, changes)
  revision(bundle, baseRevision)
  await prepare(bundle, changes, await store.directory(instance))
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
  const root = await store.directory(proposal.instance)
  if (name === 'promote' && proposal.validation) {
    // Check the captured artifact before importing a config that binds it: a
    // removed or malformed replacement must still invalidate the saved proof.
    const spec = (await replaySources(root, { accessLock: true }))['openapi.json']
    if ((spec === undefined ? null : hash(spec.toString('utf8'))) !== proposal.validation.openapiHash) {
      fail('stale_revision', 'Instance files changed since validation', 409)
    }
  }
  const bundle = await load(store, proposal.instance, proposal.changes)
  if (name === 'promote') revision(bundle, input.expectedRevision!)
  revision(bundle, proposal.baseRevision)
  if (name === 'promote' && proposal.validation && proposal.validation.fingerprint !== bundle.fingerprint) fail('stale_revision', 'Instance files changed since validation', 409)
  const target = await prepare(bundle, proposal.changes, root)
  const prepared = { ...target, ...await compositionPlan(bundle, target.target, target.source, root, target.files) }
  const { requirements, guards: requirementGuards } = await compositionRequirements(await store.directory(proposal.instance), prepared.model)
  assertCompositionRequirements(requirements)
  const currentProof = proof(bundle, prepared, proposal.changes, requirementGuards)
  if (name !== 'validate' && (!proposal.validation || hash(proposal.validation) !== hash(currentProof))) {
    fail('validation_required', 'Validate this exact composition against the current files first', 409)
  }
  await instanceMeta(prepared.target)
  const expected = prepared.expected
  if (name === 'validate') {
    proposal.validation = currentProof; proposal.status = 'validated'
    await save(store, proposal)
    return { ok: true, kind: proposal.kind, revision: bundle.config.revision, errors: [], requirements }
  }
  if (name === 'preview_migration') return { ok: true, kind: proposal.kind, revision: bundle.config.revision,
    sql: '', files: prepared.files, composition: prepared.model, pluginMigrations: prepared.pluginMigrations, pluginSql: prepared.pluginSql,
    ...(prepared.roleDiff ? { roleDiff: prepared.roleDiff } : {}) }
  if (name === 'apply_to_disposable') {
    await assertRoleTargetSafe(proposal.instance, bundle.config.roles.filter(role => !prepared.target.config.roles.includes(role)),
      bundle.config.organizationOwnerRole !== prepared.target.config.organizationOwnerRole)
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
    await assertRoleTargetSafe(proposal.instance, bundle.config.roles.filter(role => !prepared.target.config.roles.includes(role)),
      bundle.config.organizationOwnerRole !== prepared.target.config.organizationOwnerRole)
    proposal.status = 'promoted'; proposal.promotedFiles = prepared.files
    proposal.promotedRevision = bundle.config.revision
    proposal.migrationPreview = { sql: prepared.pluginSql, configDiff: { composition: prepared.model, pluginMigrations: prepared.pluginMigrations, ...(prepared.roleDiff ? { roleDiff: prepared.roleDiff } : {}) }, revision: bundle.config.revision }
    if (bundle.dependencyDigest !== undefined) proposal.dependencyDigest = bundle.dependencyDigest
    proposal.promotionHash = promotionHash(proposal)
    await store.commit(proposal.instance, [...prepared.files,
      { path: `proposals/${proposal.proposalId}.json`, data: json(proposal) }], { ...latest.guards, ...requirementGuards })
    return { ok: true, kind: proposal.kind, status: proposal.status, revision: bundle.config.revision, files: prepared.files.map(file => file.path), appliesToDatabase: false }
  }
  return fail('unknown_tool', 'Unknown tool', 404)
}
