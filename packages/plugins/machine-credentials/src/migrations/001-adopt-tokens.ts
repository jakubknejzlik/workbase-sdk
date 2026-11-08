import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '001_adopt_tokens', sql: `
    CREATE INDEX access_tokens_live_issuer ON access_tokens(organization_id,issuer_id) WHERE revoked_at IS NULL;
  ` } satisfies PluginMigration
