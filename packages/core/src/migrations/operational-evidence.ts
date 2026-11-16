import type { PluginMigration } from '../kernel/plugin'

// Only trusted schema identifiers and fixed literals enter this builder. Histories
// belong to the existing source row; triggers make source + evidence one D1 write.
export function deliveryHistorySql(table: 'webhook_deliveries' | 'email_outbox' | 'audit_outbox', id: 'event_id' | 'id', state: string, codes: readonly string[], pendingOnInsert = true) {
  const timestamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
  const error = `CASE WHEN NEW.last_error IN (${codes.map(code => `'${code}'`).join(',')}) THEN NEW.last_error ELSE '${codes[0]}' END`
  const snapshot = (pending: boolean) => `json_object('occurred_at',${timestamp},'state',${pending ? "'pending'" : state},'error_code',${pending ? "'backlog_pending'" : error},'attempts',NEW.attempts)`
  return `ALTER TABLE ${table} ADD COLUMN operational_history TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(operational_history) AND json_type(operational_history)='array');
${pendingOnInsert ? `CREATE TRIGGER ${table}_evidence_pending AFTER INSERT ON ${table} BEGIN
  UPDATE ${table} SET operational_history=json_insert(operational_history,'$[#]',${snapshot(true)}) WHERE ${id}=NEW.${id};
END;` : ''}
CREATE TRIGGER ${table}_evidence_failure AFTER UPDATE OF last_error ON ${table}
WHEN NEW.last_error IS NOT NULL BEGIN
  UPDATE ${table} SET operational_history=json_insert(operational_history,'$[#]',${snapshot(false)}) WHERE ${id}=NEW.${id};
END;
CREATE INDEX ${table}_evidence_org ON ${table}(organization_id,${id});`
}

const webhookEvidenceSql = `ALTER TABLE webhook_deliveries ADD COLUMN created_at TEXT;
CREATE TRIGGER webhook_deliveries_created AFTER INSERT ON webhook_deliveries WHEN NEW.created_at IS NULL BEGIN
  UPDATE webhook_deliveries SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id=NEW.event_id;
END;
${deliveryHistorySql('webhook_deliveries', 'event_id', "CASE WHEN NEW.state='failed' THEN 'failed' ELSE 'pending' END", ['delivery_failed', 'delivery_interrupted'])}
`
const relayEvidenceSql = `ALTER TABLE _ops_relay_run ADD COLUMN operational_history TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(operational_history) AND json_type(operational_history)='array');
CREATE TRIGGER ops_relay_evidence_insert AFTER INSERT ON _ops_relay_run BEGIN
  UPDATE _ops_relay_run SET operational_history=json_insert(operational_history,'$[#]',json_object('occurred_at',NEW.ts,'backlog',NEW.backlog,'oldest_age_seconds',NEW.oldest_age_seconds,'failed',NEW.failed,'delivered',NEW.delivered,'webhook_delivered',NEW.webhook_delivered,'errors',NEW.errors)) WHERE id=1;
END;
CREATE TRIGGER ops_relay_evidence_update AFTER UPDATE OF ts ON _ops_relay_run BEGIN
  UPDATE _ops_relay_run SET operational_history=json_insert(operational_history,'$[#]',json_object('occurred_at',NEW.ts,'backlog',NEW.backlog,'oldest_age_seconds',NEW.oldest_age_seconds,'failed',NEW.failed,'delivered',NEW.delivered,'webhook_delivered',NEW.webhook_delivered,'errors',NEW.errors)) WHERE id=1;
END;
`

export const operationalEvidenceMigration: PluginMigration = {
  name: '002_operational_evidence', sql: `\n${webhookEvidenceSql}${relayEvidenceSql}`,
}

// Model B also accepts migration-only databases without the SDK system schema.
// Keep the static identity/receipt, but only alter source tables that exist.
export const modelBOperationalEvidenceMigration: PluginMigration = {
  ...operationalEvidenceMigration,
  async statements(db) {
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('webhook_deliveries','_ops_relay_run')").all<{ name: string }>()
    const tables = new Set(results.map(row => row.name))
    return [
      ...(tables.has('webhook_deliveries') ? [webhookEvidenceSql] : []),
      ...(tables.has('_ops_relay_run') ? [relayEvidenceSql] : []),
    ]
  },
}
