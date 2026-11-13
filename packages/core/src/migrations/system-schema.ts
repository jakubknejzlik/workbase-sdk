// Shared immutable system definitions for the retained inline path and SDK reset baseline.
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
