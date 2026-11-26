import { expect, it } from 'vitest'
import { changeReceiptSchema, type ChangeReceipt } from '../src/submit-change.ts'

const receipt: ChangeReceipt = {
  version: 1,
  guarantee: 'consistency',
  proposalId: '00000000-0000-4000-8000-000000000001',
  instance: 'example-instance',
  kind: 'config_change',
  baseRevision: 1,
  promotedRevision: 2,
  expectedBaseSha: 'a'.repeat(40),
  planHash: 'b'.repeat(64),
  promotionHash: 'c'.repeat(64),
  validationFingerprint: 'd'.repeat(64),
  verificationFingerprint: 'd'.repeat(64),
  dependencyDigest: 'e'.repeat(64),
  sdkVersion: '0.4.1',
  promotedFiles: [{ path: 'config.ts', sha256: 'f'.repeat(64) }],
  allowlist: ['config.ts', 'migrations/0002_proposal.sql'],
  disposableApply: {
    verified: true,
    tables: ['records'],
    columns: [{ table: 'records', name: 'title' }],
    indexes: [{ table: 'records', name: 'records_title_idx' }],
  },
}

it.each(['config_change', 'composition_change', 'schema_change'] as const)('accepts a synthetic %s receipt', kind => {
  // Composition changes can preserve the domain revision.
  const input = { ...receipt, kind, promotedRevision: kind === 'composition_change' ? 1 : 2 }
  expect(changeReceiptSchema.parse(input)).toEqual(input)
})

it.each(Object.keys(receipt))('requires %s', key => {
  const input: Record<string, unknown> = { ...receipt }
  delete input[key]
  expect(changeReceiptSchema.safeParse(input).success).toBe(false)
})

it.each([
  { ...receipt, extra: true },
  { ...receipt, promotedFiles: [{ ...receipt.promotedFiles[0], data: 'untrusted bytes' }] },
  { ...receipt, disposableApply: { ...receipt.disposableApply, directory: '/private/path' } },
  { ...receipt, disposableApply: { ...receipt.disposableApply, columns: [{ table: 'records', name: 'title', extra: true }] } },
  { ...receipt, disposableApply: { ...receipt.disposableApply, indexes: [{ table: 'records', name: 'records_title_idx', extra: true }] } },
])('rejects unknown keys at every object boundary (%#)', input => {
  expect(changeReceiptSchema.safeParse(input).success).toBe(false)
})

it.each(['expectedBaseSha', 'planHash', 'promotionHash', 'validationFingerprint', 'verificationFingerprint', 'dependencyDigest', 'sha256'])(
  'rejects malformed %s hashes', key => {
    const length = key === 'expectedBaseSha' ? 40 : 64
    for (const value of ['', 'a'.repeat(length - 1), 'a'.repeat(length + 1), 'g'.repeat(length), 'A'.repeat(length), `sha256:${'a'.repeat(length)}`]) {
      const input = key === 'sha256'
        ? { ...receipt, promotedFiles: [{ path: 'config.ts', sha256: value }] }
        : { ...receipt, [key]: value }
      expect(changeReceiptSchema.safeParse(input).success).toBe(false)
    }
  },
)

it.each(['service_provenance', 'denial_of_direct_agent_writes', '', null])('rejects guarantee %s', guarantee => {
  expect(changeReceiptSchema.safeParse({ ...receipt, guarantee }).success).toBe(false)
})

it.each(['', '/config.ts', '../config.ts', 'schema/../../config.ts', 'schema/../config.ts', './config.ts', 'schema/./record.ts',
  'schema//record.ts', 'schema/', 'C:/config.ts', 'C:\\config.ts', '\\\\host\\config.ts', 'schema\\..\\config.ts',
  'file:///config.ts', 'config.ts\u0000', 'config.ts\n', '.', '..'])('rejects unsafe file path %j', path => {
  expect(changeReceiptSchema.safeParse({ ...receipt, allowlist: [path] }).success).toBe(false)
  expect(changeReceiptSchema.safeParse({ ...receipt, promotedFiles: [{ path, sha256: 'f'.repeat(64) }] }).success).toBe(false)
})

it.each([
  { version: 2 }, { kind: 'unknown' }, { proposalId: 'not-a-uuid' }, { instance: '../instance' },
  { baseRevision: 0 }, { promotedRevision: 1.5 }, { sdkVersion: 'latest' },
  { promotedFiles: [] }, { allowlist: [] },
  { promotedFiles: [{ path: 'config.ts' }] },
  { disposableApply: { verified: false, tables: [], columns: [], indexes: [] } },
  { disposableApply: { verified: true, columns: [], indexes: [] } },
  { disposableApply: { verified: true, tables: [], indexes: [] } },
  { disposableApply: { verified: true, tables: [], columns: [] } },
  { disposableApply: { ...receipt.disposableApply, columns: [{ name: 'title' }] } },
  { disposableApply: { ...receipt.disposableApply, indexes: [{ table: 'records' }] } },
])('rejects invalid or incomplete evidence (%#)', patch => {
  expect(changeReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false)
})
