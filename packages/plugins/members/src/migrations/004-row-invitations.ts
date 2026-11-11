import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export const rowPendingIndexSQL = `CREATE UNIQUE INDEX invitations_one_pending_row ON invitations(organization_id,target_entity,target_row)
  WHERE target_entity IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND declined_at IS NULL`
export const rowExpiryTriggerSQL = `CREATE TRIGGER invitations_row_expire_before_insert BEFORE INSERT ON invitations WHEN NEW.target_entity IS NOT NULL BEGIN
  UPDATE invitations SET expired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE organization_id=NEW.organization_id AND target_entity=NEW.target_entity AND target_row=NEW.target_row
      AND accepted_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND declined_at IS NULL
      AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END`
export default { name: '004_row_invitations', sql: `
ALTER TABLE invitations ADD COLUMN target_entity TEXT;
ALTER TABLE invitations ADD COLUMN target_row TEXT;
${rowPendingIndexSQL};
${rowExpiryTriggerSQL};
` } satisfies PluginMigration
