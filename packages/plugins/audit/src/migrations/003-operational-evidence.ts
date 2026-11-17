import type { PluginMigration } from '@workbasehq/core/kernel/plugin'
import { deliveryHistorySql } from '../../../../core/src/migrations/operational-evidence'

export default { name: '003_operational_evidence', sql: deliveryHistorySql('audit_outbox', 'event_id', "'failed'", ['audit_delivery_failed']) } satisfies PluginMigration
