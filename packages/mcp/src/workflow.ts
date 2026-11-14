import { submitChange, promotionHash } from './submit-change.ts'
import type { GitHubConfiguration } from './github.ts'
import { bootstrapInstance } from './bootstrap.ts'
import { appendFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomic, configSource, json, noLink, Store, type Bundle } from './storage.ts'
import { schemas, WorkflowError, fail, type ToolName } from './schemas.ts'
import { guard, hash, prepare, prepareChanges } from './planning.ts'
import { effectivePolicies } from './policies.ts'
import { expectedSnapshot, instanceMeta } from './offline.ts'
import { MigrationReplayError } from './migration-replay.ts'
import { applyDisposable } from './disposable.ts'
import { assertRemovedRolesUnused } from './role-usage'
import { readVersions, rollback, versionFiles } from './versions'
import { versionHistory } from '@workbasehq/core/migrations/versions'
import { inspectInstance, isDisplayFieldError } from '@workbasehq/core/config'
import { parseProposal, proposalRecord, type Proposal, type ConfigChangeProposal, type LegacyConfigProposal } from './proposals.ts'
import { executeSdkUpgrade, proposeSdkUpgrade, sdkWorkflowError } from './sdk-upgrade.ts'

function requireConfigChange(proposal: Proposal): asserts proposal is ConfigChangeProposal {
  if (proposal.kind === 'sdk_upgrade') fail('sdk_upgrade_not_supported', 'SDK-upgrade execution requires an upgrade handler; config-change tools cannot execute this proposal', 409)
}
export type ToolResult = Record<string, unknown>
export function errorResult(error: unknown): ToolResult {
  if (isDisplayFieldError(error)) return { ok: false, errors: error.errors }
  if (error instanceof MigrationReplayError) return { ok: false, error: { code: error.code, status: 422, message: error.message, details: error.diagnostic } }
  if (error instanceof WorkflowError) return { ok: false, error: { code: error.code, status: error.status, message: error.message, ...(error.details ? { details: error.details } : {}) } }
  if (error instanceof z.ZodError) return { ok: false, error: { code: 'invalid_input', status: 400, message: 'Input does not match the tool schema', issues: error.issues.map(({ path, message }) => ({ path, message })) } }
  return { ok: false, error: { code: 'internal_error', status: 500, message: 'Configuration operation failed; no database was deployed' } }
}
export class Workflow {
  constructor(public store: Store, private github?: GitHubConfiguration) {}
  async call(name: string, raw: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const callId = crypto.randomUUID()
    let proposalId: string | undefined = ['propose_change', 'upgrade_sdk'].includes(name) ? crypto.randomUUID() : undefined
    const args = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    let instance = this.store.allowed.values().next().value as string | undefined
    let sdk = name === 'upgrade_sdk' || Object.hasOwn(args, 'proposalId') && ['validate', 'preview_migration', 'apply_to_disposable', 'discard', 'promote', 'submit_change'].includes(name)
    try {
      // Bootstrap validates before any write, then audits accepted calls at the server root.
      if (name === 'bootstrap_instance') return await bootstrapInstance(this.store.root, raw)
      // Persist intent using only the request id and initialized canonical
      // directories. Closed proposals are rechecked under the lock without
      // starting an attempt that would revoke their promotion authorization.
      let attemptId = z.uuid().safeParse(args.proposalId).success && ['validate', 'preview_migration', 'apply_to_disposable', 'discard'].includes(name)
        ? await this.store.startSdkAttempt(String(args.proposalId), name) : undefined
      if (!this.store.allowed.size) {
        if (!Object.hasOwn(schemas, name)) fail('unknown_tool', 'Unknown tool', 404)
        await this.store.init()
      }
      // Resolve audit destination only within the allowlist; never log arguments or field/default values.
      if (typeof args.instance === 'string' && this.store.allowed.has(args.instance)) instance = args.instance
      let found: Awaited<ReturnType<Store['find']>> | undefined
      if (z.uuid().safeParse(args.proposalId).success) {
        proposalId = String(args.proposalId)
        // Discovery reads proposal metadata only, before taking its canonical lock.
        // Unknown proposal reads use the same conservative public SDK boundary.
        found = await this.store.find(proposalId)
        instance = found.instance
        sdk = name === 'upgrade_sdk' || found.proposal?.kind === 'sdk_upgrade'
        if (attemptId && !sdk) await this.store.clearNonSdkAttempt(proposalId)
      }
      if (!instance) fail('invalid_allowlist', 'Server has no allowed instances', 500)
      const audit = async () => {
        const log = join(await this.store.proposalDirectory(instance!), 'proposals', 'log.jsonl')
        await noLink(log, true)
        await appendFile(log, JSON.stringify({ timestamp: new Date().toISOString(), callId,
          tool: Object.hasOwn(schemas, name) ? name : 'unknown_tool', ...(proposalId ? { proposalId } : {}) }) + '\n', { mode: 0o600 })
        return log
      }
      if (sdk && found && ['validate', 'preview_migration', 'apply_to_disposable', 'discard'].includes(name)) {
        const targetInstance = found.instance
        return await this.store.lockedProposal(targetInstance, async recover => {
          if (found.proposal?.status === 'promoted' || found.proposal?.status === 'discarded' && name !== 'discard') {
            await recover()
            const status = (await this.store.find(proposalId!)).proposal?.status
            if (status === 'promoted' || status === 'discarded' && name !== 'discard') fail('proposal_closed', `Proposal is ${status}`, 409)
            attemptId ??= await this.store.startSdkAttempt(proposalId!, name)
          }
          const revoked = await this.store.revokeSdkProposal(proposalId!)
          await audit()
          const input = schemas[name as ToolName].parse(raw) as Record<string, any>
          const p = parseProposal(revoked.proposal)
          if (p.kind !== 'sdk_upgrade' || p.instance !== targetInstance || p.proposalId !== input.proposalId) fail('invalid_proposal', 'Proposal identity mismatch', 409)
          return executeSdkUpgrade(this.store, p, name, recover, signal, revoked.previousAccepted, attemptId, revoked.source)
        })
      }
      const log = await audit()
      if (!Object.hasOwn(schemas, name)) fail('unknown_tool', 'Unknown tool', 404)
      const input = schemas[name as ToolName].parse(raw) as Record<string, any>
      const targetInstance = input.instance ?? (await this.store.find(input.proposalId)).instance
      if (name === 'rollback') {
        const result = await rollback(this.store, targetInstance, Number(input.to.slice(1)), input)
        if (result.written === true) {
          // Attempts alone cannot prove publication. Persist only successful write metadata.
          await noLink(log, true)
          await appendFile(log, JSON.stringify({ timestamp: new Date().toISOString(), callId, tool: 'rollback',
            outcome: { written: true, fromRevision: result.fromRevision, newRevision: result.newRevision, migration: result.migration } }) + '\n', { mode: 0o600 })
        }
        return result
      }
      // Discover SDK proposals without inspecting application inputs, then reread
      // under the same canonical Instance lock used by configuration operations.
      if (input.proposalId && (await this.store.find(input.proposalId)).proposal?.kind === 'sdk_upgrade') {
        return await this.store.lockedProposal(targetInstance, async recover => {
          const p = parseProposal((await this.store.find(input.proposalId)).proposal)
          if (p.kind !== 'sdk_upgrade' || p.instance !== targetInstance || p.proposalId !== input.proposalId) fail('invalid_proposal', 'Proposal identity mismatch', 409)
          return executeSdkUpgrade(this.store, p, name, recover, signal, false, undefined,
            name === 'promote' ? await this.store.sdkProposalSource(input.proposalId) : undefined, input.expectedRevision)
        })
      }
      return await this.store.locked(targetInstance, async () => {
        if (name === 'upgrade_sdk') return proposeSdkUpgrade(this.store, targetInstance, input.baseRevision, input.targetVersion, proposalId!)
        if (name === 'submit_change') {
          const p = parseProposal((await this.store.find(input.proposalId)).proposal)
          if (p.instance !== targetInstance || p.proposalId !== input.proposalId) fail('invalid_proposal', 'Proposal identity mismatch', 409)
          requireConfigChange(p)
          return await submitChange(await this.store.directory(targetInstance), p, input.expectedBaseSha, this.github, () => this.store.dependencyDigest(targetInstance))
        }
        const bundle = await this.store.load(targetInstance)
        const diagnose = async () => {
          const errors: { code: string; message: string }[] = [...inspectInstance(bundle.config).errors]
          let meta: Awaited<ReturnType<typeof instanceMeta>> | null = null
          try { meta = await instanceMeta(bundle) }
          catch (error) { errors.push({ code: error instanceof WorkflowError || error instanceof MigrationReplayError ? error.code : 'invalid_migrations', message: error instanceof Error ? error.message : 'Cannot replay committed migrations' }) }
          return { validation: { ok: errors.length === 0, errors }, meta }
        }
        if (name === 'validate' && input.instance) return (await diagnose()).validation
        if (name === 'list_versions') return { ok: true, ...versionHistory(bundle.config, await readVersions(await this.store.directory(targetInstance))) }
        if (name === 'inspect_schema') {
          const dir = await this.store.directory(targetInstance)
          const pending = []
          for (const file of (await readdir(join(dir, 'proposals'))).filter(n => /^[a-f0-9-]+\.json$/.test(n))) {
            const found = await this.store.find(file.slice(0, -5))
            const p = parseProposal(found.proposal)
            if (!['promoted', 'discarded'].includes(p.status)) pending.push({ proposalId: p.proposalId, baseRevision: p.baseRevision, createdAt: p.createdAt, status: p.status })
          }
          const diagnostics = await diagnose()
          return { ok: true, instance: targetInstance, revision: bundle.config.revision, instance_meta: diagnostics.meta, validation: diagnostics.validation,
            entities: bundle.config.entities, roles: bundle.config.roles, permissions: bundle.config.permissions,
            locale: bundle.config.locale, ui: bundle.config.ui, enumLabels: bundle.config.enumLabels,
            policies: effectivePolicies(bundle.config), organizationPermissions: bundle.config.organizationPermissions,
            indexes: bundle.indexes, pendingProposals: pending }
        }
        if (name === 'propose_change') {
          this.revision(bundle, input.baseRevision)
          if (input.changes.some((change: { kind: string }) => ['set_display_field', 'set_label', 'add_role', 'remove_role', 'set_permissions', 'set_organization_permissions'].includes(change.kind))) prepareChanges(bundle.config, bundle.indexes, input.changes)
          else guard(input.changes, bundle.config)
          const p: LegacyConfigProposal = { proposalId: proposalId!, instance: targetInstance, baseRevision: input.baseRevision,
            changes: input.changes, createdAt: new Date().toISOString(), status: 'proposed' }
          await this.save(p)
          return { ok: true, proposalId: p.proposalId, baseRevision: p.baseRevision, status: p.status }
        }
        const found = await this.store.find(input.proposalId)
        const p = parseProposal(found.proposal)
        if (p.instance !== targetInstance || p.proposalId !== input.proposalId) fail('invalid_proposal', 'Proposal identity mismatch', 409)
        const save = () => this.save(proposalRecord(p, found.proposal))
        if (name === 'discard') {
          if (p.status === 'promoted') fail('already_promoted', 'A promoted migration cannot be discarded', 409)
          p.status = 'discarded'
          if (p.kind === 'config_change') { delete p.validation; delete p.verification }
          await save()
          return { ok: true, status: p.status }
        }
        requireConfigChange(p)
        if (name === 'promote') this.revision(bundle, input.expectedRevision)
        this.revision(bundle, p.baseRevision)
        if (['discarded', 'promoted'].includes(p.status)) fail('proposal_closed', `Proposal is ${p.status}`, 409)
        if (name === 'validate') {
          delete p.validation; delete p.verification; p.status = 'proposed'
          try {
            await instanceMeta(bundle)
            const prepared = prepare(bundle.config, bundle.indexes, p.changes)
            await expectedSnapshot(bundle, prepared)
            p.validation = this.proof(bundle, prepared); p.status = 'validated'
            await save()
            return { ok: true, errors: [], revision: prepared.target.revision, warnings: prepared.warnings }
          } catch (error) {
            await save()
            const detail = error instanceof Error ? error.message : 'Invalid configuration'
            return { ok: false, errors: isDisplayFieldError(error) ? error.errors : error instanceof WorkflowError && Array.isArray(error.details) ? error.details : [{ code: error instanceof WorkflowError || error instanceof MigrationReplayError ? error.code : 'invalid_config', message: detail }] }
          }
        }
        await instanceMeta(bundle)
        const prepared = prepare(bundle.config, bundle.indexes, p.changes)
        const expected = await expectedSnapshot(bundle, prepared)
        const proof = this.proof(bundle, prepared)
        if (name === 'preview_migration') return { ok: true, sql: prepared.sql, configDiff: prepared.patch, revision: prepared.target.revision }
        if (name === 'promote' && bundle.dependencyDigest !== undefined && p.verification && p.verification.dependencyDigest !== bundle.dependencyDigest) fail('dependencies_changed', 'Závislosti instance se změnily nebo chybí jejich ověření. Návrh je nutné znovu ověřit pomocí validate a apply_to_disposable.', 409)
        if (!p.validation || hash(p.validation) !== hash(proof)) fail('validation_required', 'Validate this exact proposal against the current files first', 409)
        if (name === 'apply_to_disposable') {
          delete p.verification; p.status = 'validated'; await save()
          await assertRemovedRolesUnused(targetInstance, p.changes)
          const verification = await applyDisposable(bundle, prepared, expected, input.keep ?? false, signal)
          if (verification.verified) { p.verification = proof; p.status = 'verified' }
          await save()
          return { ok: verification.verified, ...verification }
        }
        if (name === 'promote') {
          if (!p.verification || hash(p.verification) !== hash(proof)) fail('verification_required', 'Apply and verify this exact proposal on a disposable D1 first', 409)
          // Re-read immediately before writing under the cross-process instance lock.
          const latest = await this.store.load(targetInstance)
          this.revision(latest, input.expectedRevision)
          if (latest.dependencyDigest !== bundle.dependencyDigest) fail('dependencies_changed', 'Závislosti instance se změnily. Návrh je nutné znovu ověřit pomocí validate a apply_to_disposable.', 409)
          if (latest.fingerprint !== bundle.fingerprint) fail('stale_revision', 'Instance files changed since validation', 409)
          await assertRemovedRolesUnused(targetInstance, p.changes)
          const number = Math.max(0, ...bundle.migrations.map(m => Number(m.name.slice(0, 4)))) + 1
          if (number > 9999) fail('migration_limit', 'Migration number exceeds four digits')
          const slug = `${p.changes[0].kind}_${p.proposalId.slice(0, 8)}`
          const migration = `${String(number).padStart(4, '0')}_${slug}.sql`
          p.status = 'promoted'; p.promotedRevision = prepared.target.revision; p.migration = migration
          const files = [
            { path: `migrations/${migration}`, data: prepared.sql, create: true },
            ...await versionFiles(await this.store.directory(targetInstance), bundle.config, prepared.target),
            { path: 'config.ts', data: configSource(prepared.target, { history: true }) },
            { path: 'config.indexes.json', data: json(prepared.indexes) },
          ]
          if (bundle.dependencyDigest !== undefined) p.dependencyDigest = bundle.dependencyDigest
          p.promotedFiles = files.map(({ path, data }) => ({ path, data }))
          p.migrationPreview = { sql: prepared.sql, configDiff: prepared.patch, revision: prepared.target.revision }
          p.promotionHash = promotionHash(p)
          await this.store.commit(targetInstance, [...files, { path: `proposals/${p.proposalId}.json`, data: json(proposalRecord(p, found.proposal)) }], latest.guards)
          return { ok: true, status: p.status, revision: prepared.target.revision, migration, appliesToDatabase: false }
        }
        return fail('unknown_tool', 'Unknown tool', 404)
      })
    } catch (error) { return errorResult(sdk ? sdkWorkflowError(error) : error) }
  }
  private revision(bundle: Bundle, revision: number) {
    if (bundle.config.revision !== revision) fail('stale_revision', 'Revision changed; inspect and propose against the current revision', 409)
  }
  private proof(bundle: Bundle, prepared: ReturnType<typeof prepare>) {
    return { fingerprint: bundle.fingerprint, planHash: hash({ target: prepared.target, indexes: prepared.indexes, sql: prepared.sql }), ...(bundle.dependencyDigest !== undefined ? { dependencyDigest: bundle.dependencyDigest } : {}) }
  }
  private async save(p: Proposal | LegacyConfigProposal) {
    const dir = await this.store.directory(p.instance)
    await atomic(join(dir, 'proposals', `${p.proposalId}.json`), json(p))
  }
}
