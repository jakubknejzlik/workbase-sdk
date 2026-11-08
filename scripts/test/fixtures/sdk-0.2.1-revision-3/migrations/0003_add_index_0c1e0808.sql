-- workbase_test: revision 2 -> 3
INSERT INTO instance_meta VALUES (3, '0.1.0', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE INDEX "rezervace_termin_idx" ON "rezervace" ("organization_id", "termin");
CREATE INDEX "zakaznik_jmeno_idx" ON "zakaznik" ("organization_id", "jmeno");
