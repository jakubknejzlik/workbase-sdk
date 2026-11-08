import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '001_adopt_scopes', sql: `
    CREATE TABLE organization_scopes (scope_id TEXT PRIMARY KEY REFERENCES organizations(id));
    INSERT INTO organization_scopes (scope_id) SELECT id FROM organizations;
    CREATE TRIGGER organization_scope_created AFTER INSERT ON organizations BEGIN
      INSERT INTO organization_scopes (scope_id) VALUES (new.id);
    END;
  ` } satisfies PluginMigration
