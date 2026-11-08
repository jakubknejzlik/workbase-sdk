// Framework operational relay metadata.
export const opsSchema = `
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
`
