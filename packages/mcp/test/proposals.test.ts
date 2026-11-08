import { expect, it } from 'vitest'
import { parseProposal, proposalRecord, proposalSchema } from '../src/proposals.ts'
import { dependencySnapshot, json } from '../src/storage.ts'

const envelope = {
  proposalId: 'e5529735-8c44-4365-a8e3-48b8efea0865', instance: 'sample', baseRevision: 2,
  createdAt: '2026-11-08T12:00:00.000Z',
}
const upgrade = {
  ...envelope, kind: 'sdk_upgrade', status: 'proposed', targetVersion: '1.2.3',
  baseFingerprint: 'a'.repeat(64), baseDependencyDigest: 'b'.repeat(64),
}
const changes = [{ kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text' } }]
it('parses an SDK upgrade as a distinct dependency-bound proposal (base-red)', () => {
  expect(parseProposal(upgrade)).toEqual(upgrade)
})
it.each(['0.0.0', '1.2.3', '1.2.3-rc.1', '1.2.3+build.01', '1.2.3-rc.1+build.01'])('accepts exact SemVer %j', targetVersion => {
  expect(parseProposal({ ...upgrade, targetVersion })).toMatchObject({ kind: 'sdk_upgrade', targetVersion })
})
it.each(['^1.2.3', '~1.2.3', 'latest', '1.2', 'v1.2.3', '01.2.3', '1.2.3-01', '1.2.3\n', ' 1.2.3', '1.2.3-', '1.2.3+'])('rejects non-exact version %j', targetVersion => {
  expect(() => parseProposal({ ...upgrade, targetVersion })).toThrow(expect.objectContaining({ code: 'invalid_proposal' }))
})
it.each(['baseFingerprint', 'baseDependencyDigest'])('requires a SHA-256 %s', field => {
  for (const value of [undefined, '', 'sha256:abc', 'A'.repeat(64), 'b'.repeat(63), 'b'.repeat(64) + '\n']) {
    expect(() => parseProposal({ ...upgrade, [field]: value })).toThrow(expect.objectContaining({ code: 'invalid_proposal' }))
  }
})
it('accepts the dependency snapshot digest format', async () => {
  const { digest } = await dependencySnapshot('packages/mcp')
  expect(parseProposal({ ...upgrade, baseDependencyDigest: digest })).toMatchObject({ baseDependencyDigest: digest })
})
it.each(['validated', 'verified', 'promoted', 'submitted', 'unknown'])('rejects unsupported upgrade lifecycle %s', status => {
  expect(() => parseProposal({ ...upgrade, status })).toThrow(expect.objectContaining({ code: 'invalid_proposal' }))
})
it.each([
  'changes', 'validation', 'verification', 'promotedFiles', 'migrationPreview', 'promotionHash', 'dependencyDigest',
  'promotedRevision', 'migration', 'evidence', 'unknown',
])('rejects mixed/unsupported SDK field %s even when undefined', field => {
  for (const value of [undefined, changes]) {
    expect(() => parseProposal({ ...upgrade, [field]: value })).toThrow(expect.objectContaining({ code: 'invalid_proposal' }))
  }
})
it('accepts only proposed and discarded SDK records', () => {
  expect(parseProposal({ ...upgrade, status: 'discarded' })).toMatchObject({ kind: 'sdk_upgrade', status: 'discarded' })
})
it.each(['future_kind', '', null, undefined, 1])('never adapts an explicit unknown kind %j to config', kind => {
  expect(() => parseProposal({ ...envelope, status: 'proposed', changes, kind })).toThrow(expect.objectContaining({ code: 'invalid_proposal' }))
})
it('does not infer an upgrade from an untagged or config-tagged mixed record', () => {
  const { kind: _kind, ...untagged } = upgrade
  expect(() => parseProposal(untagged)).toThrow(expect.objectContaining({ code: 'invalid_proposal' }))
  expect(() => parseProposal({ ...upgrade, kind: 'config_change', changes })).toThrow(expect.objectContaining({ code: 'invalid_proposal' }))
})
it('keeps the tagged union strict while adapting only legacy config records', () => {
  const legacy = { ...envelope, status: 'proposed', changes }
  expect(proposalSchema.safeParse(legacy).success).toBe(false)
  expect(parseProposal(legacy)).toEqual({ ...legacy, kind: 'config_change' })
  const tagged = { ...legacy, kind: 'config_change' }
  expect(proposalRecord(parseProposal(tagged), tagged)).toEqual(tagged)
})
it.each(['proposed', 'validated', 'verified', 'promoted', 'discarded'])('round trips old %s config bytes and proof fields', status => {
  for (const dependencyDigest of [undefined, 'legacy-digest', 'b'.repeat(64)]) {
    const proof = { fingerprint: 'old-fingerprint', planHash: 'old-plan', ...(dependencyDigest ? { dependencyDigest } : {}) }
    const legacy = {
      ...envelope, status, changes,
      ...(status !== 'proposed' ? { validation: proof, verification: proof } : {}),
      ...(status === 'promoted' ? {
        promotedFiles: [{ path: 'config.ts', data: 'exact\r\nbytes' }], migrationPreview: { sql: '-- sql', configDiff: [], revision: 3 },
        promotionHash: 'old-hash', ...(dependencyDigest ? { dependencyDigest } : {}), promotedRevision: 3, migration: '0003_notes.sql',
      } : {}),
    }
    const before = json(legacy)
    const parsed = parseProposal(legacy)
    expect(parsed).toEqual({ ...legacy, kind: 'config_change' })
    expect(json(proposalRecord(parsed, legacy))).toBe(before)
    expect(json(legacy)).toBe(before)
  }
})
