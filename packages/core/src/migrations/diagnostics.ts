const messages = {
  usage: 'usage: workbase-migrate migrate <database-id> <migration-directory> [--config <module-path>]; requires CLOUDFLARE_DEFAULT_ACCOUNT_ID and CLOUDFLARE_API_TOKEN',
  invalid_config_default_export: 'invalid_config_default_export',
  invalid_cloudflare_ids: 'invalid_cloudflare_ids',
  duplicate_migration_filename: 'duplicate_migration_filename',
  d1_query_failed: 'd1_query_failed',
  d1_api_failed: 'd1_api_failed',
  invalid_ledger_statement: 'invalid_ledger_statement',
  invalid_ledger_bindings: 'invalid_ledger_bindings',
  migration_instance_verification_failed: 'migration_instance_verification_failed',
  migration_instance_revision_mismatch: 'migration_instance_revision_mismatch',
  migration_plugin_verification_failed: 'migration_plugin_verification_failed',
  no_migrations: 'no_migrations',
} as const

type Diagnostic = { code: keyof typeof messages }
  | { code: 'd1_http_status'; status: number }
  | { code: 'migration_blocked'; reason: 'multiple_organizations' | 'account_organization_mismatch' | 'required_account_field'; userIds: string[]; field?: string }
  | { code: 'migration_blocked'; reason: 'incoming_foreign_key_actions'; table: string; referencingTables: string[] }
  | { code: 'migration_history_mismatch' | 'migration_out_of_order' | 'invalid_migration_filename' | 'migration_sequence_gap_or_duplicate'; filename: unknown }

const filenameCodes = new Set(['migration_history_mismatch', 'migration_out_of_order', 'invalid_migration_filename', 'migration_sequence_gap_or_duplicate'])

// The brand and saved text cannot be forged by setting Error.name/message/prototype.
const diagnostics = new WeakMap<object, string>()
export class MigrationDiagnostic extends Error {
  constructor(diagnostic: Diagnostic) {
    let message: string
    if (diagnostic.code === 'migration_blocked') {
      message = `migration_blocked:${diagnostic.reason}:${JSON.stringify(diagnostic.reason === 'incoming_foreign_key_actions' ? { table: diagnostic.table, referencingTables: diagnostic.referencingTables } : { field: diagnostic.field, userIds: diagnostic.userIds })}`
    } else if (diagnostic.code === 'd1_http_status') {
      const status = diagnostic.status
      message = `d1_http_status${Number.isInteger(status) && status >= 100 && status <= 599 ? `:${status}` : ''}`
    } else if ('filename' in diagnostic && filenameCodes.has(diagnostic.code)) {
      const filename = diagnostic.filename
      // Filesystem paths and arbitrary ledger/API values are not safe diagnostics.
      message = diagnostic.code + (typeof filename === 'string' && /^[0-9]{4}_[a-zA-Z0-9_-]{1,200}\.sql$/.test(filename) && !filename.includes('\n') ? `:${filename}` : '')
    } else {
      message = Object.hasOwn(messages, diagnostic.code) ? messages[diagnostic.code as keyof typeof messages] : 'migration_failed'
    }
    super(message)
    diagnostics.set(this, message)
  }
}

export function internalMigrationMessage(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? diagnostics.get(error) : undefined
}
