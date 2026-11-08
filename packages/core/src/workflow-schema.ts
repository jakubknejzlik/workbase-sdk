export const workflowSchema = `
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
`
