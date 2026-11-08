import { workflowSchema } from '../workflow-schema'
import { opsSchema } from '../ops-schema'
import { betterAuthSchema } from './better-auth-schema'
import { emailDeliverySchema } from './email-delivery-schema'
import { CORE_VERSION, type Field, type InstanceConfig } from '../config'
export function quote(name: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
  return `"${name}"`
}
export function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  throw new Error('Unsupported SQL literal')
}
export function column(name: string, f: Field) {
  const q = quote(name)
  const type = ['int', 'bool'].includes(f.type) ? 'INTEGER' : f.type === 'float' ? 'REAL' : 'TEXT'
  return `${q} ${type}${f.required ? ' NOT NULL' : ''}${f.default !== undefined ? ` DEFAULT ${literal(f.default)}` : ''}${f.type === 'enum' ? ` CHECK (${q} IN (${f.values!.map(literal).join(', ')}))` : ''}${f.type === 'bool' ? ` CHECK (${q} IN (0,1))` : ''}${f.min !== undefined ? ` CHECK (${q} >= ${literal(f.min)})` : ''}`
}
export function createEntity(name: string, entity: InstanceConfig['entities'][string]) {
  const columns = [
    'id TEXT PRIMARY KEY', 'organization_id TEXT NOT NULL REFERENCES organizations(id)',
    'created_at TEXT NOT NULL', 'updated_at TEXT NOT NULL', 'version INTEGER NOT NULL DEFAULT 1',
    ...Object.entries(entity.fields).filter(([, f]) => !f.computed).map(([k, f]) => column(k, f)), 'UNIQUE (organization_id, id)',
    ...Object.entries(entity.fields).filter(([, f]) => f.type === 'ref' && !f.computed).map(([k, f]) => `FOREIGN KEY (organization_id, ${quote(k)}) REFERENCES ${quote(f.entity!)}(organization_id, id)`),
    ...entity.checks.map(c => `CHECK (${quote(c.left)} ${c.op} ${quote(c.right)})`),
  ]
  return `CREATE TABLE ${quote(name)} (\n  ${columns.join(',\n  ')}\n);\nCREATE INDEX ${quote(`${name}_org_idx`)} ON ${quote(name)}(organization_id, id);\n` + Object.entries(entity.fields).filter(([, f]) => f.type === 'ref' && !f.computed).map(([k]) => `CREATE INDEX ${quote(`${name}_${k}_idx`)} ON ${quote(name)}(organization_id, ${quote(k)});`).join('\n')
}
export const systemSchema = `
CREATE TABLE atomic_assert (run_id TEXT NOT NULL, rule TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL CHECK (ok = 1), policy_ok INTEGER NOT NULL DEFAULT 1 CHECK (policy_ok = 1), actor_ok INTEGER NOT NULL DEFAULT 1 CHECK (actor_ok = 1), PRIMARY KEY (run_id, step)) WITHOUT ROWID;
CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE memberships (user_id TEXT NOT NULL REFERENCES users(id), organization_id TEXT NOT NULL REFERENCES organizations(id), role TEXT NOT NULL CHECK (role IN ('owner','dispatcher','viewer')), PRIMARY KEY (user_id, organization_id));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE invitations (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','dispatcher','viewer')), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT, accepted_user_id TEXT REFERENCES users(id), inviter_id TEXT NOT NULL REFERENCES users(id));
CREATE INDEX invitations_org_idx ON invitations(organization_id);
CREATE TABLE email_outbox (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE audit_outbox (event_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL, delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE INDEX audit_outbox_pending_idx ON audit_outbox(delivered_at, created_at);
CREATE TABLE security_log (id TEXT PRIMARY KEY, organization_id TEXT, actor_id TEXT, operation TEXT NOT NULL, status INTEGER NOT NULL, correlation_id TEXT NOT NULL, occurred_at TEXT NOT NULL, requested_scope_hash TEXT);
CREATE INDEX security_log_org_idx ON security_log(organization_id, occurred_at);
CREATE TABLE idempotency_keys (organization_id TEXT NOT NULL, key TEXT NOT NULL, command TEXT NOT NULL, response_json TEXT NOT NULL, request_hash TEXT, PRIMARY KEY (organization_id, key));
CREATE TABLE webhook_deliveries (event_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT, lease_until TEXT);
CREATE INDEX webhook_pending_idx ON webhook_deliveries(state, next_attempt_at);

ALTER TABLE invitations ADD COLUMN revoked_at TEXT;
ALTER TABLE invitations ADD COLUMN created_at TEXT;
CREATE TABLE identities (
  user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, issuer TEXT NOT NULL,
  subject TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(provider, issuer, subject)
);
CREATE INDEX identities_user_idx ON identities(user_id);
INSERT INTO identities (user_id,provider,issuer,subject,created_at) SELECT id,'local','local',id,created_at FROM users;
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  issuer_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','dispatcher','viewer')),
  operations TEXT CHECK(operations IS NULL OR (json_valid(operations) AND json_type(operations)='array')),
  expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX access_tokens_org_idx ON access_tokens(organization_id);
CREATE INDEX memberships_org_role_idx ON memberships(organization_id,role);
CREATE TABLE instance_meta (revision INTEGER PRIMARY KEY, core_version TEXT NOT NULL, applied_at TEXT NOT NULL);
`
export const revisionSQL = (revision: number) => `INSERT INTO instance_meta VALUES (${revision}, '${CORE_VERSION}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));`
// Revisions are the primary key: preserve older rows and refresh only the current
// revision's SDK stamp after deploy-time migration verification succeeds.
export const coreVersionSQL = (revision: number) => `UPDATE instance_meta SET core_version = ${literal(CORE_VERSION)}, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE revision = ${literal(revision)} AND revision = (SELECT MAX(revision) FROM instance_meta) AND core_version <> ${literal(CORE_VERSION)};`
export const initialSchema = (config: InstanceConfig) => configuredSystemSchema(config) + opsSchema + (config.account?.entity === 'users' ? betterAuthSchema.replace('user_id TEXT NOT NULL REFERENCES users(id)', 'user_id TEXT NOT NULL REFERENCES "user"(id)') : betterAuthSchema) + emailDeliverySchema + workflowSchema + Object.entries(config.entities).filter(([n]) => !(n === 'users' && config.account?.entity === n)).map(([n, e]) => createEntity(n, e)).join('\n') + '\n' + revisionSQL(config.revision) + '\n'

/** Fresh schemas support configured application roles and the explicit users/account extension.
 * Existing installations keep their append-only migration chain. */
function configuredSystemSchema(config: InstanceConfig) {
  let sql = systemSchema.replace(/ CHECK ?\(role IN \('owner','dispatcher','viewer'\)\)/g, '')
  if (config.account?.entity === 'users') {
    const domain = createEntity('users', config.entities.users)
      .replace('id TEXT PRIMARY KEY,', "id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT '', salt TEXT NOT NULL DEFAULT '',")
    sql = sql.replace(/CREATE TABLE users \([^;]+;/, domain)
      .replace("INSERT INTO identities (user_id,provider,issuer,subject,created_at) SELECT id,'local','local',id,created_at FROM users;", '')
      .replace('CREATE TABLE identities (\n  user_id TEXT NOT NULL REFERENCES users(id)', 'CREATE TABLE identities (\n  user_id TEXT NOT NULL REFERENCES "user"(id)')
  }
  return sql
}
