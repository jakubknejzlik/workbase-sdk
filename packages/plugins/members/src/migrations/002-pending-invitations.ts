import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export const pendingIndexSQL = `CREATE UNIQUE INDEX invitations_one_pending_email ON invitations(scope_id,lower(trim(email)))
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL`
export const pendingExpiryTriggerSQL = `CREATE TRIGGER invitations_expire_before_insert BEFORE INSERT ON invitations BEGIN
  UPDATE invitations SET expired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE scope_id=NEW.organization_id AND lower(trim(email))=lower(trim(NEW.email))
      AND accepted_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL
      AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END`

/** Additive adoption: retain history; retire expired and duplicate legacy credentials. */
export const pendingInvitationMigration = `
ALTER TABLE invitations ADD COLUMN expired_at TEXT;
ALTER TABLE invitations ADD COLUMN delivery_outbox_id TEXT;
UPDATE invitations SET email=lower(trim(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
UPDATE invitations SET expired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');
UPDATE invitations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND EXISTS (
    SELECT 1 FROM invitations newer WHERE newer.scope_id=invitations.scope_id
      AND lower(trim(newer.email))=lower(trim(invitations.email))
      AND newer.accepted_at IS NULL AND newer.revoked_at IS NULL AND newer.expired_at IS NULL
      AND (coalesce(newer.created_at,'')>coalesce(invitations.created_at,'')
        OR (coalesce(newer.created_at,'')=coalesce(invitations.created_at,'') AND newer.id>invitations.id))
  );
${pendingIndexSQL};
${pendingExpiryTriggerSQL};
`

export default { name: '002_pending_invitations', sql: pendingInvitationMigration } satisfies PluginMigration
