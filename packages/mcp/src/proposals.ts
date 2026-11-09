import { z } from 'zod'
import { changeSchema, exactVersion, fail } from './schemas.ts'
import { migrationPreviewSchema, promotedFilesSchema } from './submit-change.ts'
import { digestBytes, inputHashesSchema, inputPath, resultSchema, sha256Schema } from './sdk-upgrade-protocol.ts'
import { sdkNames } from './sdk-registry.ts'

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
const digest = z.string().regex(/^[a-f0-9]{64}$/).refine(value => !/\s/.test(value))
const packageName = z.enum(['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp'])
const artifact = z.strictObject({
  data: z.string().refine(value => Buffer.from(value, 'base64').toString('base64') === value), sha256: sha256Schema,
})
export const sdkEvidenceSchema = z.strictObject({
  state: z.enum(['validated', 'verified']), proposalId: z.uuid(),
  // Historical evidence can still be parsed, but cannot authorize consumption
  // without a successful, input-bound attempt (enforced under the Store lock).
  binding: z.strictObject({ event: z.literal('attempt-succeeded'), attemptId: z.uuid(), digest: sha256Schema }).optional(),
  baseInputHashes: inputHashesSchema, targetDependencyDigest: sha256Schema,
  result: resultSchema,
  artifacts: z.record(inputPath, artifact),
  archives: z.array(z.strictObject({ name: packageName, sha256: sha256Schema, sha512: z.string().regex(/^[a-f0-9]{128}$/) })).length(3),
  installed: z.array(z.strictObject({ name: packageName, sha256: sha256Schema })).length(3),
})
const sdkUpgradeSchema = z.strictObject({
  ...envelope, kind: z.literal('sdk_upgrade'), status: z.enum(['proposed', 'validated', 'verified', 'promoted', 'discarded']),
  targetVersion: z.string().regex(exactVersion).refine(value => !/\s/.test(value)),
  baseFingerprint: digest, baseDependencyDigest: digest,
  evidence: sdkEvidenceSchema.optional(),
  // Keep accepted base evidence immutable. This independently binds the exact
  // published target inputs, including the new marker, for restart consumption.
  promotion: z.strictObject({ inputHashes: inputHashesSchema, digest: sha256Schema }).optional(),
}).superRefine((proposal, ctx) => {
  const reject = () => ctx.addIssue({ code: 'custom', message: 'Inconsistent SDK evidence' })
  const evidence = proposal.evidence
  const promoted = proposal.status === 'promoted'
  if (promoted !== !!proposal.promotion) reject()
  if (!['validated', 'verified', 'promoted'].includes(proposal.status)) { if (evidence !== undefined) reject(); return }
  if (!evidence || evidence.state !== (promoted ? 'verified' : proposal.status) || evidence.proposalId !== proposal.proposalId) { reject(); return }
  const { result, artifacts } = evidence, identity = result.identity
  if (identity.instanceId.replaceAll('_', '-') !== proposal.instance || identity.targetVersion !== proposal.targetVersion
    || identity.baseRevision !== proposal.baseRevision || identity.baseFingerprint !== proposal.baseFingerprint
    || identity.baseDependencyDigest !== proposal.baseDependencyDigest || result.coreVersion !== proposal.targetVersion
    || result.marker.version !== proposal.targetVersion || result.marker.revision !== proposal.baseRevision
    || result.schema.expected !== result.schema.applied || result.plugins.expected !== result.plugins.applied) reject()
  for (const entries of [result.packages, evidence.archives, evidence.installed]) {
    if (new Set(entries.map(entry => entry.name)).size !== 3 || sdkNames.some(name => !entries.some(entry => entry.name === name))) reject()
  }
  if (result.packages.some(pkg => pkg.version !== proposal.targetVersion)) reject()
  const paths = ['package.json', 'bun.lock', result.stage.marker.path]
  if (!/^migrations\/[0-9]{4}_sdk_upgrade\.sql$/.test(result.stage.marker.path)
    || Object.keys(artifacts).length !== 3 || paths.some(path => !artifacts[path])) { reject(); return }
  for (const path of paths) {
    const file = artifacts[path]
    if (digestBytes(Buffer.from(file.data, 'base64')) !== file.sha256
      || file.sha256 !== (path === result.stage.marker.path ? result.stage.marker.sha256 : result.inputHashes[path])) reject()
  }
  if (evidence.targetDependencyDigest !== digestBytes(JSON.stringify(Object.fromEntries(['package.json', 'bun.lock'].map(path => [path, artifacts[path].sha256]))))) reject()
  const basePaths = Object.keys(evidence.baseInputHashes).sort(), targetPaths = Object.keys(result.inputHashes).sort()
  if (JSON.stringify(basePaths) !== JSON.stringify(targetPaths) || !['config.ts', 'package.json', 'bun.lock'].every(path => basePaths.includes(path))
    || basePaths.some(path => !['package.json', 'bun.lock'].includes(path) && evidence.baseInputHashes[path] !== result.inputHashes[path])) reject()
  if (Object.hasOwn(evidence.baseInputHashes, result.stage.marker.path)) reject()
  if (promoted) {
    const expected = { ...result.inputHashes, [result.stage.marker.path]: result.stage.marker.sha256 }
    const actual = proposal.promotion?.inputHashes
    if (!actual || Object.keys(actual).length !== Object.keys(expected).length
      || Object.entries(expected).some(([path, digest]) => actual[path] !== digest)) reject()
  }
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
