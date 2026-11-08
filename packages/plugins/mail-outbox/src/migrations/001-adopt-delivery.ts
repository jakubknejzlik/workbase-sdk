import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '001_adopt_delivery', sql: `
      ALTER TABLE email_outbox ADD COLUMN delivery_text TEXT;
      ALTER TABLE email_outbox ADD COLUMN delivery_html TEXT;
      ALTER TABLE email_outbox ADD COLUMN expires_at TEXT;
      ALTER TABLE email_outbox ADD COLUMN lease_until TEXT;
      CREATE INDEX email_outbox_delivery_queue ON email_outbox(delivery_status,lease_until,created_at);
    ` } satisfies PluginMigration
