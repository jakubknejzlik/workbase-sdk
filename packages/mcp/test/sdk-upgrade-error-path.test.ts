import { expect, it, vi } from 'vitest'
import { executeSdkUpgrade, sdkWorkflowError } from '../src/sdk-upgrade.ts'
import { SqlTokenizationError } from '../src/sql-tokens.ts'

vi.mock('../src/offline.ts', () => ({
  instanceMeta: async () => ({ revision: 1, core_version: '0.2.1' }),
}))
vi.mock('../src/sdk-target.ts', () => ({
  captureSdkInputs: async () => ({ 'config.ts': Buffer.from('fixture') }),
  runSdkTarget: async () => { throw new SqlTokenizationError(7) },
}))
it('preserves the parent-reconstructed tokenizer code through SDK execution and public handling', async () => {
  const store = {
    load: async () => ({ config: { id: 'fixture', revision: 1 }, dependencyDigest: 'b'.repeat(64), fingerprint: 'a'.repeat(64) }),
    directory: async () => 'unused-runner-directory',
    revokeSdkProposal: vi.fn(async () => undefined),
  }
  const proposal = { kind: 'sdk_upgrade', proposalId: '12345678-1234-4123-8123-123456789abc', instance: 'fixture', status: 'proposed',
    baseRevision: 1, targetVersion: '0.2.10', baseFingerprint: 'a'.repeat(64), baseDependencyDigest: 'b'.repeat(64) }
  let caught: unknown
  try { await executeSdkUpgrade(store as any, proposal as any, 'validate', async () => undefined) }
  catch (error) { caught = error }
  const result = sdkWorkflowError(caught)
  expect(store.revokeSdkProposal).toHaveBeenCalledTimes(1)
  expect(caught).toBeInstanceOf(SqlTokenizationError)
  expect(result).toMatchObject({ code: 'sql_tokenization_unsupported', details: { phase: 'verification' } })
})
