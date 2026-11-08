import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '002_sender_name', sql: 'ALTER TABLE email_outbox ADD COLUMN sender_name TEXT;' } satisfies PluginMigration
