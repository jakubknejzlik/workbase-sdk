import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '001_scopes', sql: `
    ALTER TABLE memberships ADD COLUMN scope_id TEXT GENERATED ALWAYS AS (organization_id) VIRTUAL NOT NULL;
    ALTER TABLE invitations ADD COLUMN scope_id TEXT GENERATED ALWAYS AS (organization_id) VIRTUAL NOT NULL;
    CREATE UNIQUE INDEX memberships_scope_user ON memberships(scope_id,user_id);
    CREATE INDEX invitations_scope_email ON invitations(scope_id,lower(email));
    INSERT OR IGNORE INTO organizations (id,name) VALUES ('instance','Instance');
  ` } satisfies PluginMigration
