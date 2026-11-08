import type { PluginMigration } from '@workbasehq/core/kernel/plugin'

export default { name: '001_profiles', sql: `
    CREATE TABLE identity_profiles (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id),
      first_name TEXT NOT NULL CHECK(length(trim(first_name)) BETWEEN 1 AND 200),
      last_name TEXT NOT NULL CHECK(length(trim(last_name)) BETWEEN 1 AND 200),
      synced_at TEXT,
      source_provider TEXT,
      source_issuer TEXT,
      source_subject TEXT,
      updated_at TEXT NOT NULL
    );
  ` } satisfies PluginMigration
