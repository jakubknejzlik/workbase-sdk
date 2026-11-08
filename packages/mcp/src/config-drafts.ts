import { prepareConfigProposal, RuleConfigProposer, type ConfigProposer, type ConfigProposal } from '@workbasehq/core/config-proposals'
import { versionHistory } from '@workbasehq/core/migrations/versions'
import { expectedSnapshot, instanceMeta } from './offline'
import { fail } from './schemas'
import { Store } from './storage'
import { publishConfigVersion, readVersions } from './versions'

/** Local editor sessions hold immutable proposals; clients apply only an opaque ID. */
export class ConfigDrafts {
  private proposals = new Map<string, { instance: string; fingerprint: string; proposal: ConfigProposal; applied?: { revision: number; migration: string; appliesToDatabase: false } }>()
  constructor(public store: Store, private proposer: ConfigProposer = new RuleConfigProposer()) {}
  async history(instance: string) {
    return this.store.locked(instance, async () => versionHistory((await this.store.load(instance)).config, await readVersions(await this.store.directory(instance))))
  }
  async propose(instance: string, prompt: string): Promise<ConfigProposal> {
    // Do not hold the file lock during a potentially slow model request.
    const bundle = await this.store.locked(instance, () => this.store.load(instance))
    const prepared = prepareConfigProposal(bundle.config, await this.proposer.propose(prompt, bundle.config))
    instanceMeta(bundle)
    expectedSnapshot(bundle, { target: prepared.target, indexes: bundle.indexes, sql: prepared.plan.sql })
    const proposal: ConfigProposal = { proposalId: crypto.randomUUID(), baseRevision: bundle.config.revision, revision: prepared.target.revision, patch: prepared.patch, changes: prepared.changes, plan: prepared.plan, appliesToDatabase: false }
    // Bound session memory; expired previews can simply be proposed again.
    if (this.proposals.size >= 100) this.proposals.delete(this.proposals.keys().next().value!)
    this.proposals.set(proposal.proposalId, { instance, fingerprint: bundle.fingerprint, proposal: structuredClone(proposal) })
    return proposal
  }
  async apply(instance: string, proposalId: string) {
    const saved = this.proposals.get(proposalId)
    if (!saved || saved.instance !== instance) fail('proposal_not_found', 'Propose again in this editor session', 404)
    return this.store.locked(instance, async () => {
      if (saved.applied) return saved.applied
      const bundle = await this.store.load(instance)
      if (bundle.fingerprint !== saved.fingerprint) fail('stale_revision', 'Local files changed; propose again before applying', 409)
      const prepared = prepareConfigProposal(bundle.config, saved.proposal.patch)
      instanceMeta(bundle)
      expectedSnapshot(bundle, { target: prepared.target, indexes: bundle.indexes, sql: prepared.plan.sql })
      const migration = await publishConfigVersion(this.store, instance, bundle, prepared.target, prepared.plan.sql, `prompt_${proposalId.slice(0, 8)}`)
      saved.applied = { revision: prepared.target.revision, migration, appliesToDatabase: false }
      return saved.applied
    })
  }
}
