import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { durableAtomic, json, type Bundle, type Store } from './storage.ts'
import { fail, WorkflowError } from './schemas.ts'
import { parseProposal, sdkEvidenceSchema, type SdkUpgradeProposal } from './proposals.ts'
import { instanceMeta } from './offline.ts'
import { MigrationReplayError } from './migration-replay.ts'
import { captureSdkInputs, runSdkTarget, type SdkInputs } from './sdk-target.ts'
import { assertBound, bridgeDigest, digestBytes } from './sdk-upgrade-protocol.ts'
import { RegistrySdkError } from './sdk-registry.ts'
import { hash } from './planning.ts'

const hashes = (inputs: SdkInputs) => Object.fromEntries(Object.keys(inputs).sort().map(path => [path, digestBytes(inputs[path])]))
const checkoutRoot = fileURLToPath(new URL('../../../', import.meta.url).href)
const save = async (store: Store, proposal: SdkUpgradeProposal) => durableAtomic(join(await store.proposalDirectory(proposal.instance), 'proposals', `${proposal.proposalId}.json`), json(proposal))
// Hash canonical proposal bytes with only the digest's own slot zeroed. This
// binds ALL record fields, raw Instance inputs and resolved target/lock identity
// without a self-referential hash. Noncanonical on-disk bytes fail consumption.
function evidenceDigest(proposal: SdkUpgradeProposal, inputHashes: Record<string, string>, bridge: string) {
  const record = structuredClone(proposal)
  if (record.status === 'promoted') record.promotion!.digest = '0'.repeat(64)
  else record.evidence!.binding!.digest = '0'.repeat(64)
  return digestBytes(json({ record: json(record), inputHashes: Object.fromEntries(Object.keys(inputHashes).sort().map(path => [path, inputHashes[path]])), bridge,
    targetVersion: record.targetVersion, targetDependencyDigest: record.evidence!.targetDependencyDigest }))
}
async function requireEvidence(store: Store, proposal: SdkUpgradeProposal, source: Buffer | undefined, currentAttempt?: string) {
  const binding = proposal.evidence?.binding
  if (!binding || !source?.equals(Buffer.from(json(proposal), 'utf8'))
    || !await store.sdkAttemptMatches(proposal.instance, proposal.proposalId, binding.attemptId, currentAttempt)) {
    fail('validation_required', 'SDK evidence is not authorized', 409)
  }
  // Every read is inside the canonical lock. Missing/unreadable inputs or any
  // other read error propagate as a rejection, never as cached authorization.
  const inputs = hashes(await captureSdkInputs(await store.directory(proposal.instance)))
  const bridge = await bridgeDigest(fileURLToPath(new URL('.', import.meta.url).href))
  const digest = proposal.status === 'promoted' ? proposal.promotion?.digest : binding.digest
  if (digest !== evidenceDigest(proposal, inputs, bridge)) fail('validation_required', 'SDK evidence inputs changed', 409)
}
// One public boundary for ALL SDK workflow failures, including pre-dispatch
// audit, schema, lock acquisition and recovery errors. Never copy diagnostics,
// details, schema issues or nested messages into responses or evidence.
const publicMessages: Record<string, string> = {
  registry_selection: 'SDK registry version selection failed',
  registry_metadata: 'SDK registry metadata verification failed',
  registry_install: 'SDK registry installation failed',
  registry_integrity: 'SDK registry integrity verification failed',
  registry_guard: 'SDK registry dependency sources were rejected',
  sdk_upgrade_target_unsupported: 'SDK execution requires a numeric release version without prerelease or build qualifiers',
  sdk_upgrade_standalone_required: 'SDK upgrades require a standalone Instance',
  sdk_upgrade_base_changed: 'SDK proposal application inputs changed; create a new proposal',
  dependencies_changed: 'SDK proposal base dependencies changed; create a new proposal',
  sdk_upgrade_major_unsupported: 'SDK upgrades must stay within the current major version',
  sdk_upgrade_forward_required: 'SDK upgrades require a strictly newer version',
  sdk_upgrade_not_supported: 'SDK submission is not supported',
  sdk_upgrade_cancelled: 'SDK upgrade operation was cancelled',
  sdk_upgrade_failed: 'SDK target verification failed; the proposal has no accepted evidence',
  invalid_input: 'Input does not match the tool schema',
  invalid_proposal: 'Proposal has an unsupported identity, lifecycle or fields',
  proposal_closed: 'Proposal is closed',
  proposal_not_found: 'Proposal not found in the allowlist',
  validation_required: 'SDK proposal requires current validated or verified evidence',
  verification_required: 'Verify this SDK proposal on a disposable database before promotion',
  stale_revision: 'Revision changed; inspect and propose against the current revision',
  migration_exists: 'Migration file already exists',
  concurrent_modification: 'Instance files changed during the SDK operation',
  instance_busy: 'Another configuration operation holds this Instance lock',
  invalid_lock_claim: 'Instance lock claim could not be verified',
  legacy_lock_claim: 'Instance lock claim is unsupported',
  invalid_journal: 'Instance recovery journal is invalid',
  unsafe_path: 'Instance paths are unsafe',
  invalid_instance_directory: 'Expected one configuration directory for the allowed Instance',
  instance_not_allowed: 'Instance is not in the server allowlist',
  invalid_allowlist: 'Server Instance allowlist is invalid',
  invalid_instance_id: 'Instance identifier is invalid',
  invalid_migrations: 'Instance migrations are invalid',
  invalid_indexes: 'Instance indexes are invalid',
  invalid_config: 'Instance configuration is invalid',
  unsupported_plugin_source: 'Instance plugin source is unsupported',
  config_schema_mismatch: 'Instance configuration does not match its schema',
  migration_blocked: 'Instance migrations require review',
  revision_mismatch: 'Instance migration revision does not match',
  internal_error: 'SDK operation failed; no database was deployed',
}
export function sdkWorkflowError(error: unknown): WorkflowError {
  if (error instanceof MigrationReplayError) return new WorkflowError(error.code, error.message, 422, error.diagnostic)
  const code = error instanceof WorkflowError || error instanceof RegistrySdkError ? error.code : error instanceof z.ZodError ? 'invalid_input' : 'internal_error'
  const status = error instanceof WorkflowError ? error.status : error instanceof RegistrySdkError ? 409 : code === 'invalid_input' ? 400 : 500
  return new WorkflowError(code, Object.hasOwn(publicMessages, code) ? publicMessages[code] : 'SDK operation failed; the proposal has no accepted evidence', status)
}

function executionVersion(version: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) fail('sdk_upgrade_target_unsupported', 'SDK execution requires a numeric release version without prerelease or build qualifiers', 409)
  return version.split('.').map(BigInt)
}
async function executionBase(bundle: Bundle, proposal: Pick<SdkUpgradeProposal, 'targetVersion' | 'baseRevision' | 'baseFingerprint' | 'baseDependencyDigest'>) {
  const target = executionVersion(proposal.targetVersion)
  if (bundle.dependencyDigest === undefined) fail('sdk_upgrade_standalone_required', 'SDK upgrades require a standalone Instance', 409)
  if (bundle.config.revision !== proposal.baseRevision) fail('sdk_upgrade_base_changed', 'SDK proposal application inputs changed; create a new proposal', 409)
  if (bundle.dependencyDigest !== proposal.baseDependencyDigest) fail('dependencies_changed', 'SDK proposal base dependencies changed; create a new proposal', 409)
  if (bundle.fingerprint !== proposal.baseFingerprint) fail('sdk_upgrade_base_changed', 'SDK proposal application inputs changed; create a new proposal', 409)
  // SDK execution is checked against the selected target, which may be newer
  // than this producer. Normal config operations retain their producer ceiling.
  const current = executionVersion((await instanceMeta(bundle, null)).core_version)
  if (target[0] !== current[0]) fail('sdk_upgrade_major_unsupported', 'SDK upgrades must stay within the current major version', 409)
  const difference = target.findIndex((part, index) => part !== current[index])
  if (difference < 0 || target[difference] < current[difference]) fail('sdk_upgrade_forward_required', 'SDK upgrades require a strictly newer version', 409)
}

/** Consume accepted evidence without revoking or regenerating it. All reads,
 * publication, target authorization and rollback hold the canonical lock. */
async function promoteSdkUpgrade(store: Store, proposal: SdkUpgradeProposal, recover: () => Promise<void>, expectedRevision: number | undefined, source: Buffer | undefined, signal?: AbortSignal) {
  await recover()
  if (proposal.status === 'discarded') fail('proposal_closed', 'Proposal is discarded', 409)
  await requireEvidence(store, proposal, source)
  if (proposal.evidence?.state !== 'verified') fail('verification_required', 'Verify this SDK proposal on a disposable database before promotion', 409)
  const bundle = await store.load(proposal.instance)
  if (bundle.config.revision !== expectedRevision) fail('stale_revision', 'Revision changed; inspect and propose against the current revision', 409)
  const { evidence } = proposal, marker = evidence.result.stage.marker
  const result = { ok: true, status: 'promoted', revision: proposal.baseRevision, targetVersion: proposal.targetVersion,
    migration: marker.path.slice('migrations/'.length), appliesToDatabase: false }
  const authorizeTarget = async () => {
    const target = await store.load(proposal.instance)
    const meta = await instanceMeta(target, proposal.targetVersion)
    if (meta.revision !== proposal.baseRevision || meta.core_version !== proposal.targetVersion) fail('revision_mismatch', 'Published SDK marker differs from verified evidence', 409)
    await requireEvidence(store, proposal, await store.sdkProposalSource(proposal.proposalId))
    signal?.throwIfAborted()
  }
  if (proposal.status === 'promoted') { await authorizeTarget(); return result }
  await executionBase(bundle, proposal)
  const next = Math.max(0, ...bundle.migrations.map(migration => Number(migration.name.slice(0, 4)))) + 1
  if (marker.path !== `migrations/${String(next).padStart(4, '0')}_sdk_upgrade.sql`) fail('validation_required', 'SDK marker is not the next migration', 409)
  proposal.status = 'promoted'
  proposal.promotion = { inputHashes: { ...evidence.result.inputHashes, [marker.path]: marker.sha256 }, digest: '0'.repeat(64) }
  proposal.promotion.digest = evidenceDigest(proposal, proposal.promotion.inputHashes, await bridgeDigest(fileURLToPath(new URL('.', import.meta.url).href)))
  parseProposal(proposal)
  signal?.throwIfAborted()
  await store.commit(proposal.instance, [
    ...['package.json', 'bun.lock', marker.path].map(path => ({ path, data: Buffer.from(evidence.artifacts[path].data, 'base64'), ...(path === marker.path ? { create: true } : {}) })),
    { path: `proposals/${proposal.proposalId}.json`, data: json(proposal) },
  ], { ...bundle.guards, [`proposals/${proposal.proposalId}.json`]: hash(source!.toString('utf8')) }, authorizeTarget)
  return result
}

/** Called only inside Store.locked, after its existing recovery-before-import. */
export async function proposeSdkUpgrade(store: Store, instance: string, baseRevision: number, targetVersion: string, proposalId: string) {
  const bundle = await store.load(instance)
  const proposal: SdkUpgradeProposal = {
    kind: 'sdk_upgrade', proposalId, instance, baseRevision, targetVersion, status: 'proposed', createdAt: new Date().toISOString(),
    baseFingerprint: bundle.fingerprint, baseDependencyDigest: bundle.dependencyDigest ?? '',
  }
  await executionBase(bundle, proposal)
  await save(store, proposal)
  return { ok: true, proposalId, baseRevision, targetVersion, status: proposal.status }
}

/** Evidence is invalidated durably BEFORE any input import/capture can fail.
 * Both validation and apply rerun D2; only apply publishes verified evidence.
 * SDK keep has no effect: D2 always terminates groups and removes its scratch. */
export async function executeSdkUpgrade(store: Store, proposal: SdkUpgradeProposal, action: string, recover: () => Promise<void>, signal?: AbortSignal, previousAccepted = false, attemptId?: string, source?: Buffer, expectedRevision?: number) {
  if (action === 'submit_change') {
    await recover()
    fail('sdk_upgrade_not_supported', 'SDK submission is not supported', 409)
  }
  if (action === 'promote') {
    try { return await promoteSdkUpgrade(store, proposal, recover, expectedRevision, source, signal) }
    catch (error) {
      if (signal?.aborted) fail('sdk_upgrade_cancelled', 'SDK upgrade promotion was cancelled', 409)
      throw error
    }
  }
  if (proposal.status === 'promoted') fail('proposal_closed', 'Proposal is promoted', 409)
  if (proposal.status === 'discarded' && action !== 'discard') fail('proposal_closed', 'Proposal is discarded', 409)
  const original = structuredClone(proposal)
  const previous = previousAccepted ? proposal.evidence : undefined
  delete proposal.evidence
  proposal.status = action === 'discard' ? 'discarded' : 'proposed'
  try {
    await recover()
    if (action === 'discard') { await save(store, proposal); return { ok: true, status: proposal.status } }
    signal?.throwIfAborted()
    if (['preview_migration', 'apply_to_disposable'].includes(action) && original.evidence) {
      if (!previousAccepted) fail('validation_required', 'SDK evidence is not authorized', 409)
      await requireEvidence(store, original, source, attemptId)
    }
    const bundle = await store.load(proposal.instance)
    await executionBase(bundle, proposal)
    const directory = await store.directory(proposal.instance)
    const inputs = await captureSdkInputs(directory)
    const baseInputHashes = hashes(inputs)
    if (action === 'preview_migration') {
      if (!previous) fail('validation_required', 'Validate this SDK proposal before previewing its staged bytes', 409)
      assertBound(baseInputHashes, previous.baseInputHashes, 'preview base input bytes')
      // Recheck bridge identity too; an old candidate bridge is never current proof.
      assertBound(await bridgeDigest(fileURLToPath(new URL('.', import.meta.url).href)), previous.result.identity.bridgeDigest, 'preview bridge')
      signal?.throwIfAborted()
      proposal.evidence = previous; proposal.status = previous.state
      proposal.evidence.binding = { event: 'attempt-succeeded', attemptId: attemptId!, digest: '0'.repeat(64) }
      proposal.evidence.binding.digest = evidenceDigest(proposal, baseInputHashes, await bridgeDigest(fileURLToPath(new URL('.', import.meta.url).href)))
      await save(store, proposal)
      signal?.throwIfAborted()
      await executionBase(await store.load(proposal.instance), proposal)
      assertBound(hashes(await captureSdkInputs(directory)), baseInputHashes, 'preview accepted input bytes')
      await requireEvidence(store, proposal, await store.sdkProposalSource(proposal.proposalId))
      signal?.throwIfAborted()
      return { ok: true, sql: Buffer.from(previous.artifacts[previous.result.stage.marker.path].data, 'base64').toString('utf8'),
        revision: proposal.baseRevision, targetVersion: proposal.targetVersion, artifacts: previous.artifacts }
    }
    const proof = await runSdkTarget({ instanceRoot: directory, checkoutRoot: resolve(checkoutRoot), targetVersion: proposal.targetVersion,
      base: { instanceId: bundle.config.id, baseRevision: proposal.baseRevision, baseFingerprint: proposal.baseFingerprint, baseDependencyDigest: proposal.baseDependencyDigest },
      inputs, signal,
      readBase: async () => {
        const current = await store.load(proposal.instance)
        return { baseFingerprint: current.fingerprint, baseDependencyDigest: current.dependencyDigest! }
      },
    })
    // D2 has rechecked installed bytes and awaited cleanup. Fence publication
    // with both original digests and raw input bytes again under the same lock.
    await executionBase(await store.load(proposal.instance), proposal)
    assertBound(hashes(await captureSdkInputs(directory)), baseInputHashes, 'publication base input bytes')
    signal?.throwIfAborted()
    const state = action === 'apply_to_disposable' ? 'verified' : 'validated'
    proposal.status = state
    proposal.evidence = sdkEvidenceSchema.parse({ state, proposalId: proposal.proposalId, baseInputHashes,
      binding: { event: 'attempt-succeeded', attemptId, digest: '0'.repeat(64) },
      ...proof, artifacts: Object.fromEntries(Object.entries(proof.artifacts).map(([path, file]) => [path, { data: file.bytes.toString('base64'), sha256: file.sha256 }])) })
    proposal.evidence.binding!.digest = evidenceDigest(proposal, baseInputHashes, await bridgeDigest(fileURLToPath(new URL('.', import.meta.url).href)))
    parseProposal(proposal)
    await save(store, proposal)
    // Abort or drift while the atomic record was published must also revoke it.
    signal?.throwIfAborted()
    await executionBase(await store.load(proposal.instance), proposal)
    assertBound(hashes(await captureSdkInputs(directory)), baseInputHashes, 'accepted base input bytes')
    await requireEvidence(store, proposal, await store.sdkProposalSource(proposal.proposalId))
    signal?.throwIfAborted()
    return { ok: true, status: state, verified: state === 'verified', revision: proposal.baseRevision, targetVersion: proposal.targetVersion }
  } catch (error) {
    // Publication can itself trigger abort/drift. Use the same durable
    // revocation primitive so a failed cleanup rewrite cannot retain proof.
    await store.revokeSdkProposal(proposal.proposalId)
    if (error instanceof WorkflowError || error instanceof MigrationReplayError) throw error
    if (signal?.aborted) fail('sdk_upgrade_cancelled', 'SDK upgrade verification was cancelled', 409)
    if (error instanceof RegistrySdkError) throw error
    fail('sdk_upgrade_failed', 'SDK target verification failed; the proposal has no accepted evidence', 409)
  }
}
