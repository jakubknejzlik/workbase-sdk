import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

/** Copy rotates token_hash; delivery keeps its own selector and outbox association. */
export default { name: '005_delivery_credential', sql: `
ALTER TABLE invitations ADD COLUMN delivery_token_hash TEXT;
UPDATE invitations SET delivery_token_hash=token_hash;
` } satisfies PluginMigration
