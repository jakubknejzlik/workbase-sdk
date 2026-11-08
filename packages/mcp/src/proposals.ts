import { z } from 'zod'
import { changeSchema, fail } from './schemas.ts'
import { migrationPreviewSchema, promotedFilesSchema } from './submit-change.ts'

const envelope = {
  proposalId: z.uuid(), instance: z.string(), baseRevision: z.number().int().positive(), createdAt: z.iso.datetime(),
}
const proofSchema = z.strictObject({ fingerprint: z.string(), planHash: z.string(), dependencyDigest: z.string().optional() })
// Keep the legacy config contract, including its optional historical proofs, unchanged.
const legacyConfigSchema = z.strictObject({
  ...envelope,
  status: z.enum(['proposed', 'validated', 'verified', 'promoted', 'discarded']),
  changes: z.array(changeSchema), validation: proofSchema.optional(), verification: proofSchema.optional(),
  promotedFiles: promotedFilesSchema.optional(), migrationPreview: migrationPreviewSchema.optional(), promotionHash: z.string().optional(),
  dependencyDigest: z.string().optional(),
  promotedRevision: z.number().int().optional(), migration: z.string().optional(),
})
const configChangeSchema = legacyConfigSchema.extend({ kind: z.literal('config_change') })
// SemVer 2.0.0: no ranges, tags, leading zeroes or surrounding whitespace.
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const digest = z.string().regex(/^[a-f0-9]{64}$/).refine(value => !/\s/.test(value))
const sdkUpgradeSchema = z.strictObject({
  ...envelope, kind: z.literal('sdk_upgrade'), status: z.enum(['proposed', 'discarded']),
  targetVersion: z.string().regex(exactVersion).refine(value => !/\s/.test(value)),
  baseFingerprint: digest, baseDependencyDigest: digest,
})
export const proposalSchema = z.discriminatedUnion('kind', [configChangeSchema, sdkUpgradeSchema])
export type ConfigChangeProposal = z.infer<typeof configChangeSchema>
export type SdkUpgradeProposal = z.infer<typeof sdkUpgradeSchema>
export type Proposal = z.infer<typeof proposalSchema>
export type LegacyConfigProposal = z.infer<typeof legacyConfigSchema>

export function parseProposal(record: unknown): Proposal {
  // Only an absent discriminator may use the adapter. Tagged malformed/future
  // records must never fall through to config parsing.
  const legacy = typeof record === 'object' && record !== null && !Object.hasOwn(record, 'kind')
  const result = legacy ? legacyConfigSchema.safeParse(record) : proposalSchema.safeParse(record)
  if (!result.success) fail('invalid_proposal', 'Proposal has an unsupported kind, lifecycle or fields', 409)
  return legacy ? { ...result.data as LegacyConfigProposal, kind: 'config_change' } : result.data as Proposal
}

/** Preserve untagged config records on write; parsing never migrates stored bytes. */
export function proposalRecord(proposal: Proposal, original: unknown): Proposal | LegacyConfigProposal {
  if (proposal.kind === 'config_change' && typeof original === 'object' && original !== null && !Object.hasOwn(original, 'kind')) {
    const { kind: _kind, ...legacy } = proposal
    return legacy
  }
  return proposal
}
