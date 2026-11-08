import { expect, it } from 'vitest'
import { migrationErrorMessage } from '../../src/infra/cli'
import { MigrationDiagnostic, redactCliOutput } from '../../src/infra/diagnostics'

it.each(['usage:', 'migration_', 'duplicate_', 'no_migrations:', 'invalid_', 'd1_'])('does not trust external messages starting with %s', prefix => {
  const error = new Error(`${prefix} private customer data`)
  error.name = 'invalid_private_name'
  Object.assign(error, { code: 'invalid_private_code' })
  expect(migrationErrorMessage(error, {})).toBe('migration_failed:Error')
})

it('requires a real internal brand and never reads external diagnostic properties', () => {
  const forged = Object.create(MigrationDiagnostic.prototype, { message: { value: 'invalid_private_data' } })
  expect(migrationErrorMessage(forged, {})).toBe('migration_failed:Error')
  const error = new Error()
  for (const key of ['message', 'name', 'code', 'cause', 'stack']) Object.defineProperty(error, key, { get() { throw new Error('private data') } })
  expect(migrationErrorMessage(error, {})).toBe('migration_failed:Error')
  expect(migrationErrorMessage('invalid_private_data', {})).toBe('migration_failed:UnknownError')
  expect(migrationErrorMessage(new Proxy({}, { getPrototypeOf() { throw new Error('private data') } }), {})).toBe('migration_failed:UnknownError')
})

it('prints saved vetted internal details rather than mutable Error properties', () => {
  const error = new MigrationDiagnostic({ code: 'migration_history_mismatch', filename: '0001_initial.sql' })
  error.message = 'invalid_private_data'
  expect(migrationErrorMessage(error, {})).toBe('migration_history_mismatch:0001_initial.sql')
  expect(migrationErrorMessage(new MigrationDiagnostic({ code: 'migration_history_mismatch', filename: 'private data\nforged log' }), {})).toBe('migration_history_mismatch')
  expect(migrationErrorMessage(new MigrationDiagnostic({ code: 'd1_http_status', status: 403 }), {})).toBe('d1_http_status:403')
  expect(migrationErrorMessage(new MigrationDiagnostic({ code: 'd1_http_status', status: NaN }), {})).toBe('d1_http_status')
})

it('redacts all occurrences of known secret environment values, including escaped output', () => {
  const env = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_API_KEY: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-aws', DATABASE_PASSWORD: 'test-password', PRIVATE_KEY: 'line1\nline2', GITHUB_TOKEN: '', PATH: '/safe/path' }
  const text = Object.values(env).join('|') + JSON.stringify(env)
  const redacted = redactCliOutput(text, env)
  for (const value of ['test-token', 'test-key', 'test-aws', 'test-password', 'line1\nline2', 'line1\\nline2']) expect(redacted).not.toContain(value)
  expect(redacted).toContain('/safe/path')
  const error = new MigrationDiagnostic({ code: 'migration_history_mismatch', filename: '0001_test-token.sql' })
  expect(migrationErrorMessage(error, env)).toBe('migration_history_mismatch:0001_[redacted].sql')
})
