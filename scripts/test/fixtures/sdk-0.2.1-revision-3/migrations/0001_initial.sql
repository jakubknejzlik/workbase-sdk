
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

CREATE TABLE _ops_relay_run (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ts TEXT NOT NULL,
  backlog INTEGER NOT NULL,
  oldest_age_seconds INTEGER,
  failed INTEGER NOT NULL,
  delivered INTEGER NOT NULL,
  webhook_delivered INTEGER NOT NULL,
  errors INTEGER NOT NULL
);
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");




CREATE TABLE email_outbox_new (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id), recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO email_outbox_new SELECT * FROM email_outbox;
DROP TABLE email_outbox;
ALTER TABLE email_outbox_new RENAME TO email_outbox;
CREATE TABLE identity_link_grants (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE UNIQUE INDEX identities_issuer_subject_idx ON identities(issuer,subject);
ALTER TABLE email_outbox ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sending','sent','failed'));
ALTER TABLE email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN sent_at TEXT;
ALTER TABLE email_outbox ADD COLUMN last_error TEXT;

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT NOT NULL, actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent')), token_id TEXT,
  definition_name TEXT NOT NULL, definition_version TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)), definition_signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_external','completed','failed','compensating','compensated','needs_attention','cancelled')),
  cancel_actor_id TEXT, resume_status TEXT, correlation_id TEXT NOT NULL, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  last_error_code TEXT, next_attempt_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(organization_id,id)
);
CREATE INDEX workflow_runs_due_idx ON workflow_runs(status,next_attempt_at,lease_until);
CREATE INDEX workflow_runs_org_idx ON workflow_runs(organization_id,created_at,id);
CREATE TABLE workflow_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id), step_id TEXT NOT NULL, position INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','executing','completed','failed','compensated')),
  attempts INTEGER NOT NULL DEFAULT 0, compensation_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER, compensation_deadline_at INTEGER,
  compensation_checkpoint_json TEXT CHECK(compensation_checkpoint_json IS NULL OR json_valid(compensation_checkpoint_json)),
  checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)), last_error_code TEXT,
  PRIMARY KEY(run_id,step_id), UNIQUE(run_id,position)
);
CREATE TABLE workflow_holds (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id), organization_id TEXT NOT NULL,
  resource_id TEXT NOT NULL, expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('held','confirmed','released'))
);
CREATE INDEX workflow_holds_expiry_idx ON workflow_holds(status,expires_at);

INSERT INTO instance_meta VALUES (1, '0.1.0', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
