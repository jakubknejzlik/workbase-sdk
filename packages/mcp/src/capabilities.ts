import metadata from '../package.json' with { type: 'json' }
import { schemas } from './schemas.ts'
import { changeKinds, changeRoute, compositionEligibility, eligible, schemaEligibility, schemaKinds, submissionPromotionEligibility, type Eligibility } from './change-routing.ts'
import { compositionChangeSchema } from './schemas.ts'
import { legacyWriteEligibility } from './v3-guard.ts'

/** Operator-owned metadata only. Must not retrieve credentials, targets or use the network.
 * Missing/throwing resolvers report false. The GitHubConfiguration callback is never probed.
 */
export type SubmissionConfigured = (instance: string) => boolean
const compositionKinds = new Set(schemaKinds(compositionChangeSchema))
export function capabilities(instance: string, baseline: string | undefined, configured?: SubmissionConfigured) {
  let submissionConfigured = false
  try { submissionConfigured = configured?.(instance) === true } catch { /* metadata fails closed without exposing errors */ }
  const firstSubmitGate = submissionPromotionEligibility('proposed')
  const blockedBy = (stage: string, decision: Eligibility) => decision.eligible ? undefined : { stage, code: decision.error.code }
  const changes = changeKinds.map(kind => {
    const changes = [{ kind }], route = changeRoute(baseline, changes)
    const routeEligibility = route === 'composition' ? compositionEligibility(baseline, changes) : route === 'schema' ? schemaEligibility(baseline) : eligible
    const propose = route === 'legacy' ? legacyWriteEligibility(baseline, 'propose', changes) : routeEligibility
    const promote = route === 'legacy' ? legacyWriteEligibility(baseline, 'promote') : routeEligibility
    const upstream = blockedBy('propose', propose) ?? blockedBy('promote', promote)
    return { kind, route, propose: { ...propose, reachable: propose.eligible },
      ...(compositionKinds.has(kind) ? { viaProposeComposition: compositionEligibility(baseline, changes) } : {}),
      promote: { ...promote, reachable: propose.eligible && promote.eligible, prerequisites: ['validation_required', 'verification_required', 'current_revision_and_sources'],
        ...(blockedBy('propose', propose) ? { blockedBy: blockedBy('propose', propose) } : {}) },
      submit: { eligible: true, reachable: !upstream && submissionConfigured,
        firstPrerequisite: firstSubmitGate.eligible ? undefined : firstSubmitGate.error.code,
        prerequisites: ['verification_required', 'promotion_snapshot_required', 'operator_github_configuration', 'current_promoted_files_and_dependencies', 'expected_base_sha'],
        ...(upstream ? { blockedBy: upstream } : !submissionConfigured ? { blockedBy: { stage: 'submit', code: 'github_not_configured' } } : {}) },
    }
  })
  return { ok: true, version: metadata.version, instance, baseline: baseline === 'workbase-sdk' ? 'v3' : 'legacy', submissionConfigured,
    tools: Object.keys(schemas), changes,
    qualifications: [
      'Eligibility describes a change kind routed through propose_change, not a guarantee for every input. Reachability assumes all normal prerequisites succeed.',
      'Inputs must pass strict schemas, semantic validation, source-shape and canonical runtime checks, revision/source/dependency guards, committed history replay, and disposable verification. Source-shape errors such as invalid_access or runtime_not_canonical can precede baseline eligibility errors.',
      'set_constraints must be proposed separately. Composition and legacy changes cannot mix. V3 presentation batches cannot mix with runtime/access/schema changes; set_locale/set_label route through legacy on legacy baselines.',
      'Role removal and owner transitions require target database safety evidence; plugin changes require compatible built-ins and deployment requirements.',
      'Submission requires successful local promotion, matching persisted validation/verification and promoted-file proofs, unchanged sources/dependencies, an expected GitHub base SHA and operator configuration. Metadata does not prove credential availability or a successful PR.',
      'V3 physical add_field is proposable but promotion returns v3_promote_unsupported. Its submit gate still returns promotion_required; the upstream promotion restriction prevents end-to-end submission.',
      'Promotion publishes local files. Submission opens/returns a PR. Neither merges nor deploys.',
    ],
  }
}
