import type { PluginMigration } from '@workbasehq/core/kernel/plugin'
import { deliveryHistorySql } from '../../../../core/src/migrations/operational-evidence'

export default { name: '003_operational_evidence', sql: deliveryHistorySql('email_outbox', 'id', "'failed'", ['email_send_failed', 'email_send_timeout']) } satisfies PluginMigration
