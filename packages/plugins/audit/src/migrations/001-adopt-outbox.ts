import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '001_adopt_outbox', sql: 'CREATE INDEX audit_outbox_delivery_queue ON audit_outbox(delivered_at,created_at,event_id);' } satisfies PluginMigration
