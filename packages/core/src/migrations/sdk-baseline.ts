import type { PluginMigration } from '../kernel/plugin'
import { systemSchema } from './system-schema'
import { betterAuthSchema } from './better-auth-schema'
import { emailDeliverySchema } from './email-delivery-schema'
import { workflowSchema } from '../workflow-schema'
import { opsSchema } from '../ops-schema'

export const SDK_NAMESPACE = 'workbase-sdk'
export const SDK_BASELINE = '001_system'

// SDK-owned Model B projection. Application roles are validated by the runtime,
// never baked into SDK SQL/checksums or supplied by an Instance domain migration.
const accounts = `CREATE TABLE users (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT '', salt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL, role TEXT NOT NULL, UNIQUE (organization_id, id)
);
CREATE INDEX users_org_idx ON users(organization_id, id);`

// Share the retained system definitions while the inline entry path still ships.
// No live-catalog introspection/backfill or config-dependent statements in this era.
const baseline = systemSchema
  .replace(/ CHECK ?\(role IN \('owner','dispatcher','viewer'\)\)/g, '')
  .replace(/CREATE TABLE users \([^;]+;/, accounts)
  .replace("INSERT INTO identities (user_id,provider,issuer,subject,created_at) SELECT id,'local','local',id,created_at FROM users;", '')
  .replace('user_id TEXT NOT NULL REFERENCES users(id), provider', 'user_id TEXT NOT NULL REFERENCES "user"(id), provider')
  + opsSchema + betterAuthSchema.replace('user_id TEXT NOT NULL REFERENCES users(id)', 'user_id TEXT NOT NULL REFERENCES "user"(id)')
  + emailDeliverySchema + workflowSchema

/** Append only: one immutable SQL file and receipt per SDK step, same engine as plugins. */
export function sdkMigrations(): readonly PluginMigration[] {
  return [{ name: SDK_BASELINE, sql: baseline }]
}
