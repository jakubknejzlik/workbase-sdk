-- workbase:migration r1 parent=none manual=none
-- workbase:begin pre-data
-- workbase:end pre-data
-- workbase:begin generated
CREATE TABLE "worker" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "name" TEXT NOT NULL,
  "user" TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, "user") REFERENCES "users"(organization_id, id)
);
CREATE INDEX "worker_org_idx" ON "worker"(organization_id, id);
CREATE INDEX "worker_user_idx" ON "worker"(organization_id, "user");
-- workbase:end generated
-- workbase:begin post-data
-- workbase:end post-data
