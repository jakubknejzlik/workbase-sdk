import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '002_delivery_backoff', sql: 'ALTER TABLE audit_outbox ADD COLUMN next_attempt_at TEXT;' } satisfies PluginMigration
