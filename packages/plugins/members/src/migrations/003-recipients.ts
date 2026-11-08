import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

import { pendingIndexSQL, pendingExpiryTriggerSQL } from './002-pending-invitations'

export const recipientPendingIndexSQL = pendingIndexSQL.replace('AND expired_at IS NULL', 'AND expired_at IS NULL AND declined_at IS NULL')
export const recipientExpiryTriggerSQL = pendingExpiryTriggerSQL.replace('AND expired_at IS NULL', 'AND expired_at IS NULL AND declined_at IS NULL')
/** Append-only: terminal declines free the pending slot; binding survives credential rotation. */
export const recipientInvitationMigration = `
ALTER TABLE invitations ADD COLUMN declined_at TEXT;
ALTER TABLE invitations ADD COLUMN bound_user_id TEXT;
ALTER TABLE invitations ADD COLUMN name_first TEXT;
ALTER TABLE invitations ADD COLUMN name_last TEXT;
UPDATE invitations SET bound_user_id=accepted_user_id WHERE accepted_user_id IS NOT NULL;
DROP INDEX invitations_one_pending_email;
DROP TRIGGER invitations_expire_before_insert;
${recipientPendingIndexSQL};
${recipientExpiryTriggerSQL};
`

export default { name: '003_recipients', sql: recipientInvitationMigration } satisfies PluginMigration
